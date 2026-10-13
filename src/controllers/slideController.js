/**
 * GET /slides/:name/:page
 * Serves a pre-rendered slide PNG image.
 * :name  — file name stored in materials/ (e.g. "lecture.pdf" or "slides.pptx")
 * :page  — 1-indexed page number
 *
 * Returns 202 if slides are not ready yet (triggering background conversion).
 */
const slideService = require("../services/slideService");
const config = require("../config");
const path = require("node:path");

class SlideController {
  async getSlide(req, res) {
    let name, page;
    try {
      name = decodeURIComponent(req.params.name);
      page = parseInt(req.params.page, 10);
    } catch {
      return res.status(400).send("Некоректні параметри");
    }

    if (!Number.isFinite(page) || page < 1) {
      return res.status(400).send("Невірний номер сторінки");
    }

    const ext = path.extname(name).toLowerCase();
    if (!config.slideExtensions.has(ext)) {
      return res.status(400).send("Файл цього типу не підтримує перегляд слайдів");
    }

    try {
      // Ensure slides are ready (converts if needed — cached on disk afterwards)
      const manifest = await slideService.ensureSlides(name);

      if (page > manifest.pageCount) {
        return res.status(404).send("Сторінки не існує");
      }

      const imgPath = slideService.getPagePath(name, page);
      if (!imgPath) {
        return res.status(404).send("Файл зображення не знайдено");
      }

      res.sendFile(imgPath, {
        dotfiles: "allow",
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600"
        }
      });
    } catch (error) {
      res.status(error.status || 500).send(error.message || "Помилка отримання слайду");
    }
  }
}

module.exports = new SlideController();

