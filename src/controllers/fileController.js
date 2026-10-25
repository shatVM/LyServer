const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");
const auth = require("../utils/auth");
const fileService = require("../services/fileService");
const { canViewMedia } = require("../utils/mediaAccess");

class FileController {
  streamFile(req, res) {
    let name;
    try {
      name = decodeURIComponent(req.params.name);
    } catch {
      return res.status(400).send("Некоректне ім'я файлу");
    }

    // Issue #63 (доробка): викладач ідентифікується також за HttpOnly
    // медіа-cookie — у <img>/<video> PIN більше не передається у URL
    const isTeacher = auth.isTeacherMedia(req);

    const filePath = fileService.getFilePath(name);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).send("Файл не знайдено");
    }

    // Issue #4: приховані файли недоступні учням.
    // Issue #63 (доробка): виняток — матеріал, який зараз демонструється
    // (перевірка на сервері при кожному запиті, див. mediaAccess)
    if (!canViewMedia(name, isTeacher)) {
      return res.status(404).send("Файл не знайдено");
    }

    // Issue #8: PDF/PPTX для учнів — лише у вигляді PNG-слайдів
    if (!isTeacher && config.slideExtensions.has(path.extname(name).toLowerCase())) {
      return res.status(403).send("Цей документ доступний учасникам лише у вигляді слайдів");
    }

    res.sendFile(
      filePath,
      {
        acceptRanges: true,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      },
      err => {
        if (err && !res.headersSent) {
          if (err.status === 416) {
            res.status(416).end();
          } else {
            res.status(err.status || 500).send(err.message || "Помилка передачі файлу");
          }
        }
      }
    );
  }
}

module.exports = new FileController();
