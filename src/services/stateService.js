const fs = require("node:fs");
const path = require("node:path");
const { getFilePath } = require("../utils/fileHelpers");

class StateService {
  constructor() {
    this.revision = 0;
    this.shared = {
      file: "",
      kind: "",
      page: 1,
      time: 0,
      playing: false,
      updated: Date.now()
    };
  }

  getState() {
    return {
      ...this.shared,
      revision: this.revision
    };
  }

  updateState(data) {
    // Issue #63: явна зупинка спільної демонстрації вчителем (POST /api/control
    // { stop: true }, лише з PIN). Скидання спільного стану (file "" = показ
    // неактивний) — сторінки учнів самі повертаються до самостійного перегляду
    // без перезавантаження; ревізія зростає, тому всі клієнти бачать зупинку.
    if (data && data.stop === true) {
      this.shared = {
        file: "",
        kind: "",
        page: 1,
        time: 0,
        playing: false,
        updated: Date.now()
      };
      this.revision++;
      return { ok: true, revision: this.revision, stopped: true };
    }

    if (data.file !== undefined) {
      const filePath = getFilePath(data.file);
      if (!filePath || !fs.existsSync(filePath)) {
        const error = new Error("Файл не знайдено");
        error.status = 404;
        throw error;
      }
      this.shared.file = data.file;
      const fileExt = path.extname(data.file).toLowerCase();
      this.shared.kind = (fileExt === ".pdf" || fileExt === ".pptx")
        ? "slides"
        : "video";
      this.shared.page = 1;
      this.shared.time = 0;
      this.shared.playing = false;
    }

    if (Number.isFinite(Number(data.page))) {
      this.shared.page = Math.max(1, Math.min(100000, Math.floor(Number(data.page))));
    }

    if (Number.isFinite(Number(data.time))) {
      this.shared.time = Math.max(0, Math.min(86400 * 30, Number(data.time)));
    }

    if (typeof data.playing === "boolean") {
      this.shared.playing = data.playing;
    }

    if (data.kind === "pdf" || data.kind === "slides" || data.kind === "video") {
      this.shared.kind = data.kind === "pdf" ? "slides" : data.kind;
    }

    this.shared.updated = Date.now();
    this.revision++;

    return { ok: true, revision: this.revision };
  }

  resetIfFileMatches(filename) {
    if (this.shared.file === filename) {
      this.shared = {
        file: "",
        kind: "",
        page: 1,
        time: 0,
        playing: false,
        updated: Date.now()
      };
      this.revision++;
    }
  }
}

module.exports = new StateService();

