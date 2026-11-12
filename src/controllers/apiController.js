const config = require("../config");
const path = require("node:path");
const auth = require("../utils/auth");
const { canViewMedia } = require("../utils/mediaAccess");
const fileService = require("../services/fileService");
const stateService = require("../services/stateService");
const signalService = require("../services/signalService");
// Issue #83: стан тестування для конкретного запитувача (state.testing)
const testingService = require("../services/testingService");
const slideService = require("../services/slideService");
// Issue #85: перевірка персонального PIN викладача при вході
const pinLimiter = require("../utils/pinLimiter");
const teacherService = require("../services/teacherService");

/** Отримати teacherId з чинної серверної сесії (не з тіла/заголовка запиту) */
function teacherIdFromSession(req) {
  const session = auth.readSession(req);
  if (!session || session.role !== "teacher") return null;
  return session.teacherId || null;
}

/**
 * Issue #88 (рев'ю): авторизація операцій старих маршрутів, які ЗМІНЮЮТЬ стан
 * матеріалів або створюють слайди (/api/files/{rename,category,reorder,
 * toggle-hide,delete}, /api/upload, /api/slides/prepare).
 *
 * Спочатку PIN-дозвіл (чинна модель Issue #63: cookie сама по собі не
 * авторизує POST-операції), далі — актор із ЧИННОЇ серверної сесії:
 *  - адмін-PIN → { isAdmin: true, teacherId: null } — повний доступ;
 *  - персональний PIN викладача → teacherId ЛИШЕ з сесії. Без сесії — 401:
 *    раніше такий запит трактувався як адмін-доступ (teacherIdFromSession
 *    повертав null), що дозволяло обхід через персональний PIN без cookie.
 *
 * У разі помилки сам надсилає відповідь і повертає null.
 */
function materialsActor(req, res) {
  const perm = auth.requirePerm(req, res, "materials");
  if (!perm) return null;
  if (perm.access === "admin") return { isAdmin: true, teacherId: null };
  const session = auth.readSession(req);
  const teacherId = session && session.role === "teacher" ? (session.teacherId || "") : "";
  if (!teacherId) {
    res.status(401).send("Сесію не знайдено — увійдіть заново");
    return null;
  }
  return { isAdmin: false, teacherId };
}

/**
 * Issue #88 (рев'ю): доступ до конкретного файла для операцій, що змінюють
 * його стан або створюють слайди. Адмін — до будь-якого; викладач — лише до
 * власного: спільні/legacy-файли (owner === null) і чужі файли йому для
 * змін стану недоступні (копіювання — окремий маршрут /api/materials/copy).
 * Запис, що не існує, не блокується тут — далі сервіс сам відповість 404.
 */
function ensureFileEditable(res, actor, fileId) {
  if (actor.isAdmin) return true;
  const record = fileService.getFileRecord(fileId);
  if (!record) return true;
  if (record.owner && record.owner === actor.teacherId) return true;
  if (!record.owner) {
    res.status(403).send("Файл належить спільній бібліотеці — зміни заборонені");
    return false;
  }
  res.status(403).send("Файл належить іншому викладачу");
  return false;
}

/**
 * Issue #63 (доробка §2): безпечний набір полів категорії.
 * У відповідь віддаються ЛИШЕ id/name/order/createdAt — ніяких даних про
 * матеріали (приховані чи опубліковані), їх кількості чи складу.
 */
function safeCategory(category) {
  return {
    id: category.id,
    name: category.name,
    order: category.order || 0,
    createdAt: category.createdAt
  };
}

