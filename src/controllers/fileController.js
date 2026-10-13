const fs = require("node:fs");
const fileService = require("../services/fileService");

class FileController {
  streamFile(req, res) {
    let name;
    try {
      name = decodeURIComponent(req.params.name);
    } catch {
      return res.status(400).send("Некоректне ім'я файлу");
    }

    const filePath = fileService.getFilePath(name);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).send("Файл не знайдено");
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

