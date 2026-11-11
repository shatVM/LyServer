/**
 * autoNext.js — Issue #83 (уточнення Tech-lead, коментар 6767853101):
 * вбудований модуль автоматичного натискання кнопки «Вперед» для послідовного
 * перегортання слайдів під час демонстрації.
 *
 * Розташування: панель (#autoNextPanel) — виключно всередині окремого блоку
 * «Тестування» (#testingBlock); на інших сторінках блока немає — модуль
 * нічого не робить. Якщо блок закрито/приховано — автоматичний режим
 * негайно зупиняється (MutationObserver + перевірка на кожному тіку).
 *
 * Перехід: реальний DOM-елемент кнопки «Вперед» і чинний обробник сайту
 * (navigateSlide). Пріоритет пошуку: data-auto-next → aria-label → текст
 * «Вперед»/«Далі» → #nextPage. Координати екрана, курсор і фізична емуляція
 * кліку не використовуються. Якщо кнопку не знайдено або вона недоступна —
 * жодних натискань, зрозуміле повідомлення й безпечна зупинка.
 *
 * Таймер: залишок рахується від Date.now() (дедлайн), оновлення 5 разів на
 * секунду (вимога ≥ 4/сек), без накопичення похибки; після повернення до
 * вкладки залишок перераховується, прострочений інтервал виконується один раз.
 *
 * Стани: ЗУПИНЕНО → ПРАЦЮЄ → ЗУПИНЕНО (СТОП або вихід із блоку). СТАРТ блокує
 * повторний запуск; СТОП очищає таймери й не виконує додаткових натискань.
 *
 * Ранній клік (уточнення власника 11-11-2026): коли ВСІ онлайн-учні відповіли
 * на поточне запитання активного тестування — «Вперед» натискається негайно,
 * не чекаючи інтервалу; інтервал після цього перезапускається за чергуванням
 * фаз. Спрацювання — один раз на запитання (прапорець firedKey), щоб повернення
 * на вже відповідне запитання не клацало поспіль. Діє ЛИШЕ за статусу
 * «ПРАЦЮЄ»; СТОП — повна зупинка, як і раніше.
 */
