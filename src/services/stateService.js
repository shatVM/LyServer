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
    // Issue #63 (доробка §3): чи файл був прихованим у момент старту показу.
    // Потрібно, щоб відрізнити: "демонстрація прихованого матеріалу" (дозволено)
    // від "приховування матеріалу ПІД ЧАС показу" (заборонено для учнів).
    this.wasHiddenAtDemoStart = false;
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

    const state = {
      ...this.shared,
      revision: this.revision
    };

    // Issue #63 (доробка §3): чи можна ЗАРАЗ показувати активний матеріал
    // учням. blocked = матеріал показу зараз прихований, але НЕ БУВ прихованим
    // у момент старту демонстрації (тобто викладач приховав його ПІД ЧАС показу).
    // Якщо матеріал був прихований вже при старті — це увімкнено демонстрацію
    // прихованого матеріалу, і учні його бачать (стара вимога).
    // Якщо файл зник з диску — теж заблоковано.
    const filePath = state.file ? getFilePath(state.file) : null;
    const currentlyHidden = fileService.isHidden(state.file);
    state.blocked = Boolean(state.file) &&
      (!filePath || !fs.existsSync(filePath) || (currentlyHidden && !this.wasHiddenAtDemoStart));

    return state;
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
    // Issue #63 (доробка §3): скидаємо прапорець прихованості на старті
    this.wasHiddenAtDemoStart = false;
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
      // Issue #63 (доробка §3): при старті демонстрації нового файлу
      // запам'ятовуємо, чи він був прихованим у цей момент.
      // Це потрібно, щоб відрізнити "демонстрація прихованого" від
      // "приховування під час показу".
      this.wasHiddenAtDemoStart = fileService.isHidden(data.file);

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
      // Issue #63 (доробка §3): скидаємо прапорець прихованості на старті
      this.wasHiddenAtDemoStart = false;
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

  /**
   * Issue #63 (доробка): чи активний демонстрований матеріал треба ВІДКЛИКАТИ
   * у учнів (був доступний на старті показу, а вчитель приховав його ПІД ЧАС
   * демонстрації). Повертає true лише для поточного файлу показу, якщо:
   *  - показ активний (shared.file === name)
   *  - файл зараз прихований
   *  - файл НЕ БУВ прихованим у момент старту показу (wasHiddenAtDemoStart = false)
   *
   * Це сигнал для mediaAccess: доступ до медіа такого файлу має бути відкликаний
   * негайно (404), навіть якщо демонстрація технічно триває.
   */
  isDemonstratedButHiddenDuringDemo(name) {
    if (!name || !this.shared.file) return false;
    if (this.shared.file !== name) return false;
    // Матеріал приховано зараз, але на старті показу його НЕ було прихованим
    return fileService.isHidden(name) && !this.wasHiddenAtDemoStart;
  }
}

module.exports = new StateService();

