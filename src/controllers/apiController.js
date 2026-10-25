const config = require("../config");
const path = require("node:path");
const auth = require("../utils/auth");
const { canViewMedia } = require("../utils/mediaAccess");
const fileService = require("../services/fileService");
const stateService = require("../services/stateService");
const presenceService = require("../services/presenceService");
const slideService = require("../services/slideService");

class ApiController {
  verifyAuth(req, res) {
    if (!auth.requirePinJson(req, res)) return;
    // Вхід учителя = присутність на зв'язку (автозупинка показу при виході)
    presenceService.markTeacherSeen();
    // Issue #63 (Етап 5): вхід фіксується серверною сесією (HttpOnly cookie),
    // тому після перезапуску сервера старі cookie не відновлюють доступ
    auth.issueSession(req, res, "teacher");
    res.json({ ok: true, role: "teacher" });
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
      const files = fileService.getFilesList(identity.role === "teacher");
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
    if (!auth.requireViewer(req, res)) return;
    // Issue #63 (аудит кешування): стан показу — приватні дані сесії,
    // кешувати його не можна (інакше клієнт міг би бачити застарілий стан)
    res.set("Cache-Control", "no-store");
    res.json(stateService.getState());
  }

  updateControl(req, res) {
    const { pin, ...data } = req.body || {};
    if (!auth.requirePin(req, res)) return;
    // Будь-яке успішне керування показом — вчитель на зв'язку (Issue #63)
    presenceService.markTeacherSeen();

    try {
      const result = stateService.updateState(data);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка оновлення стану");
    }
  }

  async uploadFile(req, res) {
    if (!auth.requirePin(req, res)) return;
    const originalName = req.query.name;
    if (!originalName) return res.status(400).send("Не вказано ім'я файлу");
    const description = typeof req.query.description === "string" ? req.query.description : "";
    const categoryId = typeof req.query.categoryId === "string" ? req.query.categoryId : "";

    try {
      const result = await fileService.saveFileStream(req, originalName, description, categoryId);
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
   * Учень отримує ЛИШЕ категорії, у яких є хоча б один видимий йому матеріал:
   * структура каталогу прихованих матеріалів (порожні або «прихований»
   * вміст) йому не розкривається.
   * Створення, видалення та зміна складу категорій, як і раніше, потребують
   * PIN (див. createCategory/...).
   */
  getCategories(req, res) {
    const identity = auth.catalogIdentity(req);
    if (!identity) {
      return res.status(403).send("Категорії недоступні — увійдіть на портал");
    }
    res.set("Cache-Control", "no-store");
    const categories = fileService.getCategories();
    if (identity.role === "teacher") return res.json(categories);
    const visibleCategoryIds = new Set(
      fileService.getFilesList(false).map(file => file.categoryId)
    );
    res.json(categories.filter(category => visibleCategoryIds.has(category.id)));
  }

  createCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const category = fileService.createCategory(req.body && req.body.name);
      res.status(201).json({ ok: true, category });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося створити категорію");
    }
  }

  deleteCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const result = fileService.deleteCategory(req.body && req.body.categoryId);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося видалити категорію");
    }
  }

  renameCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const body = req.body || {};
      res.json(fileService.renameCategory(body.categoryId, body.name));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати категорію");
    }
  }

  reorderCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const body = req.body || {};
      res.json(fileService.reorderCategory(body.categoryId, body.direction));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося змінити порядок категорій");
    }
  }

  renameFile(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const body = req.body || {};
      res.json(fileService.renameFile(body.file, body.name));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати матеріал");
    }
  }

  setFileCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const body = req.body || {};
      res.json(fileService.moveFileToCategory(body.file, body.categoryId));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перемістити матеріал");
    }
  }

  reorderFile(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const body = req.body || {};
      res.json(fileService.reorderFile(body.file, body.direction));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося змінити порядок");
    }
  }
  toggleHide(req, res) {
    const { pin, file, hidden } = req.body || {};
    if (!auth.requirePin(req, res)) return;

    try {
      const result = fileService.toggleHide(file, Boolean(hidden));
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
    const { pin, file } = req.body || {};
    if (!auth.requirePin(req, res)) return;

    try {
      const result = fileService.deleteFile(file);
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
    if (!auth.requirePin(req, res)) return;
    const { file } = req.body || {};
    if (!file) return res.status(400).send("Не вказано file");
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
    if (!canViewMedia(file, isTeacher)) {
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
