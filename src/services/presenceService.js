/**
 * presenceService.js
 * Tracks student online presence via heartbeat pings.
 * Students send POST /api/presence/heartbeat every ~5s with { studentId, name, active }.
 * Teacher polls GET /api/presence/students to get the list with online status.
 *
 * A student is considered "online" if:
 *  - their last heartbeat was within 6 seconds, AND
 *  - their browser session reported itself active (visible tab / not closed).
 *
 * Issue #7 / Issue #19: активність сесії оновлюється не лише таймером, а й
 * миттєво через Page Visibility API (visibilitychange + sendBeacon при
 * закритті вкладки). Для швидкого оновлення статусу: heartbeat учня — кожні
 * ~2 с (public/js/app.js, HEARTBEAT_MS), опитування викладачем — щосекунди
 * (PRESENCE_POLL_MS), тайм-аут офлайну — 6 с.
 */

const TIMEOUT_MS = 6000; // 6 seconds without heartbeat → offline

const students = new Map();
// Map<studentId, { id, name, active, lastSeen, joinedAt, ip }>

/**
 * Issue #75: heartbeat зберігає IP-адресу пристрою учня. Адресу передає
 * контролер із серверного контексту запиту (auth.clientKey) — значення з тіла
 * запиту клієнта сюди не потрапляють. Порожнє значення не перетирає
 * відомий IP (наприклад, beacon без мережевих даних).
 */
function heartbeat(id, name, active = true, ip = "") {
  const now = Date.now();
  const existing = students.get(id);
  students.set(id, {
    id,
    name: name || (existing ? existing.name : id),
    active: Boolean(active),
    lastSeen: now,
    joinedAt: existing ? existing.joinedAt : now,
    ip: ip || (existing ? existing.ip : "")
  });
}

/**
 * Issue #79: чи відомий учень у списку присутності (наявний ідентифікатор —
 * єдина перевірка адресата при надсиланні сигналу; онлайн-статус не обов'язковий,
 * сигнал діятиме, коли учень повернеться, або завершиться за тривалістю).
 */
function hasStudent(id) {
  return Boolean(id) && students.has(id);
}

function getStudents() {
  const now = Date.now();
  return Array.from(students.values()).map(s => ({
    id: s.id,
    name: s.name,
    active: s.active,
    lastSeen: s.lastSeen,
    joinedAt: s.joinedAt,
    ip: s.ip || "",
    online: s.active && (now - s.lastSeen) < TIMEOUT_MS
  }));
}

// ---------------------------------------------------------------------------
// Присутність викладача (heartbeat, тайм-аут, автозупинка демонстрації)
// прибрано рішенням власника (2026-11-12): довга відсутність вчителя на
// сайті більше НЕ зупиняє активний показ — зупиняє лише явна дія вчителя
// (кнопка «Стоп», «Вийти» або закриття вкладки). Див. DECISIONS.md.
// ---------------------------------------------------------------------------

function cleanup() {
  // Remove students that haven't pinged in 60 seconds
  const cutoff = Date.now() - 60000;
  for (const [id, s] of students) {
    if (s.lastSeen < cutoff) students.delete(id);
  }
}

// Run cleanup every minute
setInterval(cleanup, 60000).unref();

module.exports = { heartbeat, getStudents, hasStudent, TIMEOUT_MS };
