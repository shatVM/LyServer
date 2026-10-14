/**
 * presenceController.js
 * Handles student presence heartbeats and teacher's student list.
 */

const presenceService = require("../services/presenceService");
const config = require("../config");

class PresenceController {
  /**
   * POST /api/presence/heartbeat
   * Body: { studentId, name, active }
   * Called every ~5s by each student. No auth required.
   * Issue #7: поле active — ознака активності сесії (вкладка видима).
   * Приймається і як JSON, і як form-data (для navigator.sendBeacon).
   */
  heartbeat(req, res) {
    const { studentId, name } = req.body || {};
    if (!studentId || typeof studentId !== "string") {
      return res.status(400).json({ ok: false, message: "Відсутній studentId" });
    }
    const rawActive = (req.body || {}).active;
    const active = rawActive === undefined
      ? true
      : !(rawActive === false || rawActive === "false" || rawActive === "0");
    const safeName = (name || "Учень").slice(0, 80);
    presenceService.heartbeat(studentId.slice(0, 64), safeName, active);
    res.json({ ok: true });
  }

  /**
   * GET /api/presence/students
   * Teacher-only. Returns all students with online status.
   */
  getStudents(req, res) {
    const clientPin = req.headers["x-portal-pin"] || req.query.pin;
    if (clientPin !== config.portalPin) {
      return res.status(403).json({ ok: false, message: "Тільки для викладача" });
    }
    const list = presenceService.getStudents();
    res.json(list);
  }
}

module.exports = new PresenceController();

