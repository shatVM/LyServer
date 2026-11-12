/**
 * testingController.js — операції системи тестування під час демонстрації (Issue #83).
 *
 *  - start/finish — ЛИШЕ з PIN (приховування блоку «Тестування» в інтерфейсі
 *    не є захистом);
 *  - answer — лише для ролі «учень» з чинною сесією; studentId береться з
 *    прив'язки сесії (sessionService.bindStudent у heartbeat), а не з тіла
 *    запиту, тому підробити чужу відповідь неможливо;
 *  - читання стану — окремого ендпоінту немає: персональне поле state.testing
 *    додає apiController.getState до наявного /api/state (той самий механізм
 *    синхронізації, що й сигнали в Issue #79), без нового каналу опитування.
 *
 * Помилки віддаються як звичайний текст (res.send), щоб клієнтський api()
 * показував зрозуміле повідомлення, а не JSON-сирість.
 */
const auth = require("../utils/auth");
const stateService = require("../services/stateService");
const testingService = require("../services/testingService");

class TestingController {
  /** POST /api/testing/start { options: 3|4 } — запуск тестування вчителем */
  start(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;
    const body = req.body || {};
    try {
      const state = stateService.getState();
      testingService.start(state, body.options);
      res.json({ ok: true, testing: testingService.getView({ role: "teacher" }, state) });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося запустити тестування");
    }
  }

  /** POST /api/testing/finish — дострокове ручне завершення приймання */
  finish(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;
    try {
      const state = stateService.getState();
      testingService.finish();
      res.json({ ok: true, testing: testingService.getView({ role: "teacher" }, state) });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося завершити тестування");
    }
  }

  /**
   * POST /api/testing/answer { variant } — відповідь учня.
   * Сервер сам вирішує, чи приймання відкрито (сесія active + активний показ +
   * парний слайд), тож відповідь після ручного завершення або на слайді-відповіді
   * відхиляється незалежно від того, що показує клієнт.
   */
  answer(req, res) {
    const identity = auth.requireViewer(req, res);
    if (!identity) return;
    if (identity.role !== "student") {
      return res.status(403).send("Відповідати може лише учень");
    }
    const studentId = identity.studentId ? String(identity.studentId) : "";
    if (!studentId) {
      return res.status(409).send("Ідентифікатор учня ще не прив'язано до сесії — зачекайте кілька секунд");
    }
    const body = req.body || {};
    try {
      const state = stateService.getState();
      testingService.answer(studentId, body.variant, state);
      res.json({ ok: true, testing: testingService.getView(identity, state) });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося зберегти відповідь");
    }
  }
}

module.exports = new TestingController();
