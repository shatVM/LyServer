/**
 * auth.js — перевірка PIN-коду викладача.
 *
 * - Порівняння через crypto.timingSafeEqual (стійке до timing-атак);
 * - Ліміт спроб (див. pinLimiter.js);
 * - extractPin шукає PIN у заголовку X-Portal-Pin, тілі JSON та query.
 */

const crypto = require("node:crypto");
const config = require("../config");
const pinLimiter = require("./pinLimiter");

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

module.exports = { safeEqual, extractPin, isTeacher, requirePin, requirePinJson };
