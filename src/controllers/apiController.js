const config = require("../config");
const path = require("node:path");
const auth = require("../utils/auth");
const fileService = require("../services/fileService");
const stateService = require("../services/stateService");
const slideService = require("../services/slideService");

class ApiController {
  verifyAuth(req, res) {
    if (!auth.requirePinJson(req, res)) return;
    res.json({ ok: true, role: "teacher" });
  }

  getFiles(req, res) {
    try {
      const isTeacher = auth.isTeacher(req);
      const files = fileService.getFilesList(isTeacher);
      res.json(files);
    } catch (error) {
      res.status(500).send("Не вдалося отримати список файлів: " + error.message);
    }
  }

  getState(req, res) {
    res.json(stateService.getState());
  }

  updateControl(req, res) {
    const { pin, ...data } = req.body || {};
    if (!auth.requirePin(req, res)) return;

    try {
      const result = stateService.updateState(data);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка оновлення стану");
    }
  }

  async uploadFile(req, res) {
    if (!auth.requirePin(req, res)) return;
    const originalName = req.query.name;
    if (!originalName) return res.status(400).send("Не вказано ім'я файлу");
    const description = typeof req.query.description === "string" ? req.query.description : "";
    const categoryId = typeof req.query.categoryId === "string" ? req.query.categoryId : "";

    try {
      const result = await fileService.saveFileStream(req, originalName, description, categoryId);
      const ext = path.extname(result.id).toLowerCase();
      let conversionStatus = "not-required";
      if (config.slideExtensions.has(ext)) {
        conversionStatus = "converting";
        fileService.setConversionStatus(result.id, conversionStatus);
        // Запускаємо у фоні, як у попередньому етапі; стан ready виставляємо
        // лише після перевірки всіх PNG. Помилка зберігається в метаданих.
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

      // Оригінал зберігається. Учні побачать документ лише після ready.
      res.status(201).json({
        ok: true, id: result.id, name: result.name, size: result.size,
        description: result.description, conversionStatus, conversionError: ""
      });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка завантаження");
    }
  }
  getCategories(req, res) {
    if (!auth.requirePin(req, res)) return;
    res.json(fileService.getCategories());
  }

  createCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const category = fileService.createCategory(req.body && req.body.name);
      res.status(201).json({ ok: true, category });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося створити категорію");
    }
  }

  deleteCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const result = fileService.deleteCategory(req.body && req.body.categoryId);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося видалити категорію");
    }
  }

  setFileCategory(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const body = req.body || {};
      res.json(fileService.moveFileToCategory(body.file, body.categoryId));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося перемістити матеріал");
    }
  }

  reorderFile(req, res) {
    if (!auth.requirePin(req, res)) return;
    try {
      const body = req.body || {};
      res.json(fileService.reorderFile(body.file, body.direction));
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Не вдалося змінити порядок");
    }
  }
  toggleHide(req, res) {
    const { pin, file, hidden } = req.body || {};
    if (!auth.requirePin(req, res)) return;

    try {
      const result = fileService.toggleHide(file, Boolean(hidden));
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка зміни видимості");
    }
  }

  deleteFile(req, res) {
    const { pin, file } = req.body || {};
    if (!auth.requirePin(req, res)) return;

    try {
      const result = fileService.deleteFile(file);
      stateService.resetIfFileMatches(file);
      // Also delete cached slides
      slideService.clearSlides(file);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка видалення файлу");
    }
  }

  /**
   * POST /api/slides/prepare  { file }
   * Trigger server-side conversion and return manifest.
   * The conversion is async — client may need to poll if it takes time.
   */
  async prepareSlides(req, res) {
    if (!auth.requirePin(req, res)) return;
    const { file } = req.body || {};
    if (!file) return res.status(400).send("Не вказано file");
    try {
      fileService.setConversionStatus(file, "converting");
      const manifest = await slideService.ensureSlides(file);
      if (!manifest || !Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) {
        throw new Error("Сервер не підтвердив готовність PNG-слайдів");
      }
      fileService.setConversionStatus(file, "ready");
      res.json(manifest);
    } catch (error) {
      fileService.setConversionStatus(file, "failed", error.message || "Помилка конвертації");
      res.status(error.status || 500).send(error.message || "Помилка конвертації");
    }
  }
  /**
   * GET /api/slides/info?file=<name>
   * Returns cached manifest (pageCount) without conversion.
   */
  getSlideInfo(req, res) {
    const { file } = req.query;
    if (!file) return res.status(400).send("Не вказано file");
    const manifest = slideService.getManifest(file);
    if (!manifest) {
      const metadata = fileService.getMetadata();
      const info = metadata.files && metadata.files[file];
      if (info && info.conversionStatus === "failed") {
        return res.json({ ready: false, failed: true, error: info.conversionError || "Помилка конвертації" });
      }
      if (info && info.conversionStatus === "converting") return res.json({ ready: false, converting: true });
      return res.status(404).json({ ready: false });
    }
    if (manifest.converting) return res.json({ ready: false, converting: true });
    if (!Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) {
      return res.status(500).json({ ready: false, failed: true, error: "Некоректний маніфест PNG-слайдів" });
    }
    res.json({ ready: true, ...manifest });
  }
}

module.exports = new ApiController();
