/**
 * teacherController.js — адміністративне API облікових записів викладачів
 * (Issue #85, Етап 1).
 *
 * Захист: auth.requireAdmin — лише адміністративний PORTAL_PIN або чинна
 * сесія з access "admin". Сесія викладача чи учня → 403 (жодних прав самому
 * собі призначити не можна), без входу → 401.
 *
 * У відповідях НІКОЛИ не передаються PIN або його хеш: лише безпечне
 * представлення запису (див. teacherService.safe) + наслідки дій
 * (активні сесії, історичні зв'язки) — вони потрібні адміністратору ДО
 * підтвердження деактивації/архівації/видалення.
 */

const auth = require("../utils/auth");
const teacherService = require("../services/teacherService");

class TeacherController {
  /** GET /api/teachers — список записів (без PIN/хеша) */
  list(req, res) {
    if (!auth.requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    try {
      res.json({ ok: true, teachers: teacherService.list() });
    } catch (error) {
      res.status(500).send("Не вдалося прочитати облікові записи: " + error.message);
    }
  }

  /** POST /api/teachers/create { fullName, pin, permissions? } */
  create(req, res) {
    if (!auth.requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const teacher = teacherService.create({
        fullName: body.fullName,
        pin: body.pin,
        permissions: body.permissions
      });
      res.status(201).json({ ok: true, teacher });
    } catch (error) {
      res.status(error.status || 400).json({ ok: false, message: error.message });
    }
  }

  /**
   * POST /api/teachers/update { id, fullName?, active?, permissions? }.
   * Зміна прав або деактивація відкликає активні сесії викладача
   * (сервіс робить це сам), тому нові умови діють негайно.
   */
  update(req, res) {
    if (!auth.requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const teacher = teacherService.update(body.id, {
        fullName: body.fullName,
        active: body.active,
        permissions: body.permissions
      });
      res.json({ ok: true, teacher });
    } catch (error) {
      res.status(error.status || 400).json({ ok: false, message: error.message });
    }
  }

  /** POST /api/teachers/set-pin { id, pin } — заміна PIN без показу старого */
  setPin(req, res) {
    if (!auth.requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const teacher = teacherService.setPin(body.id, body.pin);
      res.json({ ok: true, teacher });
    } catch (error) {
      res.status(error.status || 400).json({ ok: false, message: error.message });
    }
  }

  /** POST /api/teachers/archive { id } — м'яке видалення зі збереженням історії */
  archive(req, res) {
    if (!auth.requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const teacher = teacherService.archive(body.id);
      res.json({ ok: true, teacher });
    } catch (error) {
      res.status(error.status || 400).json({ ok: false, message: error.message });
    }
  }

  /**
   * POST /api/teachers/delete { id, confirm } — видалення запису.
   * Без confirm: true → 400 (наслідки показуються в списку перед підтвердженням).
   */
  remove(req, res) {
    if (!auth.requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const result = teacherService.remove(body.id, { confirm: body.confirm });
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).json({ ok: false, message: error.message });
    }
  }
}

module.exports = new TeacherController();
