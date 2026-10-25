const fs = require("node:fs");
const path = require("node:path");
const { getFilePath } = require("../utils/fileHelpers");
const presenceService = require("./presenceService");
// Issue #63 (доробка): назва матеріалу для заголовка демонстрації. Учні не
// отримують прихований матеріал у каталозі, тому клієнт не може сам знайти
// назву в /api/files — сервер віддає її у стані (лише назва, без доступу).
const fileService = require("./fileService");

class StateService {
  constructor() {
    this.revision = 0;
    this.shared = {
      file: "",
      fileName: "",
      kind: "",
      page: 1,
      time: 0,
      playing: false,
      updated: Date.now()
    };
  }

  getState() {
    // Issue #63: вихід учителя. Якщо показ активний, а вчитель більше не на
    // зв'язку (закриття вкладки, «Вийти», втрата зв'язку) — зупиняємо
    // демонстрацію, інакше учні застрягають у режимі показу без керування.
    // Перевірка виконується в самому читанні стану: учні опитують його кожні
    // ~0.5 с, тож автозупинка спрацьовує невдовзі після зникнення heartbeat.
    if (this.shared.file && !presenceService.isTeacherOnline()) {
      console.log("[state] Викладач відсутній на зв'язку — автозупинка демонстрації:", this.shared.file);
      this.stopShared();
    }
    return {
      ...this.shared,
      revision: this.revision
    };
  }

  /**
   * Issue #63 (Етап 4): зміна, що стосується видимості матеріалів (приховування /
   * публікація), оновлює ревізію стану. Клієнти опитують /api/state кожні ~0.5 с
   * і на новій ревізії перечитують каталог — так зміни вчителя з'являються в
   * учнів у реальному часі через НАЯВНИЙ механізм синхронізації, без окремого
   * каналу сповіщень і без перезавантаження сторінки.
   */
  touch() {
    this.shared.updated = Date.now();
    this.revision++;
    return { ok: true, revision: this.revision };
  }

  /** Скидання спільного стану показу (файл "" = показ неактивний) */
  stopShared() {
    this.shared = {
      file: "",
      fileName: "",
      kind: "",
      page: 1,
      time: 0,
      playing: false,
      updated: Date.now()
    };
    this.revision++;
    return { ok: true, revision: this.revision, stopped: true };
  }

  updateState(data) {
    // Issue #63: явна зупинка спільної демонстрації вчителем (POST /api/control
    // { stop: true }, лише з PIN). Скидання спільного стану (file "" = показ
    // неактивний) — сторінки учнів самі повертаються до самостійного перегляду
    // без перезавантаження; ревізія зростає, тому всі клієнти бачать зупинку.
    if (data && data.stop === true) {
      return this.stopShared();
    }

    if (data.file !== undefined) {
      const filePath = getFilePath(data.file);
      if (!filePath || !fs.existsSync(filePath)) {
        const error = new Error("Файл не знайдено");
        error.status = 404;
        throw error;
      }
      this.shared.file = data.file;
      // Issue #63 (доробка): оригінальна назва матеріалу для заголовка показу
      // (учні не бачать прихований файл у каталозі, тож шукають назву тут)
      this.shared.fileName = fileService.getOriginalName(data.file);
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
        fileName: "",
        kind: "",
        page: 1,
        time: 0,
        playing: false,
        updated: Date.now()
      };
      this.revision++;
    }
  }

  /**
   * Issue #63 (доробка): чи є файл зараз АКТИВНО демонстрованим матеріалом.
   *
   * Використовується сервером для надання учням доступу ЛИШЕ до медіа того
   * матеріалу, який викладач демонструє в поточному сеансі. Перевірка виконується
   * при кожному запиті, тому:
   *  - після завершення показу (stopShared) або автозупинки при виході викладача
   *    доступ одразу зникає;
   *  - після перемикання показу на інший матеріал доступ до попереднього
   *    прихованого матеріалу теж припиняється.
   *
   * Читає стан через getState(), тому враховує автозупинку показу.
   * На КАТАЛОГ впливу немає: прихований матеріал не з'являється в /api/files
   * для учня і залишається недоступним для самостійного перегляду.
   */
  isCurrentlyDemonstrated(name) {
    if (!name || !this.shared.file) return false;
    const state = this.getState();
    return Boolean(state.file) && state.file === name;
  }
}

module.exports = new StateService();

