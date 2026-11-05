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

  /** Перевірити, чи викладач може kerувати файлом (власник або адмін) */
  static requireFileOwner(req, res, fileId) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      res.status(401).send("Сесію не знайдено — увійдіть заново");
      return null;
    }
    if (!fileService.isOwner(teacherId, fileId)) {
      const owner = fileService.ownerOf(fileId);
      if (!owner) {
        res.status(403).send("Файл належить спільній бібліотеці — редагування заборонено");
        return null;
      }
      res.status(403).send("Файл належить іншому викладачу");
      return null;
    }
    return teacherId;
  }

  /** GET /api/materials/tree — дерево папок власного простору викладача */
  folderTree(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, tree: folderService.folderTree(teacherId) });
    } catch (error) {
      res.status(500).send("Не вдалося отримати дерево папок: " + error.message);
    }
  }

  /** POST /api/materials/folder { name, parentId? } — створити папку */
  createFolder(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const body = req.body || {};
      const folder = folderService.createFolder({
        teacherId,
        name: body.name,
        parentId: body.parentId
      });
      res.status(201).json({ ok: true, folder });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося створити папку");
    }
  }

  /** POST /api/materials/folder/rename { folderId, name } */
  renameFolder(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const body = req.body || {};
      const result = folderService.renameFolder({ teacherId, folderId: body.folderId, name: body.name });
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати папку");
    }
  }

  /** POST /api/materials/folder/move { folderId, parentId? } */
  moveFolder(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const body = req.body || {};
      const result = folderService.moveFolder({ teacherId, folderId: body.folderId, parentId: body.parentId });
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перемістити папку");
    }
  }

  /** POST /api/materials/folder/delete { folderId } — видалити порожню папку */
  deleteFolder(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const body = req.body || {};
      const result = folderService.deleteFolder({ teacherId, folderId: body.folderId });
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося видалити папку");
    }
  }

  /** GET /api/materials/files?folderId= — власні файли в папці викладача */
  listFiles(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const folderId = req.query.folderId || undefined;
      const files = fileService.getFilesForTeacher(teacherId, folderId);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, files, teacherId, folderId });
    } catch (error) {
      res.status(500).send("Не вдалося отримати список файлів: " + error.message);
    }
  }

  /** POST /api/materials/upload?folderId= — завантаження файла у власну папку */
  async uploadFile(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    const folderId = req.query.folderId || "";
    const originalName = req.query.name;
    if (!originalName) return res.status(400).send("Не вказано ім'я файлу");
    const description = typeof req.query.description === "string" ? req.query.description : "";
    const categoryId = typeof req.query.categoryId === "string" ? req.query.categoryId : "";
    try {
      const result = await fileService.saveFileStream(
        req, originalName, description, categoryId, teacherId, folderId || null
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

  /** GET /api/materials/shared — каталог чужих/shared матеріалів для копіювання */
  sharedCatalog(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const files = fileService.getFilesForTeacher(null).filter((f) => f.owner && f.owner !== teacherId);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, files, teacherId });
    } catch (error) {
      res.status(500).send("Не вдалося отримати спільний каталог: " + error.message);
    }
  }

  /** POST /api/materials/copy { sourceFileId, targetFolderId } — копіювати файл у власну папку */
  async copyFile(req, res) {
    const teacherId = MaterialsController.teacherIdFromSession(req);
    if (!teacherId) {
      return res.status(401).send("Сесію не знайдено — увійдіть заново");
    }
    if (!auth.requirePerm(req, res, "materials")) return;
    try {
      const body = req.body || {};
      const result = await fileService.copyFile({
        sourceFileId: body.sourceFileId,
        targetTeacherId: teacherId,
        targetFolderId: body.targetFolderId || null
      });
      res.status(201).json({ ok: true, file: result });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося скопіювати файл");
    }
  }

  /** POST /api/materials/file/rename { file, name } — перейменувати власний файл */
  renameFile(req, res) {
    const teacherId = MaterialsController.requireFileOwner(req, res, req.body && req.body.file);
    if (!teacherId) return;
    try {
      const body = req.body || {};
      const result = fileService.renameFile(teacherId, body.file, body.name);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перейменувати матеріал");
    }
  }

  /** POST /api/materials/file/toggle-hide { file, hidden } — приховати/показати власний файл */
  toggleHide(req, res) {
    const teacherId = MaterialsController.requireFileOwner(req, res, req.body && req.body.file);
    if (!teacherId) return;
    try {
      const body = req.body || {};
      const result = fileService.toggleHide(teacherId, body.file, Boolean(body.hidden));
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося змінити видимість");
    }
  }

  /** POST /api/materials/file/delete { file } — видалити власний файл */
  deleteFile(req, res) {
    const teacherId = MaterialsController.requireFileOwner(req, res, req.body && req.body.file);
    if (!teacherId) return;
    try {
      const body = req.body || {};
      const result = fileService.deleteFile(teacherId, body.file);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося видалити файл");
    }
  }

  /** POST /api/materials/file/category { file, categoryId } — категорія власного файла */
  setFileCategory(req, res) {
    const teacherId = MaterialsController.requireFileOwner(req, res, req.body && req.body.file);
    if (!teacherId) return;
    try {
      const body = req.body || {};
      const result = fileService.moveFileToCategory(teacherId, body.file, body.categoryId);
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
