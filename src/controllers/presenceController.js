/**
 * presenceController.js
 * Handles student presence heartbeats and teacher's student list.
 */

const presenceService = require("../services/presenceService");
const sessionService = require("../services/sessionService");
const auth = require("../utils/auth");

class PresenceController {
  /**
   * POST /api/presence/heartbeat
   * Body: { studentId, name, active }
   * Called every ~2s by each student (HEARTBEAT_MS in public/js/app.js).
   * Issue #7: поле active — ознака активності сесії (вкладка видима).
   * Приймається і як JSON, і як form-data (для navigator.sendBeacon).
   * Issue #63 (Етап 5): потрібна чинна сесія входу (401 без неї) — після
   * перезапуску сервера старі cookie не «відновлюють» присутність учня,
   * а анонімні клієнти не можуть наповнювати список присутності.
   */
  heartbeat(req, res) {
    const viewer = auth.requireViewer(req, res);
    if (!viewer) return;
    const { studentId, name } = req.body || {};
    if (!studentId || typeof studentId !== "string") {
      return res.status(400).json({ ok: false, message: "Відсутній studentId" });
    }
    const rawActive = (req.body || {}).active;
    const active = rawActive === undefined
      ? true
      : !(rawActive === false || rawActive === "false" || rawActive === "0");
    const safeName = (name || "Учень").slice(0, 80);
    // Issue #75: IP-адреса береться ЛИШЕ з серверного контексту запиту
    // (req.ip / сокет, див. auth.clientKey) — будь-яке поле `ip` у тілі запиту
    // від клієнта ігнорується. `::ffff:`-префікс прибирається для показу.
    const ip = String(auth.clientKey(req) || "").replace(/^::ffff:/, "");
    presenceService.heartbeat(studentId.slice(0, 64), safeName, active, ip);
    // Issue #79: studentId прив'язується до СЕРВЕРНОЇ сесії (лише власник
    // cookie може зробити цю прив'язку) — далі /api/state віддає сигнали саме
    // цьому клієнту, а значення з тіла запиту не дає змоги отримати чужий сигнал
    if (viewer.role === "student") sessionService.bindStudent(viewer.id, studentId);
    res.json({ ok: true });
  }

  /**
   * GET /api/presence/students
   * Teacher-only. Returns all students with online status.
   */
  getStudents(req, res) {
    // Issue #63 (аудит PIN): приймається лише заголовок X-Portal-Pin або тіло
    // запиту (query `?pin=` більше не читається — він потрапив би в журнал
    // сервера, історію браузера та Referer). Порівняння — timing-safe з
    // урахуванням лімітатора спроб; відсутність PIN не зараховується як спроба.
    if (!auth.isTeacher(req)) {
      return res.status(403).json({ ok: false, message: "Тільки для викладача" });
    }
    const list = presenceService.getStudents();
    res.json(list);
  }
}

module.exports = new PresenceController();

