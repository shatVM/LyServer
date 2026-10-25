/**
 * sessionService.js — серверні сесії входу (Issue #63, Етап 5).
 *
 * Чому серверний стан, а не підписаний токен:
 *  - після перезапуску LyServer усі попередні входи мають ставати недійсними,
 *    а Map живе в пам'яті процесу — новий процес завжди стартує з порожнім
 *    сховищем (додатково reset() викликається явно на старті server.js);
 *  - старі cookie, видані до перезапуску, не збігаються з жодним id і
 *    відхиляються — відновити доступ без повторного входу неможливо;
 *  - сесію можна скасувати індивідуально (POST /api/auth/logout), на відміну
 *    від станового підпису, який діяв би до закінчення терміну.
 *
 * Сесії НЕ зберігаються на диску: облікові записи, налаштування та матеріали
 * лежать у materials/.metadata.json і файловій системі й перезапуск не чіпає.
 */
const crypto = require("node:crypto");

/** Термін життя сесії — один робочий день (учбовий сеанс), як і раніше у cookie */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

class SessionService {
  constructor() {
    /** @type {Map<string, {id: string, role: string, name: string, createdAt: number, expiresAt: number}>} */
    this.sessions = new Map();
  }

  /**
   * Створення сесії. id — випадковий 192-бітний токен (не пов'язаний із PIN),
   * тому здогадатися про нього неможливо, а витік cookie безпечний: вона не
   * авторизує операції керування (для них потрібен справжній PIN).
   * @param {"teacher"|"student"} role
   * @param {string} [name] — показне ім'я учня (для журналів присутності)
   */
  create(role, name = "") {
    const id = crypto.randomBytes(24).toString("hex");
    const now = Date.now();
    const session = {
      id,
      role,
      name: String(name || "").slice(0, 80),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Повертає сесію за id або null (невідомий/прострочений id видаляється) */
  get(id) {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  /** Індивідуальне скасування сесії (вихід викладача/учня) */
  destroy(id) {
    if (id) this.sessions.delete(id);
  }

  /**
   * Скидання ВСІХ активних сесій. Викликається на старті server.js, тому
   * після кожного перезапуску вчителі та учні входять заново, а старі cookie
   * не відновлюють доступ. Використовується також тестом для перевірки.
   */
  reset() {
    this.sessions.clear();
  }

  /** Кількість активних сесій (діагностика/тести) */
  count() {
    return this.sessions.size;
  }
}

module.exports = new SessionService();
