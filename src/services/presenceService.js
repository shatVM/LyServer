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
// Map<studentId, { id, name, active, lastSeen, joinedAt }>

function heartbeat(id, name, active = true) {
  const now = Date.now();
  const existing = students.get(id);
  students.set(id, {
    id,
    name: name || (existing ? existing.name : id),
    active: Boolean(active),
    lastSeen: now,
    joinedAt: existing ? existing.joinedAt : now
  });
}

function getStudents() {
  const now = Date.now();
  return Array.from(students.values()).map(s => ({
    id: s.id,
    name: s.name,
    active: s.active,
    lastSeen: s.lastSeen,
    joinedAt: s.joinedAt,
    online: s.active && (now - s.lastSeen) < TIMEOUT_MS
  }));
}

// ---------------------------------------------------------------------------
// Присутність викладача (Issue #63: вихід учителя не залишає учнів у режимі
// демонстрації). Викладач шле heartbeat кожні ~2 с (POST /api/presence/teacher)
// та під час будь-якого успішного керування показом (POST /api/control).
// Якщо вчитель виходить (закрив вкладку, натиснув «Вийти», втрачено зв'язок),
// heartbeat зникає, і stateService.getState() сам зупиняє активну демонстрацію.
// Тайм-аут більший за інтервал (4 пропущені heartbeat), щоб короткі обривки
// мережі не зупиняли показ посеред уроку; у тестах задається через
// TEACHER_PRESENCE_TIMEOUT_MS.
// ---------------------------------------------------------------------------
const TEACHER_TIMEOUT_MS = Number(process.env.TEACHER_PRESENCE_TIMEOUT_MS) > 0
  ? Number(process.env.TEACHER_PRESENCE_TIMEOUT_MS)
  : 8000;

let teacherLastSeen = 0;

function markTeacherSeen() {
  teacherLastSeen = Date.now();
}

function isTeacherOnline() {
  return teacherLastSeen !== 0 && (Date.now() - teacherLastSeen) < TEACHER_TIMEOUT_MS;
}

function cleanup() {
  // Remove students that haven't pinged in 60 seconds
  const cutoff = Date.now() - 60000;
  for (const [id, s] of students) {
    if (s.lastSeen < cutoff) students.delete(id);
  }
}

// Run cleanup every minute
setInterval(cleanup, 60000).unref();

module.exports = { heartbeat, getStudents, TIMEOUT_MS, markTeacherSeen, isTeacherOnline, TEACHER_TIMEOUT_MS };
