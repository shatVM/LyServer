const fs = require("node:fs");
const path = require("node:path");
const { getFilePath } = require("../utils/fileHelpers");
// Issue #63 (доробка): назва матеріалу для заголовка демонстрації. Учні не
// отримують прихований матеріал у каталозі, тому клієнт не може сам знайти
// назву в /api/files — сервер віддає її у стані (лише назва, без доступу).
const fileService = require("./fileService");
// Issue #79: активні сигнали учням очищаються разом зі зупинкою показу
const signalService = require("./signalService");
// Issue #83: вказівник «поточне запитання» тестування оновлюється при зміні
// слайда показу; відповіді учнів при цьому не змінюються (див. testingService)
const testingService = require("./testingService");

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
    // Потрібно, щоб відрізнити: "демонстрація прихованого" (дозволено)
    // від "приховування матеріалу ПІД ЧАС показу" (заборонено для учнів).
    this.wasHiddenAtDemoStart = false;
    // Issue #83 (уточнення власника 11-11-2026): стан автоперегортання
    // «Вперед» для таймера учнів у смузі відповіді. seq зростає при кожному
    // оновленні — клієнт застосовує лише новий знімок (опитування /api/state
    // ~0,5 с не перезапускає локальний зворотний відлік). remainingMs — залишок
    // у момент публікації: учень ставить локальний дедлайн при ОТРИМАННІ, тому
    // синхронізація годинників між пристроями не потрібна (похибка ≤ затримка
    // опитування). Окремо від shared: публікація не чіпає ревізію стану.
    this.autoNext = { seq: 0, running: false, remainingMs: 0, totalMs: 0 };
  }

  getState() {
    const state = {
      ...this.shared,
      revision: this.revision
    };

    // Issue #83 (таймер учнів): знімок автоперегортання — частина стану,
    // яку опитують учні разом із демонстрацією (без окремого ендпоінту)
    state.autoNext = this.autoNext;

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
    // Issue #79: завершення демонстрації прибирає й активні сигнали — учні не
    // отримують сигнали, надіслані для показу, що вже завершився
    signalService.clearActive();
    // Issue #83 (таймер учнів): зупинка показу зупиняє й відлік автоперегортання
    this.autoNext = { seq: this.autoNext.seq + 1, running: false, remainingMs: 0, totalMs: 0 };
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

    // Issue #83 (таймер учнів): знімок автоперегортання публікується вчителем
    // окремо від керування показом — змінює ЛИШЕ autoNext: без ревізії стану
    // (інакше кожна фаза 15/30 с оновлювала б каталог учнів) і без syncSlide.
    if (data && data.autoNext !== undefined) {
      return this.updateAutoNext(data.autoNext);
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

    // Issue #83: файл і номер слайда вже оновлено — переносимо вказівник
    // «поточне запитання» тестування. Викликається на КОЖНЕ оновлення стану
    // (також для відео-синхронізації), сервіс сам ігнорує незмінений слайд.
    // Явна зупинка (stop) проходить іншим шляхом (stopShared) і вказівник
    // НЕ чіпає — результати останнього запитання мають лишитися доступними
    // вчителю (Issue #83 §5, §9).
    testingService.syncSlide(this.shared.file, this.shared.page);

    return { ok: true, revision: this.revision };
  }

  /**
   * Issue #83 (таймер учнів): оновлення стану автоперегортання «Вперед»
   * (POST /api/control { autoNext }). Валідація сувора: running — boolean;
   * для роботи — залишок ≥ 0 і тривалість > 0 у мс. Скидання (running:false)
   * завжди приймається. seq зростає при кожному прийнятті — клієнти
   * застосовують лише нові знімки.
   */
  updateAutoNext(payload) {
    const p = payload && typeof payload === "object" ? payload : null;
    if (!p || typeof p.running !== "boolean") {
      const error = new Error("Некоректний стан автоперегортання");
      error.status = 400;
      throw error;
    }
    const seq = this.autoNext.seq + 1;
    if (!p.running) {
      this.autoNext = { seq, running: false, remainingMs: 0, totalMs: 0 };
      return { ok: true, seq };
    }
    const remainingMs = Number(p.remainingMs);
    const totalMs = Number(p.totalMs);
    if (!Number.isFinite(remainingMs) || remainingMs < 0 ||
        !Number.isFinite(totalMs) || totalMs <= 0) {
      const error = new Error("Некоректний час автоперегортання");
      error.status = 400;
      throw error;
    }
    this.autoNext = {
      seq,
      running: true,
      remainingMs: Math.min(Math.round(remainingMs), 86400000),
      totalMs: Math.min(Math.round(totalMs), 86400000)
    };
    return { ok: true, seq };
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
      // Issue #79: матеріал показу зник/видалений — активні сигнали прибираємо
      signalService.clearActive();
      // Issue #83 (таймер учнів): матеріал зник — відлік автоперегортання теж
      this.autoNext = { seq: this.autoNext.seq + 1, running: false, remainingMs: 0, totalMs: 0 };
      this.revision++;
    }
  }

  /**
   * Issue #63 (доробка): чи є файл зараз АКТИВНО демонстрованим матеріалом.
   *
   * Використовується сервером для надання учням доступу ЛИШЕ до медіа того
   * матеріалу, який викладач демонструє в поточному сеансі. Перевірка виконується
   * при кожному запиті, тому:
   *  - після завершення показу (stopShared) доступ одразу зникає;
   *  - після перемикання показу на інший матеріал доступ до попереднього
   *    прихованого матеріалу теж припиняється.
   *
   * Читає стан через getState().
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

