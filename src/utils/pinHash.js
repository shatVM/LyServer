/**
 * pinHash.js — хешування персональних PIN викладачів (Issue #85).
 *
 * Алгоритм: scrypt (реалізація `node:crypto`, без нових залежностей) з
 * унікальною сіллю на кожен запис і параметрами вартості, збереженими
 * всередині самого запису. У сховищі лишається лише `scrypt$N$r$p$сіль$хеш`.
 *
 * Чому scrypt, а не Argon2id: у проєкті немає нативних залежностей для
 * хешування паролів, а вбудований crypto.scryptSync не потребує збірки
 * (рішення зафіксовано в DECISIONS.md).
 *
 * ВАЖЛИВО: 4-значний PIN має низьку ентропію, тому хешування НЕ замінює
 * rate limiting — воно захищає лише від offline-перебору після витоку файлу
 * (див. pinLimiter: IP-ліміт і ліміт за обліковим записом).
 */

const crypto = require("node:crypto");

/** Параметри за замовчуванням (зберігаються в хеші — можна змінювати) */
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
/** Верхні межі параметрів із хешу — захист від DoS через підроблений запис */
const LIMITS = { N: 1 << 17, r: 16, p: 4 };

/** Перевірка формату персонального PIN: рівно 4 цифри (Issue #85) */
function isValidPin(pin, length = 4) {
  return new RegExp(`^\\d{${length}}$`).test(String(pin || ""));
}

/** Хеш PIN: повертає рядок `scrypt$N$r$p$сіль(hex)$хеш(hex)` */
function hashPin(pin) {
  const { N, r, p, keylen } = DEFAULT_PARAMS;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, keylen, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("hex"), hash.toString("hex")].join("$");
}

/**
 * Перевірка PIN проти збереженого хешу (порівняння постійного часу).
 * Невідомий/пошкоджений формат і будь-яка помилка → false (без винятків).
 */
function verifyPin(pin, encoded) {
  try {
    const parts = String(encoded || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (N < 2 || N > LIMITS.N || r < 1 || r > LIMITS.r || p < 1 || p > LIMITS.p) return false;
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    if (salt.length < 8 || expected.length < 16) return false;
    const actual = crypto.scryptSync(String(pin), salt, expected.length, {
      N, r, p,
      // запас до 64 МБ — вистачає для LIMITS, не дозволяє довільні параметри
      maxmem: 64 * 1024 * 1024
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPin, verifyPin, isValidPin };