class ApiController {
  /**
   * POST /api/auth/verify { pin } — вхід на портал (Issue #85).
   *
   * Один формат входу для двох типів облікових даних:
   *  - адміністративний PORTAL_PIN → сесія з access "admin" (повний доступ,
   *    зокрема розділ «Викладачі»); відповідь містить admin: true;
   *  - персональний PIN викладача → система сама визначає обліковий запис,
   *    повертає його ідентифікатор і ПІБ (без PIN/хеша), сесія access "teacher".
   * Невірний PIN → 403 з лічильником спроб (IP-лімітатор); PIN неактивного
   * викладача → 403; заблокований обліковий запис → 429.
   * PIN у відповідь не повертається ніколи.
   */
  verifyAuth(req, res) {
    const pin = auth.extractPin(req);
    const key = auth.clientKey(req);

    if (pinLimiter.isBlocked(key)) {
      return res.status(429).json({ ok: false, message: "Забагато спроб введення PIN. Спробуйте пізніше." });
    }
    if (!pin) {
      pinLimiter.registerFailure(key);
      return res.status(403).json({ ok: false, message: "Невірний PIN викладача" });
    }

    // 1) Адміністративний PIN (PORTAL_PIN) — як і раніше, головний механізм
    if (auth.safeEqual(pin, config.portalPin)) {
      pinLimiter.reset(key);
      auth.issueSession(req, res, "teacher", "", { access: "admin" });
      return res.json({ ok: true, role: "teacher", admin: true });
    }

    // 2) Персональний PIN викладача — запис визначається сам сервером
    let outcome;
    try {
      outcome = teacherService.login(pin);
    } catch (error) {
      return res.status(500).json({ ok: false, message: "Не вдалося перевірити облікові записи: " + error.message });
    }
    if (outcome.error === "locked") {
      return res.status(429).json({ ok: false, message: "Забагато спроб введення PIN. Спробуйте пізніше." });
    }
    if (outcome.error === "notfound") {
      pinLimiter.registerFailure(key);
      return res.status(403).json({ ok: false, message: "Невірний PIN викладача" });
    }

    pinLimiter.reset(key);
    const teacher = outcome.teacher;
    auth.issueSession(req, res, "teacher", "", {
      access: "teacher",
      teacherId: teacher.id,
      fullName: teacher.fullName
    });
    // Ідентифікатор облікового запису клієнт надсилає далі разом із PIN
    // (X-Portal-Teacher), щоб операції керування зараховувалися за цим записом
    res.json({ ok: true, role: "teacher", teacherId: teacher.id, fullName: teacher.fullName });
  }

  /**
   * POST /api/auth/session { name } — вхід учня (Issue #63, Етап 5).
   *
   * Сесія потрібна, щоб стан демонстрації та медіа показу отримували лише
   * учасники порталу: старі сесії після перезапуску сервера відхиляються
   * (401), і учень проходить вхід заново. PIN не потрібен — учень лише
   * вказує показне ім'я; права керування сесія не дає.
   */
  createStudentSession(req, res) {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
    const session = auth.issueSession(req, res, "student", name);
    res.json({ ok: true, role: "student", session: session.id.length > 0 });
  }

  /**
   * POST /api/auth/logout — скасування сесії (виходь із ролі викладача або
   * учня). Сесію знищено на СЕРВЕРІ, тому повторне використання старої cookie
   * (її копії) вже не дає доступу; клієнту додатково очищається cookie.
   * Ендпоінт навмисно не вимагає PIN: він лише прибирає доступ самого клієнта.
   */
  logoutMedia(req, res) {
    auth.clearSession(req, res);
    // Issue #88 §4: забороняємо кешування сторінок після виходу, щоб
    // back/reload не відкривав захищений вміст.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json({ ok: true });
  }

  /**
   * GET /api/files — каталог матеріалів.
   * Issue #63 (аудит endpoint-ів, доробка): викладач (PIN або його сесія)
   * отримує ПОВНИЙ каталог (приховані, порядок, стани конвертації); учасник із
   * чинною сесією — лише ОПУБЛІКОВАНІ та готові матеріали (фільтрація в
   * fileService.getFilesList(false), без поля order і conversionStatus).
   * Приховані матеріали не потрапляють у відповідь учню ніколи, навіть коли
   * їх саме демонструють. Без входу — 403 без запису в лімітатор.
   */
  getFiles(req, res) {
    const identity = auth.catalogIdentity(req);
    if (!identity) {
      return res.status(403).send("Каталог недоступний — увійдіть на портал");
    }
    res.set("Cache-Control", "no-store");
    try {
      const teacherId = teacherIdFromSession(req);
      const files = fileService.getFilesList(identity.role === "teacher", teacherId);
      res.json(files);
    } catch (error) {
      res.status(500).send("Не вдалося отримати список файлів: " + error.message);
    }
  }

