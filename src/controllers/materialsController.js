/**
 * materialsController.js — серверна основа персональних просторів матеріалів
 * викладачів (Issue #88, Етап 1).
 *
 * Всі операції перевіряють власника файла/папки на СЕРВЕРІ через автентифіковану
 * сесію (teacherId). Ніколи не довіряємо teacherId, folder ID або шляху,
 * переданому клієнтом, як доказу власності.
 *
 * UI на цьому етапі не змінюється; API призначене для наступного етапу інтерфейсу.
 */

const auth = require("../utils/auth");
const fileService = require("../services/fileService");
const folderService = require("../services/folderService");
const slideService = require("../services/slideService");
const config = require("../config");
const path = require("node:path");

class MaterialsController {
  /** Отримати teacherId з чинної серверної сесії (не з тіла/заголовка запиту) */
  static teacherIdFromSession(req) {
    const session = auth.readSession(req);
    if (!session || session.role !== "teacher") return null;
    return session.teacherId || null;
  }

  /**
   * Авторизація операції з матеріалами (Issue #88, «повний доступ адміністратора»).
   *
   * Спочатку PIN-дозвіл (чинна модель Issue #63: сама cookie не авторизує
   * операції API), далі — сесія для визначення власника простору:
   *  - адмін-PIN (X-Portal-Pin = PORTAL_PIN) або адмін-сесія →
   *    { isAdmin: true, teacherId: null } — повний доступ до всіх просторів,
   *    включно з осиротілими (власник уже видалений) і legacy-файлами;
   *  - персональний PIN викладача → { isAdmin: false, teacherId } —
   *    лише власний простір; teacherId береться лише з сесії.
   *
   * У разі помилки сама надсилає відповідь і повертає null.
   */
  static authorize(req, res) {
    const session = auth.readSession(req);
    const isAdminSession = Boolean(session && session.access === "admin");
    const pinPresent = Boolean(auth.extractPin(req));

    if (pinPresent) {
      const perm = auth.requirePerm(req, res, "materials");
      if (!perm) return null;
      if (perm.access === "admin") return { isAdmin: true, teacherId: null };
    } else if (isAdminSession) {
      return { isAdmin: true, teacherId: null };
    } else if (!session) {
      res.status(401).send("Сесію не знайдено — увійдіть заново");
      return null;
    } else {
      // Cookie викладача без PIN не авторизує операції (захист Issue #63)
      const perm = auth.requirePerm(req, res, "materials");
      if (!perm) return null;
    }

    const teacherId = session && session.role === "teacher" ? (session.teacherId || null) : null;
    if (!teacherId) {
      res.status(401).send("Сесію не знайдено — увійдіть заново");
      return null;
    }
    return { isAdmin: false, teacherId };
  }

  /**
   * Доступ до конкретного файла: адмін — до будь-якого (включно з legacy
   * і осиротілими), викладач — лише до власного. У разі заборони надсилає 403
   * і повертає false.
   */
  static ensureFileAccess(res, actor, fileId) {
    if (actor.isAdmin) return true;
    if (fileService.isOwner(actor.teacherId, fileId)) return true;
    const owner = fileService.ownerOf(fileId);
    if (!owner) {
      res.status(403).send("Файл належить спільній бібліотеці — редагування заборонено");
      return false;
    }
    res.status(403).send("Файл належить іншому викладачу");
    return false;
  }

  /**
   * Простір (teacherId), у якому виконується операція з папкою.
   * Викладач — завжди власний простір; адмін — простір, на який вказує
   * body.teacherId, а за його відсутності — простір самого folderId.
   */
  static folderSpace(actor, body, folderId) {
    if (!actor.isAdmin) return actor.teacherId;
    const folder = folderId ? folderService.getFolder(folderId) : null;
    if (folder) return folder.teacherId;
    return body && body.teacherId ? String(body.teacherId) : "";
  }

