/**
 * auth.js — перевірка PIN-коду викладача.
 *
 * - Порівняння через crypto.timingSafeEqual (стійке до timing-атак);
 * - Ліміт спроб (див. pinLimiter.js);
 * - extractPin шукає PIN у заголовку X-Portal-Pin, тілі JSON та query;
 * - Issue #63 (доробка): медіа-cookie замість ?pin= у URL медіафайлів —
 *   <img>/<video>/слайди надсилають cookie автоматично, тому PIN не потрапляє
 *   в адресний рядок, історію браузера та журнали запитів.
 *   Cookie містить ПОХІДНИЙ токен (HMAC від PIN), а не сам PIN, і діє лише
 *   для медіазапитів (isTeacherMedia), не для операцій керування.
 */

const crypto = require("node:crypto");
const config = require("../config");
const pinLimiter = require("./pinLimiter");

/** Ім'я HttpOnly cookie медіа-доступу викладача */
const MEDIA_COOKIE = "ly_media_auth";
/** Життя cookie — один робочий день (учбовий сеанс) */
const MEDIA_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

/** Порівняння рядків постійного часу (через хеші однакової довжини) */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a ?? ""), sha256(b ?? ""));
}

/** Отримання PIN з запиту (заголовок > тіло JSON > query) */
function extractPin(req) {
  if (req.headers && req.headers["x-portal-pin"] !== undefined) {
    return String(req.headers["x-portal-pin"]);
  }
  if (req.body && req.body.pin !== undefined) {
    return String(req.body.pin);
  }
  if (req.query && req.query.pin !== undefined) {
    return String(req.query.pin);
  }
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

/**
 * Токен медіа-доступу: HMAC-SHA256 від PIN з фіксованою міткою.
 * Сервер може перерахувати його з config.portalPin — стан не зберігається.
 * У cookie лежить ПОХІДНЕ значення, тому витік самої cookie не розкрє PIN
 * і не дає прав на POST /api/* (вони вимагають справжній PIN у заголовку/тілі).
 */
function mediaAuthToken() {
  return crypto
    .createHmac("sha256", String(config.portalPin))
    .update("lyserver-media-auth-v1")
    .digest("hex");
}

/** Видача HttpOnly медіа-cookie викладачу (при вході та оновленні сесії) */
function issueMediaCookie(req, res) {
  res.cookie(MEDIA_COOKIE, mediaAuthToken(), {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: MEDIA_COOKIE_MAX_AGE_MS,
    secure: Boolean(req.secure)
  });
}

/** Скасування медіа-cookie (вихід викладача / зміна ролі) */
function clearMediaCookie(res) {
  res.clearCookie(MEDIA_COOKIE, { path: "/" });
}

/** Чи присутня валідна медіа-cookie у запиті (порівняння стійке до часу) */
function hasMediaCookie(req) {
  const value = parseCookies(req)[MEDIA_COOKIE];
  if (!value) return false;
  return safeEqual(value, mediaAuthToken());
}

function clientKey(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Мовчазна перевірка ролі «викладач» (для розділених ресурсів: список файлів,
 * стрімінг, слайди). Невдалий PIN з урахуванням ліміту спроб зараховується,
 * але відповідь не змінюється — для клієнта це просто «не викладач».
 */
function isTeacher(req) {
  const pin = extractPin(req);
  if (!pin) return false;

  const key = clientKey(req);
  if (pinLimiter.isBlocked(key)) return false;

  if (safeEqual(pin, config.portalPin)) {
    pinLimiter.reset(key);
    return true;
  }

  pinLimiter.registerFailure(key);
  return false;
}

/**
 * Роль «викладач» для МЕДІАЗАПИТІВ (Issue #63, доробка).
 *
 * <img>/<video>/слайди не вміють додавати заголовки, тому раніше PIN
 * передавався через ?pin= у URL — він потрапляв в історію браузера (відкриття
 * зображення в новій вкладці), журнали звернень і адресний рядок. Тепер
 * браузер сам додає HttpOnly cookie, видану при вході викладача.
 *
 * Медіа-cookie діє ЛИШЕ для медіазапитів: операції керування (/api/control,
 * завантаження, приховування тощо) і надалі вимагають справжній PIN.
 */
function isTeacherMedia(req) {
  return isTeacher(req) || hasMediaCookie(req);
}

/**
 * Строга перевірка PIN для операцій керування. У разі помилки сам надсилає
 * відповідь (429 — забагато спроб, 403 — невірний PIN) і повертає false.
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
  isTeacher,
  isTeacherMedia,
  requirePin,
  requirePinJson,
  issueMediaCookie,
  clearMediaCookie,
  hasMediaCookie
};
