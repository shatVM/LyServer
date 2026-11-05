/**
 * teacherService.js — облікові записи викладачів (Issue #85, Етап 1).
 *
 * Сховище: `materials/.teachers.json` (каталог materials/ у .gitignore,
 * тому файл ніколи не потрапляє в Git). Зберігається ЛИШЕ криптографічно
 * стійкий хеш PIN (scrypt + унікальна сіль, див. utils/pinHash.js); сам PIN
 * не зберігається, не логується і не повертається в API ні за яких умов.
 *
 * Атомарність і конкурентність:
 *  - усі операції синхронні (однопоточний Node: читання+мутація+запис не
 *    перериваються), тому внутрішніх гонок усередині процесу немає;
 *  - запис — через тимчасовий файл + rename (атомарна заміна на диску);
 *  - файл ЧИТАЄТЬСЯ на кожен виклик, тому локальна CLI-процедура
 *    (tools/teachers.js) працює паралельно зі запущеним сервером без
 *    перезапуску. Залишається лише теоретична гонка «останній записав»
 *    між двома процесами (задокументовано в DECISIONS.md).
 *
 * Політика відкликання (погоджено власником, Issue #85 коментар 6653554595):
 * деактивація, архівація, видалення, зміна PIN і зміна прав НЕГАЙНО
 * скасовують активні сесії викладача (sessionService.destroyByTeacher);
 * крім того, операції керування щоразу перевіряють запис на сервері.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");
const { hashPin, verifyPin, isValidPin } = require("../utils/pinHash");
const { accountLimiter, pinAttemptLimiter, pinFingerprint } = require("../utils/pinLimiter");
const sessionService = require("./sessionService");

/** Дозволені для призначення дозволи (фіксований набір, без «конструктора прав») */
const PERMISSIONS = ["demo", "materials"];
/** Логічна роль запису; адміністраторська роль НЕ призначається через цей сервіс */
const TEACHER_ROLE = "teacher";

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

/** Читання сховища (щоразу — свіжий стан, сумісно з CLI-процедурою) */
function readStore() {
  let raw;
  try {
    raw = fs.readFileSync(config.teachersFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, teachers: [] };
    throw new Error("Не вдалося прочитати файл облікових записів викладачів");
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Файл облікових записів викладачів пошкоджений (.teachers.json)");
  }
  if (!data || !Array.isArray(data.teachers)) {
    throw new Error("Файл облікових записів викладачів має некоректну структуру");
  }
  return data;
}

