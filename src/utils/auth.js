/**
 * auth.js — перевірка PIN-коду викладача та серверних сесій входу.
 *
 * - Порівняння через crypto.timingSafeEqual (стійке до timing-атак);
 * - Ліміт спроб (див. pinLimiter.js);
 * - extractPin шукає PIN лише у заголовку X-Portal-Pin і в тілі запиту
 *   (JSON або form-data); query-параметр `?pin=` НЕ приймається, щоб PIN не
 *   потрапляв в адресний рядок, історію браузера, Referer і журнали запитів
 *   (Issue #63, аудит PIN);
 * - Issue #63 (Етап 5): вхід обох ролей фіксується серверною сесією
 *   (sessionService) і передається HttpOnly cookie `ly_session`. Сесії
 *   зберігаються лише в пам'яті процесу, тому ПЕРЕРЕЗАПУСК сервера скасовує
 *   всі попередні входи: старі cookie відхиляються, допустимий лише новий
 *   вхід (POST /api/auth/verify для вчителя, POST /api/auth/session для учня).
 * - Cookie містить випадковий id сесії, а НЕ PIN: її витік не розкриває PIN
 *   і не дає прав на POST /api/* (вони вимагають справжній PIN у заголовку/тілі).
 */

const crypto = require("node:crypto");
const config = require("../config");
const pinLimiter = require("./pinLimiter");
// Issue #85: лімітатори спроб за обліковим записом (ключ — teacherId) і за
// захищеним відбитком PIN (до ідентифікації облікового запису)
const { accountLimiter, pinAttemptLimiter, pinFingerprint } = require("./pinLimiter");
const sessionService = require("../services/sessionService");
// Issue #85: персональні облікові записи викладачів (PIN → хеш → права)
const teacherService = require("../services/teacherService");

/** Ім'я HttpOnly cookie сесії входу (викладач або учень) */
const SESSION_COOKIE = "ly_session";
/** Життя cookie — один робочий день (учбовий сеанс); те саме й у sessionService */
const SESSION_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

/** Порівняння рядків постійного часу (через хеші однакової довжини) */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a ?? ""), sha256(b ?? ""));
}

/**
 * Отримання PIN з запиту: заголовок X-Portal-Pin > тіло (JSON/form-data).
 *
 * Issue #63 (аудит PIN): query-параметр `?pin=` свідомо НЕ читається.
 * Запити з PIN у URL потрапляють у журнал сервера, історію браузера, заголовок
 * Referer при переході на зовнішній ресурс і в адресний рядок, який можна
 * скопіювати/передати учням. Жоден клієнтський код PIN у URL не додає: медіа
 * авторизується HttpOnly cookie сесії, API — заголовком X-Portal-Pin або
 * полем `pin` у тілі, тому можливість сумісності з `?pin=` не потрібна.
 */
function extractPin(req) {
  if (req.headers && req.headers["x-portal-pin"] !== undefined) {
    return String(req.headers["x-portal-pin"]);
  }
  if (req.body && req.body.pin !== undefined) {
    return String(req.body.pin);
  }
  return "";
}

/**
 * Issue #85: ідентифікатор облікового запису викладача.
 *
 * Клієнт надсилає його разом із персональним PIN (заголовок X-Portal-Teacher
 * або поле `teacherId` в тілі запиту). Це дозволяє серверу зараховувати невдалі
 * спроби саме за обліковим записом (додатковий до IP ліміт спроб) і не
 * плутати персональний PIN викладача з адміністративним PORTAL_PIN.
 */
function extractTeacherId(req) {
  const header = req.headers && req.headers["x-portal-teacher"];
  if (header !== undefined && header !== null && String(header) !== "") {
    return String(header).slice(0, 64);
  }
  if (req.body && req.body.teacherId) return String(req.body.teacherId).slice(0, 64);
  return "";
}

/** Простий парсер Cookie-заголовка (без залежностей від cookie-parser) */
function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch { /* значення без кодування — лишаємо як є */ }
    out[key] = value;
  }
  return out;
}

/** Чинна серверна сесія цього запиту (null — входу немає або він застарів) */
function readSession(req) {
  return sessionService.get(parseCookies(req)[SESSION_COOKIE]);
}

