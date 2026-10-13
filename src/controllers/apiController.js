const config = require("../config");
const fileService = require("../services/fileService");
const stateService = require("../services/stateService");
const slideService = require("../services/slideService");

class ApiController {
  verifyAuth(req, res) {
    const { pin } = req.body || {};
    if (pin === config.portalPin) {
      return res.json({ ok: true, role: "teacher" });
    }
    return res.status(403).json({ ok: false, message: "Невірний PIN викладача" });
  }

  getFiles(req, res) {
    try {
      const clientPin = req.headers["x-portal-pin"] || req.query.pin;
      const isTeacher = clientPin === config.portalPin;
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

    if (pin !== config.portalPin) {
      return res.status(403).send("Неправильний PIN");
    }

    try {
      const result = stateService.updateState(data);
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка оновлення стану");
    }
  }

  async uploadFile(req, res) {
    const clientPin = req.headers["x-portal-pin"] || req.query.pin;
    if (clientPin !== config.portalPin) {
      return res.status(403).send("Неправильний PIN");
    }

    const originalName = req.query.name;
    if (!originalName) {
      return res.status(400).send("Не вказано ім'я файлу");
    }

    try {
      const result = await fileService.saveFileStream(req, originalName);
      res.status(201).json({ ok: true, id: result.id, name: result.name, size: result.size });
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка завантаження");
    }
  }

  toggleHide(req, res) {
    const { pin, file, hidden } = req.body || {};
    if (pin !== config.portalPin) {
      return res.status(403).send("Неправильний PIN");
    }

    try {
      const result = fileService.toggleHide(file, Boolean(hidden));
      res.json(result);
    } catch (error) {
      res.status(error.status || 400).send(error.message || "Помилка зміни видимості");
    }
  }

  deleteFile(req, res) {
    const { pin, file } = req.body || {};
    if (pin !== config.portalPin) {
      return res.status(403).send("Неправильний PIN");
    }

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
    const { file } = req.body || {};
    if (!file) return res.status(400).send("Не вказано file");

    try {
      const manifest = await slideService.ensureSlides(file);
      res.json(manifest);
    } catch (error) {
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
    if (!manifest) return res.status(404).json({ ready: false });
    res.json({ ready: true, ...manifest });
  }
}

module.exports = new ApiController();