/** Атомарний запис: тимчасовий файл + rename (на випадок помилки — копія) */
function writeStore(store) {
  fs.mkdirSync(path.dirname(config.teachersFile), { recursive: true });
  const tmp = `${config.teachersFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, config.teachersFile);
  } catch (error) {
    try {
      fs.copyFileSync(tmp, config.teachersFile);
      fs.unlinkSync(tmp);
    } catch {
      throw error;
    }
  }
}

/**
 * Issue #85 (критерій 8/15): історичні зв'язки облікового запису.
 * У чинній моделі метаданих полів авторства ще немає, тому функція шукає
 * майбутні/можливі посилання (createdBy/author/teacherId) і поки повертає 0.
 * Якщо зв'язки з'являються — архівація має переважати над видаленням
 * (саме це показує адміністратору список «наслідки» перед підтвердженням).
 */
function historicalLinks(id) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(config.metadataFile, "utf8"));
  } catch {
    return 0;
  }
  let links = 0;
  const scan = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "createdBy" || key === "author" || key === "teacherId") && entry === id) {
        links += 1;
      }
      if (entry && typeof entry === "object") scan(entry);
    }
  };
  scan(meta);
  return links;
}

function normalizePermissions(input) {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) throw badRequest("Права мають бути списком дозволів");
  const unique = [...new Set(input.map((item) => String(item)))];
  for (const item of unique) {
    if (!PERMISSIONS.includes(item)) {
      throw badRequest(`Невідомий дозвіл «${item}». Дозволені: ${PERMISSIONS.join(", ")}`);
    }
  }
  // Дозвіл на керування викладачами (teachers) призначається лише адміністратору
  // через саму роль, тому в запис викладача він не потрапляє ніколи
  return unique;
}

function validateFullName(input) {
  const fullName = String(input || "").trim().replace(/\s+/g, " ");
  if (!fullName) throw badRequest("Не вказано ПІБ викладача");
  if (fullName.length > 120) throw badRequest("ПІБ задовге (максимум 120 символів)");
  return fullName;
}

function validatePin(input, teacherPinLength = config.teacherPinLength) {
  const pin = String(input || "");
  if (!isValidPin(pin, teacherPinLength)) {
    throw badRequest(`PIN має містити рівно ${teacherPinLength} цифри`);
  }
  return pin;
}

class TeacherService {
  /** Безпечне представлення запису: жодних полів pinHash/PIN */
  safe(record, extra = {}) {
    return {
      id: record.id,
      fullName: record.fullName,
      active: Boolean(record.active),
      archived: Boolean(record.archived),
      roles: Array.isArray(record.roles) ? record.roles : [TEACHER_ROLE],
      permissions: Array.isArray(record.permissions) ? record.permissions : [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...extra
    };
  }

  /** Список для адміністративної панелі + наслідки можливих дій */
  list() {
    return readStore().teachers.map((record) => this.safe(record, {
      activeSessions: sessionService.countForTeacher(record.id),
      historicalLinks: historicalLinks(record.id)
    }));
  }

  /** Запис з хешем (внутрішнє використання — у відповідь не потрапляє) */
  getRecord(id) {
    return readStore().teachers.find((record) => record.id === String(id)) || null;
  }

  create({ fullName, pin, permissions }) {
    const name = validateFullName(fullName);
    const pinValue = validatePin(pin);
    const perms = normalizePermissions(permissions) || [...PERMISSIONS];
    const now = Date.now();

    // Унікальність PIN: не може належати іншому активному обліковому запису
    // і не може збігатися з адміністративним PORTAL_PIN (включно зі
    // стандартним значенням, якщо змінна не задано). Перевірка серверним
    // сервісом — одною синхронною операцією читання+запису (Node
    // однопоточний, тому в-process гонки немає).
    const existingWithSamePin = readStore().teachers.find(
      (record) => record.active && !record.archived && verifyPin(pinValue, record.pinHash)
    );
    if (existingWithSamePin) {
      throw badRequest("Такий PIN уже використовується іншим обліковим записом викладача");
    }
    if (pinValue === config.portalPin) {
      throw badRequest("Персональний PIN не може збігатися з адміністративним PIN");
    }

    const record = {
      id: crypto.randomBytes(9).toString("hex"),
      fullName: name,
      pinHash: hashPin(pinValue),
      active: true,
      archived: false,
      roles: [TEACHER_ROLE],
      permissions: perms,
      createdAt: now,
      updatedAt: now
    };
    const store = readStore();
    store.teachers.push(record);
    writeStore(store);
    return this.safe(record, { activeSessions: 0, historicalLinks: 0 });
  }

  update(id, { fullName, active, permissions }) {
    const store = readStore();
    const record = store.teachers.find((item) => item.id === String(id));
    if (!record) throw notFound("Викладача не знайдено");

    let permissionsChanged = false;
    let deactivated = false;

    if (fullName !== undefined) record.fullName = validateFullName(fullName);
    if (permissions !== undefined) {
      const next = normalizePermissions(permissions);
      const current = Array.isArray(record.permissions) ? record.permissions : [];
      permissionsChanged =
        next.length !== current.length || next.some((perm) => !current.includes(perm));
      record.permissions = next;
    }
    if (active !== undefined) {
      const nextActive = Boolean(active);
      deactivated = record.active && !nextActive;
      record.active = nextActive;
      if (nextActive && record.archived) record.archived = false;
    }
    record.updatedAt = Date.now();
    writeStore(store);

    // Негайне застосування: деактивація та зміна прав відкликають сесії
    if (deactivated || permissionsChanged) {
      sessionService.destroyByTeacher(record.id);
    }
    return this.safe(record, {
      activeSessions: sessionService.countForTeacher(record.id),
      historicalLinks: historicalLinks(record.id)
    });
  }

  /** Зміна PIN: старий PIN неможливо прочитати; сесії відкликаються */
  setPin(id, pin) {
    const pinValue = validatePin(pin);
    const store = readStore();
    const record = store.teachers.find((item) => item.id === String(id));
    if (!record) throw notFound("Викладача не знайдено");

    // Унікальності PIN: не може належати іншому активному обліковому запису
    // і не може збігатися з адміністративним PORTAL_PIN.
    const existingWithSamePin = store.teachers.find(
      (r) =>
        r.id !== record.id && r.active && !r.archived && verifyPin(pinValue, r.pinHash)
    );
    if (existingWithSamePin) {
      throw badRequest("Такий PIN уже використовується іншим обліковим записом викладача");
    }
    if (pinValue === config.portalPin) {
      throw badRequest("Персональний PIN не може збігатися з адміністративним PIN");
    }

    record.pinHash = hashPin(pinValue);
    record.updatedAt = Date.now();
    writeStore(store);
    accountLimiter.reset(record.id); // нові спроби — з лічильника старого PIN
    sessionService.destroyByTeacher(record.id);
    return this.safe(record, {
      activeSessions: sessionService.countForTeacher(record.id),
      historicalLinks: historicalLinks(record.id)
    });
  }

  /** Архівація (м'яке видалення): історичні записи не руйнуються */
  archive(id) {
    const store = readStore();
    const record = store.teachers.find((item) => item.id === String(id));
    if (!record) throw notFound("Викладача не знайдено");
    record.archived = true;
    record.active = false;
    record.updatedAt = Date.now();
    writeStore(store);
    sessionService.destroyByTeacher(record.id);
    return this.safe(record, { activeSessions: 0, historicalLinks: historicalLinks(record.id) });
  }

  /**
   * Видалення запису. Вимагає явного підтвердження; адміністратор бачить
   * наслідки (активні сесії, історичні зв'язки) у списку ДО підтвердження.
   */
  remove(id, { confirm } = {}) {
    if (!confirm) throw badRequest("Підтвердьте видалення облікового запису (confirm: true)");
    const store = readStore();
    const index = store.teachers.findIndex((item) => item.id === String(id));
    if (index === -1) throw notFound("Викладача не знайдено");
    const [record] = store.teachers.splice(index, 1);
    writeStore(store);
    const revoked = sessionService.destroyByTeacher(record.id);
    accountLimiter.reset(record.id);
    return { ok: true, id: record.id, fullName: record.fullName, revokedSessions: revoked };
  }

  /**
   * Перевірка PIN конкретного облікового запису (заголовок X-Portal-Teacher).
   * Лічильник спроб за обліковим записом НЕ змінюється тут — його веде auth.js
   * (щоб атрибуція спроб була в одному місці); тут лише перевірка блокування.
   * @returns {{teacher?: object, error?: "notfound"|"locked"|"wrong"|"inactive"}}
   */
  verifyFor(id, pin) {
    if (!id) return { error: "notfound" };
    const record = this.getRecord(id);
    if (!record) return { error: "notfound" };
    if (accountLimiter.isBlocked(record.id)) return { error: "locked" };
    const fingerprint = pinFingerprint(pin);
    if (!verifyPin(pin, record.pinHash)) {
      pinAttemptLimiter.registerFailure(fingerprint);
      return { error: "wrong" };
    }
    if (!record.active || record.archived) return { error: "inactive" };
    pinAttemptLimiter.reset(fingerprint);
    accountLimiter.reset(record.id);
    return { teacher: record };
  }

  /**
   * Вхід за персональним PIN без ідентифікатора (POST /api/auth/verify):
   * система сама визначає, якому викладачеві належить PIN, і повертає ПІБ.
   * Невдалий вхід атрибутувати конкретному запису неможливо (PIN і є
   * ідентифікатором), тому його лімітує IP-лімітатор і новий лімітатор за
   * захищеним відбитком PIN (див. utils/pinLimiter.js pinAttemptLimiter).
   * Спроби за конкретним відбитком PIN блокуються після pinMaxAttempts
   * невдалих спроб — це не дає перебирати 4-значні PIN безмежно, навіть
   * змінюючи IP, і не дає одній помилковій спробі заблокувати всі записи.
   * У сховищі лімітера залишається лише HMAC-відбиток, а не сам PIN.
   * @returns {{teacher?: object, error?: "notfound"|"locked"}}
   */
  login(pin) {
    const fingerprint = pinFingerprint(pin);
    if (pinAttemptLimiter.isBlocked(fingerprint)) return { error: "locked" };

    const store = readStore();
    for (const record of store.teachers) {
      if (record.archived || !record.active) continue;
      if (!verifyPin(pin, record.pinHash)) continue;
      if (accountLimiter.isBlocked(record.id)) return { error: "locked" };
      pinAttemptLimiter.reset(fingerprint);
      accountLimiter.reset(record.id);
      return { teacher: record };
    }
    pinAttemptLimiter.registerFailure(fingerprint);
    return { error: "notfound" };
  }
}

module.exports = new TeacherService();
module.exports.PERMISSIONS = PERMISSIONS;