(function () {
  "use strict";

  // Захист від повторного завантаження: один екземпляр панелі й таймерів
  if (window.__autoNextLoaded) return;
  window.__autoNextLoaded = true;

  /** Період оновлення таймера, мс (5 разів/сек — вимога «щонайменше 4/сек») */
  const TICK_MS = 200;

  let running = false;
  let tickTimer = null;
  /** Дедлайн поточного інтервалу (Date.now() + мс) — джерело залишку часу */
  let deadline = 0;
  /** Який інтервал очікується зараз: 1 (30 с) або 2 (15 с) */
  let nextPhase = 1;
  /** Останні валідні значення — fallback, якщо поле редагують під час роботи */
  let lastValid1 = 30;
  let lastValid2 = 15;
  /** Ключ запитання ("file:page"), для якого уже спрацював ранній клік */
  let firedKey = "";

  function $(id) {
    return document.getElementById(id);
  }

  /** Блок «Тестування» видимий (наявний розмір на екрані) */
  function blockVisible() {
    const block = $("testingBlock");
    if (!block) return false;
    return block.getClientRects().length > 0;
  }

  /**
   * Стан тестування вчителя з app.js (глобальне `let testingState`).
   * Гард typeof/try: цей модуль виконується раніше за app.js (порядок скриптів
   * у розмітці), тож недоступне/TDZ-імені не має валити тік.
   */
  function readTeacherView() {
    try {
      return typeof testingState !== "undefined" ? testingState : null;
    } catch (e) {
      return null;
    }
  }

  /** Список присутніх учнів з app.js (глобальне `let lastStudentsList`) */
  function readStudentsList() {
    try {
      return typeof lastStudentsList !== "undefined" && Array.isArray(lastStudentsList)
        ? lastStudentsList
        : null;
    } catch (e) {
      return null;
    }
  }

  /** Ключ поточного запитання "file:page" — для прапорця одного спрацювання */
  function questionKeyOf(view) {
    return view && view.question
      ? String(view.question.file) + ":" + String(view.question.page)
      : "";
  }

  /**
   * Ранній клік (уточнення власника 11-11-2026): усі ОНЛАЙН-учні відповіли
   * на поточне запитання. Це перевірка КОЖНОГО онлайн-учня в `answers`
   * (hasOwnProperty за id), а не «рівність двох чисел»: відповіді учнів, які
   * стали офлайн, не виконують умову для тих, хто зараз онлайн. 0 онлайн-учнів
   * → false, щоб «0 = 0» не клацало миттєво. Лише активне тестування з
   * відкритим прийманням і наявним запитанням.
   */
  function allOnlineAnswered(view) {
    if (!view || view.status !== "active" || view.accepting !== true) return false;
    if (!view.question || !view.answers || typeof view.answers !== "object") return false;
    const list = readStudentsList();
    if (!list) return false;
    const online = list.filter((s) => s && s.online);
    if (!online.length) return false;
    return online.every((s) =>
      Object.prototype.hasOwnProperty.call(view.answers, String(s.id))
    );
  }

  /** Кнопка існує, видима, доступна й не заблокована */
  function isUsable(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (!el.getClientRects().length) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
      return false;
    }
    return true;
  }

  /** Пошук справжньої кнопки переходу «Вперед» за пріоритетом (§5 завдання) */
  function findNextButton() {
    let candidate = document.querySelector("[data-auto-next]");
    if (!candidate) {
      candidate = Array.prototype.find.call(
        document.querySelectorAll("button, [role='button']"),
        (el) => /^наступн/i.test((el.getAttribute("aria-label") || "").trim())
      );
    }
    if (!candidate) {
      candidate = Array.prototype.find.call(
        document.querySelectorAll("button"),
        (el) => /^(вперед|далі)/i.test((el.textContent || "").trim())
      );
    }
    // Погоджений селектор архітектури сайту: головна кнопка наступної сторінки
    if (!candidate) candidate = $("nextPage");
    return candidate && isUsable(candidate) ? candidate : null;
  }

  /**
   * Виконати один перехід через DOM-елемент і чинний обробник сайту.
   * @returns {boolean} false — кнопки немає/недоступна, режим зупинено
   */
  function pressNext() {
    const btn = findNextButton();
    if (!btn) {
      stopWith("Кнопку «Вперед» не знайдено або вона недоступна — автоматичне перегортання зупинено.");
      return false;
    }
    btn.click(); // реальний елемент і його onclick (navigateSlide) — без координат
    return true;
  }

  /** Сувора перевірка поля інтервалу: число більше за нуль (для СТАРТ) */
  function readStrict(id) {
    const input = $(id);
    if (!input) return null;
    const raw = String(input.value).trim();
    if (raw === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value;
  }

  /**
   * Значення інтервалу для планування НАСТУПНОГО переходу: валідне поле
   * оновлює lastValid; невалідне (редагують просто зараз) — не валить цикл,
   * береться останнє валідне. Поточний зворотний відлік не змінюється.
   */
  function readLenient(which) {
    const value = readStrict(which === 1 ? "autoNextInterval1" : "autoNextInterval2");
    if (value !== null) {
      if (which === 1) lastValid1 = value;
      else lastValid2 = value;
      return value;
    }
    return which === 1 ? lastValid1 : lastValid2;
  }

  /** Показ зворотного відліку mm:ss; поза роботою — 00:00 */
  function renderTimer() {
    const el = $("autoNextTimer");
    if (!el) return;
    if (!running) {
      el.textContent = "00:00";
      return;
    }
    const remainSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const mm = Math.floor(remainSec / 60);
    const ss = remainSec % 60;
    el.textContent = String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
  }

  function setStatus(text) {
    const el = $("autoNextStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-running", text === "ПРАЦЮЄ");
  }

  function setMessage(text) {
    const el = $("autoNextMessage");
    if (el) el.textContent = text || "";
  }

  /** СТАРТ заблоковано під час роботи (захист від подвійних натискань) */
  function renderButtons() {
    const startBtn = $("autoNextStartBtn");
    const stopBtn = $("autoNextStopBtn");
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  /** Запланувати поточний інтервал: значення читається ЗАРАЗ (тільки для наступного) */
  function schedulePhase() {
    deadline = Date.now() + readLenient(nextPhase) * 1000;
    renderTimer();
  }

  function tick() {
    if (!running) return;
    if (!blockVisible()) {
      stopWith("Блок «Тестування» закрито — автоматичне перегортання зупинено.");
      return;
    }
    const view = readTeacherView();
    // Тестування завершено/не активне — прапорець «раннього кліку» скидається:
    // нове опитування того самого слайда знову зможе спрацювати
    if (!view || view.status !== "active") firedKey = "";
    // Ранній клік: усі онлайн-учні відповіли — не чекаємо інтервалу
    if (allOnlineAnswered(view)) {
      const key = questionKeyOf(view);
      if (key && key !== firedKey) {
        firedKey = key;
        nextPhase = nextPhase === 1 ? 2 : 1;
        if (!pressNext()) return; // stopWith уже викликано
        schedulePhase();
        return;
      }
    }
    if (Date.now() >= deadline) {
      // Чергування: після вичерпання інтервалу 1 — інтервал 2, і навпаки
      nextPhase = nextPhase === 1 ? 2 : 1;
      if (!pressNext()) return; // stopWith уже викликано
      schedulePhase();
    } else {
      renderTimer();
    }
  }

  /** Спільна зупинка: таймери, 00:00, «ЗУПИНЕНО», дозвіл СТАРТ, повідомлення */
  function stopWith(message) {
    running = false;
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    deadline = 0;
    renderTimer();
    setStatus("ЗУПИНЕНО");
    renderButtons();
    setMessage(message || "");
  }

  function start() {
    if (running) return; // повторний СТАРТ ігнорується
    const one = readStrict("autoNextInterval1");
    const two = readStrict("autoNextInterval2");
    if (one === null || two === null) {
      setMessage("Введіть числові значення інтервалів, більші за нуль (обидва поля).");
      return; // без переходів, статус лишається «ЗУПИНЕНО»
    }
    if (!blockVisible()) {
      setMessage("Блок «Тестування» недоступний — автоперегортання не запущено.");
      return;
    }
    if (!findNextButton()) {
      setMessage("Кнопку «Вперед» не знайдено або вона недоступна — автоперегортання не запущено.");
      return;
    }
    lastValid1 = one;
    lastValid2 = two;
    setMessage("");
    running = true;
    setStatus("ПРАЦЮЄ");
    renderButtons();
    nextPhase = 1;
    firedKey = ""; // свіжий запуск — ранній клік може спрацювати на будь-якому запитанні
    if (!pressNext()) return; // без кнопки stopWith уже зупинив режим
    schedulePhase(); // одразу перший інтервал (30 с за замовчуванням)
    tickTimer = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (!running) return;
    stopWith(""); // СТОП: без повідомлення — просто повна зупинка
  }

  // Повернення до вкладки: залишок перераховується від Date.now(); якщо
  // інтервал прострочився у фоні (обмеження браузерних таймерів) — один
  // перехід одразу, без наверстування всіх пропущених
  document.addEventListener("visibilitychange", () => {
    if (!running || document.visibilityState === "hidden") return;
    tick();
  });

  // Перехід на іншу сторінку або закриття вкладки — негайна зупинка
  window.addEventListener("pagehide", () => {
    if (running) stopWith("");
  });

  /** Негайна зупинка, коли блок «Тестування» закрили/приховали (style/class) */
  function observeBlock() {
    const block = $("testingBlock");
    if (!block || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (running && !blockVisible()) {
        stopWith("Блок «Тестування» закрито — автоматичне перегортання зупинено.");
      }
    });
    observer.observe(block, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
  }

  function init() {
    if (!$("autoNextPanel")) return; // на цій сторінці блока «Тестування» немає
    const startBtn = $("autoNextStartBtn");
    const stopBtn = $("autoNextStopBtn");
    if (startBtn) startBtn.addEventListener("click", start);
    if (stopBtn) stopBtn.addEventListener("click", stop);
    observeBlock();
    renderTimer();
    setStatus("ЗУПИНЕНО");
    renderButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