  /**
   * GET /api/state — стан активної демонстрації (лише для входилих).
   * Issue #63 (Етап 5): потрібна чинна сесія (учень/викладач) або PIN;
   * без входу — 401, після перезапуску сервера старі сесії теж дають 401.
   */
  getState(req, res) {
    const identity = auth.requireViewer(req, res);
    if (!identity) return;
    // Issue #63 (аудит кешування): стан показу — приватні дані сесії,
    // кешувати його не можна (інакше клієнт міг би бачити застарілий стан)
    res.set("Cache-Control", "no-store");
    const state = stateService.getState();
    // Issue #79: активні сигнали — ПЕРСОНАЛЬНА частина стану, яка обчислюється
    // для конкретного запитувача. Учневі віддаються лише групові та
    // адресовані йому записи (індивідуальний сигнал не потрапляє в спільний
    // стан інших учнів; ціль береться з прив'язки сесії в heartbeat, а не з
    // запиту), викладачу — усі (для активних станів іконок у списку учнів).
    state.signals = signalService.getVisibleTo(identity);
    // Issue #83: тестування — теж персональна частина стану: викладач бачить
    // гістограму й відповіді учнів, учень — лише свій поточний вибір. Опитування
    // те саме (/api/state, ~0.5 с), тому результати оновлюються в реальному
    // часі без перезавантаження сторінки й без окремого каналу подій.
    state.testing = testingService.getView(identity, state);
    res.json(state);
  }

  updateControl(req, res) {
    const { pin, ...data } = req.body || {};
    // Issue #85: керування показом належить дозволу demo
    if (!auth.requirePerm(req, res, "demo")) return;

    try {
      const result = stateService.updateState(data);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка оновлення стану");
    }
  }

  async uploadFile(req, res) {
    // Issue #85: робота з матеріалами належить дозволу materials;
    // Issue #88 (рев'ю): актор із сесії — викладач створює файл лише у власному
    // просторі, без сесії (персональний PIN без cookie) — 401, не адмін-доступ.
    const actor = materialsActor(req, res);
    if (!actor) return;
    const originalName = req.query.name;
    if (!originalName) return res.status(400).send("Не вказано ім'я файлу");
    const description = typeof req.query.description === "string" ? req.query.description : "";
    const categoryId = typeof req.query.categoryId === "string" ? req.query.categoryId : "";
    const folderId = typeof req.query.folderId === "string" ? req.query.folderId : "";
    const teacherId = actor.teacherId;

    try {
      const result = await fileService.saveFileStream(req, originalName, description, categoryId, teacherId || null, folderId || null);
      const ext = path.extname(result.id).toLowerCase();
      let conversionStatus = "not-required";
      if (config.slideExtensions.has(ext)) {
        conversionStatus = "converting";
        fileService.setConversionStatus(result.id, conversionStatus);
        // Запускаємо у фоні, як у попередньому етапі; стан ready виставляємо
        // лише після перевірки всіх PNG. Помилка зберігається в метаданих.
        void slideService.ensureSlides(result.id)
          .then(manifest => {
            if (!manifest || !Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) {
              throw new Error("Сервер не підтвердив готовність PNG-слайдів");
            }
            fileService.setConversionStatus(result.id, "ready");
          })
          .catch(error => {
            const conversionError = error.message || "Помилка конвертації";
            fileService.setConversionStatus(result.id, "failed", conversionError);
            console.error("Конвертація слайдів (" + result.id + "):", conversionError);
          });
      }

      // Оригінал зберігається. Учні побачать документ лише після ready.
      res.status(201).json({
        ok: true, id: result.id, name: result.name, size: result.size,
        description: result.description, conversionStatus, conversionError: ""
      });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка завантаження");
    }
  }
  /**
   * GET /api/categories
   * Issue #63 (аудит endpoint-ів, доробка): читання для викладача (PIN або
   * сесія) і для учасника з чинною сесією; без входу — 403. Відповідь містить
   * лише id/name/order/createdAt — жодних даних про матеріали.
   * Issue #63 (доробка §2): обидві ролі отримують ПЕРЕЛІК УСІХ створених
   * категорій, включно з порожніми та з категоріями, де лише приховані
   * матеріали: структура каталогу однакова для всіх, а про наявність і
   * видимість матеріалів свідчить тільки /api/files (для учня — лише
   * опубліковані та готові). Назви, метадані чи кількість прихованих
   * матеріалів через категорії не розкриваються.
   * Створення, видалення та зміна складу категорій, як і раніше, потребують
   * PIN (див. createCategory/...).
   */
  getCategories(req, res) {
    const identity = auth.catalogIdentity(req);
    if (!identity) {
      return res.status(403).send("Категорії недоступні — увійдіть на портал");
    }
    res.set("Cache-Control", "no-store");
    // Issue #63 (доробка §2): учень бачить УСІ створені категорії — порожні,
    // з опублікованими та з прихованими матеріалами. Раніше категорії без
    // видимого йому матеріалу приховувалися, і структура каталогу залежала від
    // поточної видимості; тепер перелік категорій однаковий для всіх ролей,
    // а видимість матеріалів усередині визначає лише /api/files (для учня —
    // тільки опубліковані та готові). Повертаються виключно безпечні поля.
    res.json(fileService.getCategories().map(safeCategory));
  }