/**
 * Issue #63 (Етап 5): видача HttpOnly cookie сесії.
 * Повторний вхід тієї самої ролі ПЕРЕВИКОРИСТОВУЄ наявну сесію (сторінку
 * викладача перезавантажують часто), а зміна ролі скасовує попередню.
 *
 * Issue #85: `meta` несе контекст доступу — access ("admin"|"teacher"|"student"),
 * teacherId (персональний обліковий запис) і ПІБ. Сесія адміністратора і викладача
 * має role "teacher" (чинна логіка клієнта), але різний access. Перевертаємо
 * сесію, якщо змінився сам обліковий запис (інакше вхід іншого викладача
 * перевикористав би чужу cookie).
 */
function issueSession(req, res, role, name = "", meta = {}) {
  const access = meta.access || role;
  const teacherId = meta.teacherId || "";
  const existing = readSession(req);
  const reusable =
    existing &&
    existing.role === role &&
    (existing.access || existing.role) === access &&
    (existing.teacherId || "") === teacherId &&
    (!name || existing.name === name);
  if (reusable) {
    res.cookie(SESSION_COOKIE, existing.id, sessionCookieOptions(req));
    return existing;
  }
  if (existing) sessionService.destroy(existing.id);
  const session = sessionService.create(role, name, { access, teacherId, fullName: meta.fullName || "" });
  res.cookie(SESSION_COOKIE, session.id, sessionCookieOptions(req));
  return session;
}

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    secure: Boolean(req.secure)
  };
}

/** Скасування сесії на сервері та очищення cookie клієнта (вихід із ролі) */
function clearSession(req, res) {
  const existing = readSession(req);
  if (existing) sessionService.destroy(existing.id);
  // Issue #88 (рев'ю): cookie знімаємо з ТИМИ САМИМИ атрибутами, що й видача
  // (httpOnly/sameSite/path/secure), — інакше браузер не видалить пару cookie/path,
  // і клієнт після виходу лишається з відпрацьованою cookie. maxAge прибираємо:
  // для очищення Express ставить Expires у минуле сам.
  const options = sessionCookieOptions(req);
  delete options.maxAge;
  res.clearCookie(SESSION_COOKIE, options);
}

/**
 * Issue #63 (аудит endpoint-ів): ІДЕНТИЧНІСТЬ читача каталогу
 * (/api/files, /api/categories).
 *
 * - викладач (PIN у запиті або чинна сесія викладача) → { role: "teacher" }
 *   і повний каталог, включно з прихованими матеріалами та станом конвертації;
 * - учасник із чинною сесією → { role: session.role } і лише опубліковані
 *   матеріали (сесію викладача неможливо отримати без PIN, сесія учня — без
 *   вказання показного імені);
 * - без входу → null; відповідає сам викликав (403). Відсутність PIN не
 *   зараховується як спроба введення, тому анонімні GET не вичерпують
 *   лімітатор і не блокують роботу вчителя з того самого IP.
 */
function catalogIdentity(req) {
  if (extractPin(req) && isTeacher(req)) return { role: "teacher" };
  const session = readSession(req);
  if (session) return { role: session.role };
  return null;
}

/**
 * Вимога наявної сесії для контентних endpoint-ів (/api/state, heartbeat).
 * У разі відсутності сам надсилає 401 і повертає null.
 * PIN викладача у запиті приймається як альтернатива сесії (власні
 * інструменти вчителя можуть працювати без cookie).
 */
function requireViewer(req, res) {
  if (extractPin(req) && isTeacher(req)) return { pin: true };
  const session = readSession(req);
  if (session) return session;
  res.status(401).send("Сесію не знайдено — увійдіть заново");
  return null;
}

/**
 * Ідентичність для МЕДІАЗАПИТІВ (/files, /slides, /api/slides/info):
 * викладач (PIN або teacher-сесія) або учасник із чинною сесією.
 * Без входу — 401; далі право на конкретний файл вирішує mediaAccess.
 */
function mediaIdentity(req, res) {
  const session = readSession(req);
  if (extractPin(req) && isTeacher(req)) {
    return { isTeacher: true, teacherId: session ? session.teacherId : null };
  }
  if (session) return { isTeacher: session.role === "teacher", session, teacherId: session.role === "teacher" ? session.teacherId : null };
  res.status(401).send("Сесію не знайдено — увійдіть заново");
  return null;
}

