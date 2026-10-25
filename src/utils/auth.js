/**
 * auth.js — перевірка PIN-коду викладача та серверних сесій входу.
 *
 * - Порівняння через crypto.timingSafeEqual (стійке до timing-атак);
 * - Ліміт спроб (див. pinLimiter.js);
 * - extractPin шукає PIN у заголовку X-Portal-Pin, тілі JSON та query;
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
const sessionService = require("../services/sessionService");

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

/** Чинна серверна сесія цього запиту (null — входу немає або він застарів) */
function readSession(req) {
  return sessionService.get(parseCookies(req)[SESSION_COOKIE]);
}

/**
 * Issue #63 (Етап 5): видача HttpOnly cookie сесії.
 * Повторний вхід тієї самої ролі ПЕРЕВИКОРИСТОВУЄ наявну сесію (сторінку
 * викладача перезавантажують часто), а зміна ролі скасовує попередню.
 */
function issueSession(req, res, role, name = "") {
  const existing = readSession(req);
  if (existing && existing.role === role && (!name || existing.name === name)) {
    res.cookie(SESSION_COOKIE, existing.id, sessionCookieOptions(req));
    return existing;
  }
  if (existing) sessionService.destroy(existing.id);
  const session = sessionService.create(role, name);
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
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Роль «викладач» для ЧИТАННЯ (каталог /api/files, категорії /api/categories):
 * PIN у запиті або чинна сесія викладача (її неможливо отримати без PIN).
 * Без входу — false; викликав відповідає сам (403), лімітатор не чіпає.
 */
function isTeacherReader(req) {
  if (extractPin(req) && isTeacher(req)) return true;
  const session = readSession(req);
  return Boolean(session && session.role === "teacher");
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
  if (extractPin(req) && isTeacher(req)) return { isTeacher: true };
  const session = readSession(req);
  if (session) return { isTeacher: session.role === "teacher", session };
  res.status(401).send("Сесію не знайдено — увійдіть заново");
  return null;
}

function clientKey(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Мовчазна перевірка ролі «викладач» (для розділених ресурсів: список файлів,
 * стрімінг, слайди). Невдалий PIN з урахуванням ліміту спроб зараховується,
 * але відповідь не змінюється — для клієнта це просто «не викладач».
 * Відсутність PIN не зараховується як спроба (інакше анонімні GET-запити
 * вичерпували б лімітатор і блокували роботу вчителя з того самого IP).
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

module.exports = {
  safeEqual,
  extractPin,
  isTeacher,
  isTeacherReader,
  requirePin,
  requirePinJson,
  issueSession,
  clearSession,
  readSession,
  requireViewer,
  mediaIdentity
};