  createCategory(req, res) {
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const category = fileService.createCategory(req.body && req.body.name);
      // Issue #63 (доробка §2): ревізія стану зростає — клієнти учнів
      // перечитують /api/categories на черговому опитуванні, тобто нова
      // категорія з'являється в них без перезавантаження сторінки
      stateService.touch();
      res.status(201).json({ ok: true, category });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося створити категорію");
    }
  }

  deleteCategory(req, res) {
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const result = fileService.deleteCategory(req.body && req.body.categoryId);
      // Issue #63 (доробка §2): ревізія стану — клієнти учнів перечитують
      // перелік категорій без перезавантаження сторінки
      stateService.touch();
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося видалити категорію");
    }
  }

  renameCategory(req, res) {
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const body = req.body || {};
      const result = fileService.renameCategory(body.categoryId, body.name);
      stateService.touch(); // Issue #63 (доробка §2): нова назва в учнів без перезавантаження
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати категорію");
    }
  }

  reorderCategory(req, res) {
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const body = req.body || {};
      const result = fileService.reorderCategory(body.categoryId, body.direction);
      stateService.touch(); // Issue #63 (доробка §2): новий порядок в учнів без перезавантаження
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося змінити порядок категорій");
    }
  }

  renameFile(req, res) {
    const actor = materialsActor(req, res);
    if (!actor) return;
    const teacherId = actor.teacherId;
    try {
      const body = req.body || {};
      res.json(fileService.renameFile(teacherId, body.file, body.name));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати матеріал");
    }
  }

  setFileCategory(req, res) {
    const actor = materialsActor(req, res);
    if (!actor) return;
    const teacherId = actor.teacherId;
    try {
      const body = req.body || {};
      const result = fileService.moveFileToCategory(teacherId, body.file, body.categoryId);
      // Issue #63 (доробка §2): склад категорій змінився — групування каталогу
      // в учнів оновлюється на наступному опитуванні стану
      stateService.touch();
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перемістити матеріал");
    }
  }

  reorderFile(req, res) {
    const actor = materialsActor(req, res);
    if (!actor) return;
    const teacherId = actor.teacherId;
    try {
      const body = req.body || {};
      res.json(fileService.reorderFile(teacherId, body.file, body.direction));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося змінити порядок");
    }
  }
  toggleHide(req, res) {
    const actor = materialsActor(req, res);
    if (!actor) return;
    const teacherId = actor.teacherId;
    const { file, hidden } = req.body || {};
    try {
      const result = fileService.toggleHide(teacherId, file, Boolean(hidden));
      // Issue #63 (Етап 4): ревізія /api/state зростає — усі учнівські клієнти
      // на черговому опитуванні перечитують каталог і бачать прихований матеріал
      // зниклим (а опублікований — знову доступним) без перезавантаження
      stateService.touch();
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка зміни видимості");
    }
  }

  deleteFile(req, res) {
    const actor = materialsActor(req, res);
    if (!actor) return;
    const teacherId = actor.teacherId;
    const { file } = req.body || {};
    try {
      const result = fileService.deleteFile(teacherId, file);
      stateService.resetIfFileMatches(file);
      // Also delete cached slides
      slideService.clearSlides(file);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка видалення файлу");
    }
  }

  /**
   * POST /api/slides/prepare  { file }
   * Trigger server-side conversion and return manifest.
   * The conversion is async — client may need to poll if it takes time.
   */
  async prepareSlides(req, res) {
    const actor = materialsActor(req, res);
    if (!actor) return;
    const { file } = req.body || {};
    if (!file) return res.status(400).send("Не вказано file");
    // Issue #88 (рев'ю): перевірка власника ПЕРЕД setConversionStatus/ensureSlides —
    // викладач готує лише власні файли; чужі та спільні/legacy (owner === null)
    // залишаються незмінними (копіювання з конвертацією — /api/materials/copy).
    if (!ensureFileEditable(res, actor, file)) return;
    try {
      fileService.setConversionStatus(file, "converting");
      const manifest = await slideService.ensureSlides(file);
      if (!manifest || !Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) {
        throw new Error("Сервер не підтвердив готовність PNG-слайдів");
      }
      fileService.setConversionStatus(file, "ready");
      res.json(manifest);
    } catch (error) {
      fileService.setConversionStatus(file, "failed", error.message || "Помилка конвертації");
      res.status(error.status || 500).send(error.message || "Помилка конвертації");
    }
  }
  /**
   * GET /api/slides/info?file=<name>
   * Returns cached manifest (pageCount) without conversion.
   *
   * Issue #63 (Етап 5): без чинної сесії або PIN відповідь — 401; для учня
   * файл не існує поза активною демонстрацією (опублікований — навпаки,
   * доступний для самостійного перегляду, див. mediaAccess).
   *
   * Issue #63 (відгук рев'ю): публічна відповідь для учня містить лише факт
   * готовності/помилки/конвертації — без conversionError, локальних шляхів,
   * stdout/stderr, stack trace чи команд. Діагностика помилки конвертації
   * доступна лише викладачу з PIN (захищений діагностичний шлях); повні
   * подробиці також пишуться у приватний серверний лог (console.error).
   * Приховані файли для учня не існують (навіть за відомим id, як і у /slides),
   * окримо матеріалу, який викладач демонструє зараз (див. mediaAccess).
   */
  getSlideInfo(req, res) {
    const { file } = req.query;
    if (!file) return res.status(400).send("Не вказано file");
    const identity = auth.mediaIdentity(req, res);
    if (!identity) return;
    // Issue #63 (аудит кешування): відповідь про приватний ресурс не кешується
    res.set("Cache-Control", "no-store");
    const isTeacher = identity.isTeacher;
    if (!canViewMedia(file, isTeacher, identity.teacherId, identity.isAdmin)) {
      return res.status(404).json({ ready: false });
    }
    const manifest = slideService.getManifest(file);
    if (!manifest) {
      const metadata = fileService.getMetadata();
      const info = metadata.files && metadata.files[file];
      if (info && info.conversionStatus === "failed") {
        if (isTeacher) {
          return res.json({ ready: false, failed: true, error: info.conversionError || "Помилка конвертації" });
        }
        return res.json({ ready: false, failed: true });
      }
      if (info && info.conversionStatus === "converting") return res.json({ ready: false, converting: true });
      return res.status(404).json({ ready: false });
    }
    if (manifest.converting) return res.json({ ready: false, converting: true });
    if (!Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) {
      return res.status(500).json({
        ready: false,
        failed: true,
        ...(isTeacher ? { error: "Некоректний маніфест PNG-слайдів" } : {})
      });
    }
    // Учню — лише те, що потрібно для показу; source/generatedAt (внутрішні
    // подробиці реалізації конвертації) — лише викладачу
    if (!isTeacher) return res.json({ ready: true, pageCount: manifest.pageCount });
    res.json({ ready: true, ...manifest });
  }
}

module.exports = new ApiController();
