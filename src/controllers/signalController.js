/**
 * signalController.js — операції викладача з універсальними сигналами (Issue #79).
 *
 * КОНФІГУРАЦІЯ (create/update/delete/reorder) і ДОСТАВКА (send/dismiss) — лише
 * з PIN: приховування блоку «Сигнали учням» в інтерфесі не є захистом.
 * Сервер окремо перевіряє:
 *  - сигнал існує у конфігурації;
 *  - адресата наявністю в присутності (presenceService.hasStudent);
 *  - груповий запис лише для сигналів із прапорцем «Застосувати для всіх»
 *    (прапорець лише уможливлює груповий виклик і сам сигнал не надсилає —
 *    надсилання завжди окрема дія викладача);
 *  - нормалізацію цілі (studentId обмежується, "all" — єдина група).
 *
 * Усі відповіді зі станом віддають повний перелік активних сигналів у вигляді
 * викладача (з полем target) — клієнт одразу оновлює стани іконок.
 */
const auth = require("../utils/auth");
const presenceService = require("../services/presenceService");
const signalService = require("../services/signalService");

/** Нормалізація цілі з тіла запиту: "all" або studentId; інакше null */
function normalizeTarget(value) {
  if (value === "all") return "all";
  if (typeof value === "string" && value.trim()) {
    return value.trim().slice(0, 64);
  }
  return null;
}

class SignalController {
  /** GET /api/signals — конфігурація сигналів + доступний набір іконок */
  getConfig(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;
    res.set("Cache-Control", "no-store");
    res.json({
      signals: signalService.listConfig(),
      icons: signalService.availableIcons()
    });
  }

  /** POST /api/signals/create — створення сигналу з параметрами */
  create(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;
    try {
      const signal = signalService.create(req.body || {});
      res.status(201).json({ ok: true, signal });
    } catch (error) {
      res.status(error.status || 400).json({
        ok: false,
        message: error.message || "Не вдалося створити сигнал"
      });
    }
  }

  /** POST /api/signals/update — редагування переданих полів (часткове) */
  update(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;
    const body = req.body || {};
    const signalId = typeof body.signalId === "string" ? body.signalId : "";
    try {
      const signal = signalService.update(signalId, body);
      res.json({ ok: true, signal });
    } catch (error) {
      res.status(error.status || 400).json({
        ok: false,
        message: error.message || "Не вдалося оновити сигнал"
      });
    }
  }

  /** POST /api/signals/delete — видалення сигналу з конфігурації */
  remove(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;
    const body = req.body || {};
    const signalId = typeof body.signalId === "string" ? body.signalId : "";
    try {
      signalService.remove(signalId);
      res.json({ ok: true, removed: signalId });
    } catch (error) {
      res.status(error.status || 400).json({
        ok: false,
        message: error.message || "Не вдалося видалити сигнал"
      });
    }
  }

  /** POST /api/signals/reorder — зміна порядку (up/down, межа списку без змін) */
  reorder(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;
    const body = req.body || {};
    const signalId = typeof body.signalId === "string" ? body.signalId : "";
    const direction = body.direction === "up" ? "up" : "down";
    try {
      const signals = signalService.reorder(signalId, direction);
      res.json({ ok: true, signals });
    } catch (error) {
      res.status(error.status || 400).json({
        ok: false,
        message: error.message || "Не вдалося змінити порядок"
      });
    }
  }

  /**
   * POST /api/signals/send — надіслати сигнал учневі (target = studentId)
   * або всім (target = "all"). Повторне надсилання замінює попередній запис
   * і перезапускає таймер; для сигналу «до зняття» клієнт натомість шле dismiss.
   */
  send(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;

    const body = req.body || {};
    const signalId = typeof body.signalId === "string" ? body.signalId : "";
    const item = signalService.getConfigItem(signalId);
    if (!item) {
      return res.status(404).json({ ok: false, message: "Сигнал не знайдено" });
    }

    const target = normalizeTarget(body.target);
    if (!target) {
      return res.status(400).json({ ok: false, message: "Не вказано адресата сигналу" });
    }
    if (target === "all") {
      if (!item.forAll) {
        return res.status(400).json({
          ok: false,
          message: "Для сигналу не увімкнено «Застосувати для всіх»"
        });
      }
    } else if (!presenceService.hasStudent(target)) {
      return res.status(404).json({
        ok: false,
        message: "Учня не знайдено в списку присутності"
      });
    }

    const active = signalService.send(item, target);
    res.json({ ok: true, active });
  }

  /**
   * POST /api/signals/dismiss — ручне зняття активного сигналу
   * (сигнал «Показувати до зняття»); ідемпотентне, якщо запису немає.
   */
  dismiss(req, res) {
    if (!auth.requirePerm(req, res, "demo")) return;

    const body = req.body || {};
    const signalId = typeof body.signalId === "string" ? body.signalId : "";
    const target = normalizeTarget(body.target);
    if (!signalId || !target) {
      return res.status(400).json({ ok: false, message: "Не вказано сигнал або адресата" });
    }

    const result = signalService.dismiss(signalId, target);
    res.json({ ok: true, active: result.active, removed: result.removed });
  }
}

module.exports = new SignalController();