  /** GET /api/materials/tree — дерево папок простору (свого або вказаного адміном) */
  folderTree(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    const spaceId = actor.isAdmin ? (req.query.teacherId || "") : actor.teacherId;
    if (!spaceId) return res.status(400).send("Вкажіть teacherId простору");
    try {
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, tree: folderService.folderTree(spaceId), teacherId: spaceId });
    } catch (error) {
      res.status(500).send("Не вдалося отримати дерево папок: " + error.message);
    }
  }

  /** POST /api/materials/folder { name, parentId?, teacherId? } — створити папку */
  createFolder(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    try {
      const body = req.body || {};
      const spaceId = actor.isAdmin ? (body.teacherId || "") : actor.teacherId;
      if (!spaceId) return res.status(400).send("Вкажіть teacherId простору");
      const folder = folderService.createFolder({
        teacherId: spaceId,
        name: body.name,
        parentId: body.parentId
      });
      res.status(201).json({ ok: true, folder });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося створити папку");
    }
  }

  /** POST /api/materials/folder/rename { folderId, name, teacherId? } */
  renameFolder(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    try {
      const body = req.body || {};
      const spaceId = MaterialsController.folderSpace(actor, body, body.folderId);
      if (!spaceId) return res.status(400).send("Вкажіть teacherId простору");
      const result = folderService.renameFolder({ teacherId: spaceId, folderId: body.folderId, name: body.name });
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати папку");
    }
  }

  /** POST /api/materials/folder/move { folderId, parentId?, teacherId? } */
  moveFolder(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    try {
      const body = req.body || {};
      const spaceId = MaterialsController.folderSpace(actor, body, body.folderId);
      if (!spaceId) return res.status(400).send("Вкажіть teacherId простору");
      const result = folderService.moveFolder({ teacherId: spaceId, folderId: body.folderId, parentId: body.parentId });
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перемістити папку");
    }
  }

  /** POST /api/materials/folder/delete { folderId, teacherId? } — видалити порожню папку */
  deleteFolder(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    try {
      const body = req.body || {};
      const spaceId = MaterialsController.folderSpace(actor, body, body.folderId);
      if (!spaceId) return res.status(400).send("Вкажіть teacherId простору");
      const result = folderService.deleteFolder({ teacherId: spaceId, folderId: body.folderId });
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося видалити папку");
    }
  }

  /** GET /api/materials/files?folderId=&teacherId= — файли простору */
  listFiles(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    const spaceId = actor.isAdmin ? (req.query.teacherId || "") : actor.teacherId;
    if (!spaceId) return res.status(400).send("Вкажіть teacherId простору");
    try {
      const folderId = req.query.folderId || undefined;
      const files = fileService.getFilesForTeacher(spaceId, folderId);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, files, teacherId: spaceId, folderId });
    } catch (error) {
      res.status(500).send("Не вдалося отримати список файлів: " + error.message);
    }
  }

  /** POST /api/materials/upload?folderId=&teacherId= — завантаження у простір */
  async uploadFile(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    const spaceId = actor.isAdmin ? (req.query.teacherId || "") : actor.teacherId;
    if (!spaceId) return res.status(400).send("Вкажіть teacherId простору");
    const folderId = req.query.folderId || "";
    const originalName = req.query.name;
    if (!originalName) return res.status(400).send("Не вказано ім'я файлу");
    const description = typeof req.query.description === "string" ? req.query.description : "";
    const categoryId = typeof req.query.categoryId === "string" ? req.query.categoryId : "";
    try {
      const result = await fileService.saveFileStream(
        req, originalName, description, categoryId, spaceId, folderId || null
      );
      const ext = path.extname(result.id).toLowerCase();
      let conversionStatus = "not-required";
      if (config.slideExtensions.has(ext)) {
        conversionStatus = "converting";
        fileService.setConversionStatus(result.id, conversionStatus);
        void slideService.ensureSlides(result.id)
          .then(manifest => {
            if (!manifest || !Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) {
              throw new Error("Сервер не підтвердив готовність PNG-слайдів");
            }
            fileService.setConversionStatus(result.id, "ready");
          })
          .catch(error => {
            const conversionError = error.message || "Помилка конвертації";
            fileService.setConversionStatus(result.id, "failed", conversionError);
            console.error("Конвертація слайдів (" + result.id + "):", conversionError);
          });
      }
      res.status(201).json({
        ok: true, id: result.id, name: result.name, size: result.size,
        description: result.description, conversionStatus, conversionError: "",
        owner: result.owner, folderId: result.folderId
      });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка завантаження");
    }
  }

  /** GET /api/materials/shared — каталог чужих матеріалів для копіювання */
  sharedCatalog(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    try {
      const data = fileService.getMetadata();
      const spaceId = actor.isAdmin ? null : actor.teacherId;
      const files = Object.entries(data.files || {})
        .map(([id, record]) => ({ id, ...record }))
        .filter((f) => f.owner && f.owner !== spaceId);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, files, teacherId: spaceId });
    } catch (error) {
      res.status(500).send("Не вдалося отримати спільний каталог: " + error.message);
    }
  }

  /**
   * POST /api/materials/copy { sourceFileId, targetFolderId, targetTeacherId? } —
   * скопіювати файл. Викладач копіює завжди у власний простір (targetTeacherId
   * із запиту ігнорується); адмін може вказати targetTeacherId — будь-який
   * простір, включно з осиротілим.
   */
  async copyFile(req, res) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return;
    try {
      const body = req.body || {};
      const targetTeacherId = actor.isAdmin
        ? String(body.targetTeacherId || "")
        : actor.teacherId;
      if (!targetTeacherId) {
        return res.status(400).send("Вкажіть targetTeacherId простору-приймача");
      }
      const result = await fileService.copyFile({
        sourceFileId: body.sourceFileId,
        targetTeacherId,
        targetFolderId: body.targetFolderId || null
      });
      res.status(201).json({ ok: true, file: result });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося скопіювати файл");
    }
  }

  /**
   * Спільна перевірка доступу до файлу для операцій редагування:
   * адмін — до будь-якого файла, викладач — лише до власного.
   * У разі заборони надсилає 403 і повертає null.
   */
  static fileActor(req, res, fileId) {
    const actor = MaterialsController.authorize(req, res);
    if (!actor) return null;
    if (!MaterialsController.ensureFileAccess(res, actor, fileId)) return null;
    return actor;
  }

  /** POST /api/materials/file/rename { file, name } — перейменувати файл */
  renameFile(req, res) {
    const actor = MaterialsController.fileActor(req, res, req.body && req.body.file);
    if (!actor) return;
    try {
      const body = req.body || {};
      const result = fileService.renameFile(actor.teacherId, body.file, body.name);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати матеріал");
    }
  }

  /** POST /api/materials/file/toggle-hide { file, hidden } — приховати/показати файл */
  toggleHide(req, res) {
    const actor = MaterialsController.fileActor(req, res, req.body && req.body.file);
    if (!actor) return;
    try {
      const body = req.body || {};
      const result = fileService.toggleHide(actor.teacherId, body.file, Boolean(body.hidden));
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося змінити видимість");
    }
  }

  /** POST /api/materials/file/delete { file } — видалити файл */
  deleteFile(req, res) {
    const actor = MaterialsController.fileActor(req, res, req.body && req.body.file);
    if (!actor) return;
    try {
      const body = req.body || {};
      const result = fileService.deleteFile(actor.teacherId, body.file);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося видалити файл");
    }
  }

  /** POST /api/materials/file/category { file, categoryId } — категорія файла */
  setFileCategory(req, res) {
    const actor = MaterialsController.fileActor(req, res, req.body && req.body.file);
    if (!actor) return;
    try {
      const body = req.body || {};
      const result = fileService.moveFileToCategory(actor.teacherId, body.file, body.categoryId);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перемістити матеріал");
    }
  }

  /** GET /api/materials/admin/tree — адмін: дерево всіх просторів (включно з orphaned) */
  adminTree(req, res) {
    if (!auth.requireAdmin(req, res)) return;
    try {
      const data = fileService.getMetadata();
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, folders: data.folders || [], files: data.files || {} });
    } catch (error) {
      res.status(500).send("Не вдалося отримати адмін-дерево: " + error.message);
    }
  }
}

module.exports = new MaterialsController();