// Issue #75: єдине серверне читання клієнтської IP — адреса TCP-підключення
// (req.ip без trust proxy не враховує proxy-заголовки; конфігурації проксі у
// проєкті немає, тому довіра до X-Forwarded-* не змінюється). Використовується
// і для лімітатора PIN, і для IP-адреси у списку учнів.
function clientKey(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Issue #85: спільна перевірка PIN-запиту (адміністративний або персональний).
 *
 * Порядок:
 *  1. PIN відсутній → { error: "empty" } (сам викликав вирішує, чи рахувати);
 *  2. IP заблоковано лімітатором → { error: "ip-blocked" };
 *  3. PIN збігається з PORTAL_PIN → { ok, access: "admin" } (повні права);
 *  4. є ідентифікатор облікового запису → перевірка САМЕ цього запису:
 *     - обліковий запис заблоковано лімітатором спроб → { error: "account-blocked" };
 *     - запис не існує → { error: "wrong" } (+ спроба зараховується за IP і відбиток PIN);
 *     - невірний PIN → { error: "wrong" } (+ IP, відбиток PIN і обліковий запис);
 *     - правильний PIN, але запис неактивний/архівований → { error: "inactive" }
 *       (спроба НЕ зараховується: PIN уже відомий власникові);
 *     - чинний запис → { ok, access: "teacher", teacher: record };
 *  5. PIN не адміністративний і ідентифікатора немає → { error: "wrong" }
 *     (невдалий перебір за персональним PIN атрибутувати неможливо — PIN і є
 *     ідентифікатором, тому його лімітує IP-лімітатор і лімітер відбитка PIN).
 *
 * Лічильник спроб за обліковим записом ведеться тут (accountLimiter), щоб
 * атрибуція була в одному місці; скидання — після кожної успішної перевірки.
 * Лімітер відбитка PIN (pinAttemptLimiter) ведеться за захищеним HMAC-відбитком
 * введеного PIN — діє до ідентифікації облікового запису і не дозволяє
 * безмежного перебору 4-значних PIN.
 */
function evaluatePin(req) {
  const pin = extractPin(req);
  const key = clientKey(req);
  const fingerprint = pinFingerprint(pin);

  if (!pin) return { error: "empty" };
  if (pinLimiter.isBlocked(key)) return { error: "ip-blocked" };
  if (pinAttemptLimiter.isBlocked(fingerprint)) return { error: "pin-blocked" };

  if (safeEqual(pin, config.portalPin)) {
    pinLimiter.reset(key);
    pinAttemptLimiter.reset(fingerprint);
    return { ok: true, access: "admin" };
  }

  const teacherId = extractTeacherId(req);
  if (!teacherId) {
    pinLimiter.registerFailure(key);
    pinAttemptLimiter.registerFailure(fingerprint);
    return { error: "wrong" };
  }

  const outcome = teacherService.verifyFor(teacherId, pin);
  if (outcome.error === "locked") return { error: "account-blocked" };
  if (outcome.error === "notfound") {
    pinLimiter.registerFailure(key);
    pinAttemptLimiter.registerFailure(fingerprint);
    return { error: "wrong" };
  }
  if (outcome.error === "wrong") {
    pinLimiter.registerFailure(key);
    accountLimiter.registerFailure(teacherId);
    return { error: "wrong" };
  }
  if (outcome.error === "inactive") return { error: "inactive" };

  // Успішна перевірка викладача — скидаємо лічильники (verifyFor вже скинув
  // accountLimiter та pinAttemptLimiter; тут — для надійності разом з IP)
  pinLimiter.reset(key);
  accountLimiter.reset(teacherId);
  return { ok: true, access: "teacher", teacher: outcome.teacher };
}

/**
 * Мовчазна перевірка ролі «викладач» (для розділених ресурсів: список файлів,
 * стрімінг, слайди). Невдалий PIN з урахуванням ліміту спроб зараховується,
 * але відповідь не змінюється — для клієнта це просто «не викладач».
 * Відсутність PIN не зараховується як спроба (інакше анонімні GET-запити
 * вичерпували б лімітатор і блокували роботу вчителя з того самого IP).
 *
 * Issue #85: працює і з адміністративним PIN (PORTAL_PIN), і з персональним
 * PIN викладача (із заголовком X-Portal-Teacher).
 */
function isTeacher(req) {
  const pin = extractPin(req);
  if (!pin) return false;
  return Boolean(evaluatePin(req).ok);
}

/**
 * Issue #85: перевірка права `perm` ("demo"|"materials") для операцій керування.
 *
 * Сесія НЕ авторизує ці операції (збережено чинний захист Issue #63: cookie не
 * дає права на POST /api/*) — потрібен PIN у запиті:
 *  - адміністративний PORTAL_PIN → повні права, без обмеження дозволів;
 *  - персональний PIN викладача (X-Portal-Pin + X-Portal-Teacher) → лише ті
 *    дозволи, які надано обліковому запису (перевіряються на сервері щоразу,
 *    тому відкликання дозволу діє негайно).
 * У разі помилки сам надсилає відповідь і повертає null.
 */
function requirePerm(req, res, perm) {
  const result = evaluatePin(req);

  if (result.error === "ip-blocked") {
    res.status(429).send("Забагато спроб введення PIN. Спробуйте пізніше.");
    return null;
  }
  if (result.error === "pin-blocked") {
    res.status(429).send("Забагато спроб введення PIN. Спробуйте пізніше.");
    return null;
  }
  if (result.error === "account-blocked") {
    res.status(429).send("Забагато спроб введення PIN для облікового запису. Спробуйте пізніше.");
    return null;
  }
  if (result.error === "empty" || result.error === "wrong") {
    res.status(403).send("Неправильний PIN");
    return null;
  }
  if (result.error === "inactive") {
    res.status(403).send("Обліковий запис викладача недоступний");
    return null;
  }

  if (result.access === "admin") return { access: "admin" };

  const permissions = Array.isArray(result.teacher.permissions) ? result.teacher.permissions : [];
  if (!permissions.includes(perm)) {
    res.status(403).send("Недостатньо прав доступу");
    return null;
  }
  return { access: "teacher", teacher: result.teacher };
}

/**
 * Issue #85: доступ лише для адміністратора (розділ «Викладачі» / API).
 *
 * Приймає чинну сесію з access "admin" або адміністративний PIN у запиті.
 * Пріоритет — сесія: поле `pin` у тілі деяких адмін-запитів містить PIN
 * іншого призначення (новий PIN викладача в /api/teachers/create чи
 * /api/teachers/set-pin) і не є креденціалом адміністратора.
 * Сесія викладача/учня → 403; без входу → 401 (як для інших сесійних API).
 * PIN викладача навіть за наявності ідентифікатора не дає адмін-доступу.
 */
function requireAdmin(req, res) {
  const session = readSession(req);
  if (session && session.access === "admin") return session;

  const pin = extractPin(req);
  if (pin) {
    const result = evaluatePin(req);
    if (result.error === "ip-blocked" || result.error === "pin-blocked" || result.error === "account-blocked") {
      res.status(429).send("Забагато спроб введення PIN. Спробуйте пізніше.");
      return null;
    }
    if (result.ok && result.access === "admin") return { access: "admin" };
    if (result.ok) {
      res.status(403).send("Доступ має лише адміністратор");
      return null;
    }
    if (result.error === "inactive") {
      res.status(403).send("Обліковий запис викладача недоступний");
      return null;
    }
    res.status(403).send("Неправильний PIN");
    return null;
  }

  if (session) {
    res.status(403).send("Доступ має лише адміністратор");
    return null;
  }
  res.status(401).send("Сесію не знайдено — увійдіть заново");
  return null;
}

/**
 * Строга перевірка АДМІНІСТРАТИВНОГО PIN (PORTAL_PIN) для операцій керування.
 * У разі помилки сам надсилає відповідь (429 — забагато спроб, 403 — невірний
 * PIN) і повертає false. Issue #85: персональні PIN викладачів тут НЕ
 * приймаються — для них є requirePerm разом із заголовком X-Portal-Teacher.
 */
function requirePin(req, res) {
  const key = clientKey(req);

  if (pinLimiter.isBlocked(key)) {
    res.status(429).send("Забагато спроб введення PIN. Спробуйте пізніше.");
    return false;
  }

  if (safeEqual(extractPin(req), config.portalPin)) {
    pinLimiter.reset(key);
    return true;
  }

  pinLimiter.registerFailure(key);
  res.status(403).send("Неправильний PIN");
  return false;
}

/** Те саме, але з JSON-відповіддю (для /api/auth/verify) */
function requirePinJson(req, res) {
  const key = clientKey(req);

  if (pinLimiter.isBlocked(key)) {
    res.status(429).json({
      ok: false,
      message: "Забагато спроб введення PIN. Спробуйте пізніше."
    });
    return false;
  }

  if (safeEqual(extractPin(req), config.portalPin)) {
    pinLimiter.reset(key);
    return true;
  }

  pinLimiter.registerFailure(key);
  res.status(403).json({ ok: false, message: "Невірний PIN викладача" });
  return false;
}

module.exports = {
  safeEqual,
  extractPin,
  extractTeacherId,
  clientKey,
  evaluatePin,
  isTeacher,
  catalogIdentity,
  requirePin,
  requirePinJson,
  requirePerm,
  requireAdmin,
  issueSession,
  clearSession,
  readSession,
  requireViewer,
  mediaIdentity
};
