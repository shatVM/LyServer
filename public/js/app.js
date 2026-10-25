const $ = id => document.getElementById(id);

// Role & Session PIN management
let role = localStorage.getItem("portalRole") || "";
let pin = sessionStorage.getItem("portalPin") || "";
let files = [];
let categories = [];

// Issue #63 Етап 3: черга не залежить від DOM-поля file input.
let uploadQueueState = [];
let uploadQueueNextId = 1;
let uploadInProgress = false;

// Student identity (stored in localStorage)
let studentId = localStorage.getItem("portalStudentId") || "";
let studentDisplayName = localStorage.getItem("portalStudentName") || "";

// Local viewer state (Materials page)
let localCurrentFile = "";
let localPageNum = 1;
let localPageCount = 1;

// Shared demo state
let lastRevision = -1;
// Issue #63 (Етап 4): окремий лічильник ревізії для оновлення КАТАЛОГУ.
// lastRevision не оновлюється, коли демо не активне (там pollState завершується
// раніше), тож використовувати його для каталогу означало б перечитування
// /api/files що 0.5 с. Тут фіксуємо лише ревізії, які уже обробили.
let lastCatalogRevision = -1;
let sharedState = null;
let lastVideoUpdate = 0;
let videoElement = null;
let applyingRemote = false;

// Issue #63: режим сторінки «Перегляд матеріалів» (одна сторінка учня).
// Визначається за СЕРВЕРНИМ станом демонстрації (/api/state), а не за
// локальним станом браузера: true — триває спільна демонстрація вчителя,
// вибір матеріалів/категорій і самостійна навігація вимкнені.
let materialsDemoActive = false;

// Current slide page count in demo
let demoPageCount = 1;

// Issue #61: файл, для якого вже показано початкову підказку навігації (демонстрація)
let sharedNavHintFile = null;

// Determine current page type
const isDemoPage = Boolean(window.location.pathname.includes("demonstration"));
const isUploadPage = Boolean(window.location.pathname.includes("upload"));
const isStudentsPage = Boolean(window.location.pathname.includes("students"));
const isMaterialsPage = Boolean(!isDemoPage && !isUploadPage && !isStudentsPage);

// Extensions treated as slides (PNG images, not iframes or video)
const SLIDE_EXTS = new Set([".pdf", ".ppt", ".pptx"]);

function setStatus(text) {
  if ($("status")) $("status").textContent = text;
}

// Issue #63, Етап 2: статус блоку завантаження «Додати матеріали».
// На сторінці «Демонстрація» спільний #status оновлює опитування демонстрації,
// тому повідомлення завантаження йдуть у власний контейнер #uploadStatus;
// на інших сторінках (де його немає) — у чинний #status, як раніше.
function setUploadStatus(text) {
  if ($("uploadStatus")) $("uploadStatus").textContent = text;
  else setStatus(text);
}

// ---------------------------------------------------------------------------
// Toast notifications (for teacher disconnect alerts)
// ---------------------------------------------------------------------------
function showToast(message, type = "info", duration = 5000) {
  const container = $("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast toast-" + type;
  toast.textContent = message;
  container.appendChild(toast);
  // Animate in
  requestAnimationFrame(() => toast.classList.add("toast-show"));
  // Auto remove
  setTimeout(() => {
    toast.classList.remove("toast-show");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, duration);
}

// ---------------------------------------------------------------------------
// Presence (student heartbeat)
// ---------------------------------------------------------------------------

/** Generate a stable random student ID if not already created */
function ensureStudentId() {
  if (!studentId) {
    studentId = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem("portalStudentId", studentId);
  }
  return studentId;
}

/** Send presence heartbeat to server */
async function sendHeartbeat(activeOverride) {
  if (role !== "student" || !studentDisplayName) return;
  const active = activeOverride !== undefined
    ? activeOverride
    : document.visibilityState !== "hidden";
  try {
    await fetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: ensureStudentId(), name: studentDisplayName, active })
    });
  } catch { /* silent */ }
}

let heartbeatTimer = null;

/** Старт heartbeat учня (перший виклик у setRole), далі — за інтервалом */
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => sendHeartbeat(), HEARTBEAT_MS);
}

/** Зупинка heartbeat (роль не «учень» або вихід) */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Негайно повідомити сервер про зміну активності сеансу (Issue #7).
 * sendBeacon працює навіть під час закриття вкладки / засинання пристрою.
 */
function reportActivityChange(active) {
  if (role !== "student" || !studentDisplayName) return;
  const payload = new URLSearchParams({
    studentId: ensureStudentId(),
    name: studentDisplayName,
    active: String(active)
  });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/presence/heartbeat", payload);
      return;
    }
  } catch { /* fallback нижче */ }
  sendHeartbeat(active);
}

// ---------------------------------------------------------------------------
// Teacher heartbeat (Issue #63: вихід учителя зупиняє демонстрацію)
// ---------------------------------------------------------------------------

/**
 * Heartbeat викладача: сервер бачить, що вчитель у сесії. Якщо вчитель
 * виходить (закрив вкладку, «Вийти», втрата зв'язку) — heartbeat зникає і
 * сервер сам зупиняє активну демонстрацію, щоб учні не застрягали в режимі
 * показу без керування (див. stateService.getState).
 */
async function sendTeacherHeartbeat() {
  if (role !== "teacher" || !pin) return;
  try {
    await fetch("/api/presence/teacher", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Portal-Pin": pin },
      body: JSON.stringify({})
    });
  } catch { /* silent */ }
}

let teacherHeartbeatTimer = null;

/** Старт heartbeat викладача (вхід або перезавантаження сторінки) */
function startTeacherHeartbeat() {
  if (teacherHeartbeatTimer) clearInterval(teacherHeartbeatTimer);
  sendTeacherHeartbeat();
  teacherHeartbeatTimer = setInterval(sendTeacherHeartbeat, HEARTBEAT_MS);
}

/** Зупинка heartbeat викладача (вихід із ролі) */
function stopTeacherHeartbeat() {
  if (teacherHeartbeatTimer) {
    clearInterval(teacherHeartbeatTimer);
    teacherHeartbeatTimer = null;
  }
}

/**
 * Закриття вкладки викладачем (pagehide): sendBeacon несе PIN у тілі, бо не
 * дозволяє заголовки; якщо показ активний — сервер зупиняє його одразу.
 * Якщо beacon не дійде, сервер доб'є тайм-аутом присутності викладача.
 */
function reportTeacherLeave() {
  if (role !== "teacher" || !pin) return;
  const body = JSON.stringify({ pin, stop: true });
  try {
    if (navigator.sendBeacon &&
        navigator.sendBeacon("/api/control", new Blob([body], { type: "application/json" }))) {
      return;
    }
  } catch { /* fallback нижче */ }
  fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Presence polling for teacher (Issue #7)
// ---------------------------------------------------------------------------
let prevPresence = {};

// Миттєве оновлення статусу (Issue #19): викладач опитує список щосекунди,
// учень шле heartbeat кожні 2 с; миттєві канали (visibilitychange + sendBeacon)
// збережено. Разом із TIMEOUT_MS у presenceService це дає оновлення ≤ ~1 с
// при появі/поверненні учня та ≤ ~7 с при втраті зв'язку.
const PRESENCE_POLL_MS = 1000;
const HEARTBEAT_MS = 2000;
const DEMO_STATE_POLL_MS = 500;

let presenceTimer = null;

/** Старт опитування присутності: перший запит одразу, далі — за інтервалом */
function startPresencePolling() {
  if (presenceTimer) clearInterval(presenceTimer);
  pollPresence();
  presenceTimer = setInterval(pollPresence, PRESENCE_POLL_MS);
}

/** Зупинка опитування (роль не «викладач» або вихід викладача) */
function stopPresencePolling() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
}

/** Опитування списку присутності викладачем: тости про неактивних учнів */
async function pollPresence() {
  if (role !== "teacher") return;
  try {
    const headers = {};
    if (pin) headers["X-Portal-Pin"] = pin;
    const response = await api("/api/presence/students", { headers });
    const list = await response.json();

    const prev = prevPresence;
    const next = {};
    for (const s of list) next[s.id] = s;

    // Тости лише за наявності попереднього стану (щоб не спамити при старті)
    for (const s of list) {
      const before = prev[s.id];
      if (!before) continue;
      if (before.online && !s.online) {
        showToast("⚠️ Учень «" + s.name + "»: сеанс неактивний", "warning", 8000);
      } else if (!before.online && s.online) {
        showToast("✅ Учень «" + s.name + "» повернувся", "success");
      }
    }
    prevPresence = next;

    renderStudentsList(list);
  } catch { /* silent */ }
}

/** Рендер списку учнів у усіх контейнерах .js-students-list
 *  (сторінка «Учні» та блоки Issue #19 на сторінках «Демонстрація»
 *  і «Перегляд матеріалів»). Логіка присутності не змінюється —
 *  змінюється лише кількість місць, куди виводиться той самий список. */
function renderStudentsList(list) {
  const containers = document.querySelectorAll(".js-students-list");
  if (!containers.length) return;

  const onlineCount = list.filter(s => s.online).length;
  const counterText = "● " + onlineCount + " з " + list.length + " онлайн";
  document.querySelectorAll(".js-students-online-count").forEach(el => {
    el.style.display = list.length ? "" : "none";
    el.textContent = counterText;
  });

  for (const root of containers) {
    root.replaceChildren();
    if (!list.length) {
      root.innerHTML = '<div class="empty">Ще ніхто не підключився. Нехай учні вкажуть своє прізвище та ім\'я при вході.</div>';
      continue;
    }

    for (const s of list) {
      const item = document.createElement("div");
      item.className = "student-row" + (s.online ? "" : " student-offline");
      const badgeClass = s.online ? "badge-online" : "badge-offline";
      const badgeText = s.online ? "● Онлайн" : "○ Неактивний";
      item.innerHTML =
        '<span class="student-name">' + esc(s.name) + "</span>" +
        '<span class="badge ' + badgeClass + '">' + badgeText + "</span>";
      root.append(item);
    }
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || ("HTTP " + response.status));
  }
  return response;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function iconSvg(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("ui-icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "/icons.svg#" + name);
  svg.append(use);
  return svg;
}

/**
 * Issue #63 (Етап 4): кнопка дії над матеріалом — іконка + підпис (.btn-label).
 * На мобільному підпис ховається CSS-ом (лише іконки), тому НАЗВА дії завжди
 * продубльована в aria-label/title: кнопка лишається зрозумілою для клавіатури
 * та скринрідера і має достатній розмір натискання (див. .file-actions у CSS).
 */
function actionButton(className, iconName, labelText, title, ariaLabel, onclick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  if (iconName) btn.append(iconSvg(iconName));
  if (labelText) {
    const label = document.createElement("span");
    label.className = "btn-label";
    label.textContent = labelText;
    btn.append(label);
  }
  if (title) btn.title = title;
  if (ariaLabel) btn.setAttribute("aria-label", ariaLabel);
  btn.onclick = onclick;
  return btn;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

function fileUrl(name) {
  // Issue #63 (доробка): PIN більше НЕ передається у URL медіа (?pin= потрапляв
  // в історію браузера при відкритті зображення в новій вкладці, у журнали
  // звернень і в адресний рядок). Замість цього викладач отримує HttpOnly
  // медіа-cookie при вході (POST /api/auth/verify), і браузер сам додає її до
  // <img>/<video>/слайдів — у мережевих запитах URL лишається чистим.
  // API-запити, як і раніше, авторизуються заголовком X-Portal-Pin.
  return "/files/" + encodeURIComponent(name);
}

function slideUrl(name, page) {
  // Issue #63 (доробка): див. fileUrl — медіа-доступ через cookie, без ?pin= у URL
  return "/slides/" + encodeURIComponent(name) + "/" + page;
}

function extOf(name) {
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function isSlideType(name) {
  return SLIDE_EXTS.has(extOf(name));
}

// ---------------------------------------------------------------------------
// Slide viewer helpers
// ---------------------------------------------------------------------------

/** Show a single slide image in #viewer */
function renderSlideImage(name, page, totalPages, ctx) {
  // Issue #63 (§3.3): ctx — цільовий контейнер для модального приватного
  // прев'ю; без контейнера працює як раніше (спільний/локальний #viewer)
  const viewer = (ctx && ctx.viewer) || $("viewer");
  if (!viewer) return;

  // Update page label
  const labelEl = ctx && ctx.label !== undefined ? ctx.label : $("pageLabel");
  if (labelEl) {
    const ext = extOf(name).toUpperCase();
    labelEl.textContent = ext.slice(1) + ": слайд " + page + " / " + totalPages;
  }
  // Issue #9: поле номера слайду синхронізується з поточним сторінкою
  const inputEl = ctx && ctx.input !== undefined ? ctx.input : $("pageInput");
  if (inputEl) inputEl.value = page;

  // Build or reuse <img>
  let img = viewer.querySelector("img.slide-img");
  if (!img) {
    viewer.replaceChildren();
    img = document.createElement("img");
    img.className = "slide-img";
    img.alt = "Слайд " + page;
    viewer.appendChild(img);
  }

  img.alt = "Слайд " + page;
  // Cache-bust під час конвертації: параметр t додаємо через ? або & залежно
  // від наявності query (медіа-доступ тепер через cookie, а не через pin у URL)
  const slideSrc = slideUrl(name, page);
  img.src = slideSrc + (slideSrc.includes("?") ? "&" : "?") + "t=" + Date.now();

  // Show loading overlay only when first loaded
  img.onload = () => {};
  img.onerror = () => {
    viewer.innerHTML = '<div class="empty">⚠️ Помилка завантаження зображення слайду ' + page + '</div>';
  };

  // Issue #61: активні зони лівої/правої половини зображення (ліва — назад, права — уперед).
  // Модальне прев'ю передає власний обробник (onZoneStep), щоб приватна
  // навігація НЕ змінювала спільний стан демонстрації (§3.3)
  const zoneAllowed = ctx && ctx.zoneAllowed !== undefined ? ctx.zoneAllowed : slideNavAllowed();
  if (zoneAllowed) ensureSlideZones(viewer, ctx && ctx.onZoneStep);
}

/**
 * Prepare slides on the server (conversion) and then display the first slide.
 * Shows a progress indicator while converting.
 */
async function prepareAndShowSlides(name, page, onReady, target) {
  // Issue #63 (§3.3): target — контейнер модального приватного прев'ю;
  // за замовчуванням, як і раніше, — спільний/локальний #viewer
  const viewer = target || $("viewer");
  if (viewer) {
    viewer.innerHTML = '<div class="empty slide-loading">🔄 Конвертація слайдів… Зачекайте, будь ласка.</div>';
  }

  try {
    let pageCount = null;
    if (role === "teacher") {
      // Викладач може явно запустити конвертацію (Issue #2: prepare — тільки для викладача)
      // Issue #63 (§3.3): /api/slides/prepare вимагає PIN (Issue #8) — без заголовка
      // сервер відповідав 403 і приватний перегляд слайдів показував помилку
      const res = await api("/api/slides/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Portal-Pin": pin },
        body: JSON.stringify({ file: name })
      });
      pageCount = (await res.json()).pageCount;
    } else {
      // Учень: перший запит PNG сам запускає конвертацію на сервері,
      // усі клієнти чекають одну конвертацію (спільний lock, Issue #3)
      const probe = await fetch(slideUrl(name, page));
      if (!probe.ok) throw new Error(await probe.text());
      const infoRes = await fetch("/api/slides/info?file=" + encodeURIComponent(name));
      if (infoRes.ok) {
        const info = await infoRes.json();
        if (info.ready) pageCount = info.pageCount;
      }
    }
    onReady(pageCount || 1);
  } catch (e) {
    if (viewer) {
      viewer.innerHTML = '<div class="empty">❌ Помилка конвертації: ' + esc(e.message) + '</div>';
    }
  }
}

// ---------------------------------------------------------------------------
// Issue #61: навігація слайдами натисканням на ліву/праву зону зображення
// ---------------------------------------------------------------------------

const ARROW_SVG = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="15 5 8 12 15 19"></polyline></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="9 5 16 12 9 19"></polyline></svg>'
};

/** Issue #61: чи дозволено цьому клієнту перемикати слайди зонами */
function slideNavAllowed() {
  // Синхронізована демонстрація: спільний слайд змінює лише викладач (чинні правила)
  if (isDemoPage) return role === "teacher";
  // Issue #63: на сторінці перегляду в режимі спільної демонстрації — аналогічно:
  // учень лише спостерігає, позицію задає викладач через серверний стан
  if (isMaterialsPage && materialsDemoActive) return role === "teacher";
  return true; // самостійний перегляд — локальна навігація
}

/** Issue #61: єдиний шлях перемикання — та сама логіка, що й у кнопок «← / →» */
function navigateSlide(delta) {
  if (isDemoPage) changeSharedPage(delta);
  else stepLocalPage(delta);
}

/** Issue #61: початкова підказка — обидві стрілки добре помітні до першої взаємодії */
function setSlideNavHint(on) {
  const viewer = $("viewer");
  if (viewer) viewer.classList.toggle("nav-hint", Boolean(on));
}

/**
 * Issue #61: активні зони лівої/правої половини зображення (без текстових підписів).
 * Створюються один раз на контент глядача — обробники подій не дублюються.
 */
function ensureSlideZones(viewer, onStep) {
  if (!viewer || viewer.querySelector(".slide-zone")) return;

  ["prev", "next"].forEach(side => {
    const zone = document.createElement("button");
    zone.type = "button";
    // Класи позиціювання: .slide-zone-left (ліва половина) / .slide-zone-right (права)
    zone.className = "slide-zone slide-zone-" + (side === "prev" ? "left" : "right");
    zone.dataset.side = side;
    zone.setAttribute("aria-label", side === "prev" ? "Попередній слайд" : "Наступний слайд");
    // Лише стрілка (SVG), жодних видимих підписів
    zone.innerHTML = ARROW_SVG[side];

    // Торкання не має блокувати вертикальне прокручування та жести браузера:
    // якщо палець змістився більше ніж на 10 px — це прокручування, а не натискання
    let touchStartY = null;
    let touchScrolled = false;
    zone.addEventListener("touchstart", e => {
      touchStartY = e.touches[0] ? e.touches[0].clientY : null;
      touchScrolled = false;
    }, { passive: true });
    zone.addEventListener("touchmove", e => {
      if (touchStartY === null || !e.touches[0]) return;
      if (Math.abs(e.touches[0].clientY - touchStartY) > 10) touchScrolled = true;
    }, { passive: true });

    // Короткочасне підсвічування зони: дотик на телефоні чи натискання мишею
    zone.addEventListener("pointerdown", () => zone.classList.add("is-active"));
    const clearActive = () => setTimeout(() => zone.classList.remove("is-active"), 220);
    zone.addEventListener("pointerup", clearActive);
    zone.addEventListener("pointercancel", clearActive);
    zone.addEventListener("pointerleave", clearActive);

    zone.addEventListener("click", () => {
      if (touchScrolled) return;                 // було прокручування, а не натискання
      // Модальне прев'ю (onStep) завжди навігує лише свій контейнер; без
      // обробника — чинне правило: учень на демонстрації не змінює спільний слайд
      if (!onStep && !slideNavAllowed()) return;
      viewer.classList.remove("nav-hint");
      const delta = side === "prev" ? -1 : 1;
      if (onStep) onStep(delta); else navigateSlide(delta); // на межах перемикання не відбувається (кламп)
    });

    viewer.appendChild(zone);
  });
}

// ---------------------------------------------------------------------------
// Role Management & Modal
// ---------------------------------------------------------------------------
function updateRoleUI() {
  const isTeacher = role === "teacher";
  const isStudent = role === "student";

  // Role label shows name for students
  if ($("roleLabel")) {
    if (isTeacher) $("roleLabel").textContent = "🎓 Викладач";
    else if (isStudent && studentDisplayName) $("roleLabel").textContent = "👤 " + studentDisplayName;
    else $("roleLabel").textContent = "👤 Учень";
  }
  if ($("btnSwitchRole")) {
    $("btnSwitchRole").textContent = isTeacher ? "🚪 Вийти" : (isStudent ? "🔄 Змінити" : "🔑 Увійти");
    $("btnSwitchRole").title = isTeacher ? "Вийти з режиму викладача" : "Змінити роль або ім'я";
  }

  document.querySelectorAll(".teacher-only").forEach(el => {
    el.style.display = isTeacher ? "" : "none";
  });

  // Issue #63 (§3): єдиний робочий простір вчителя — «Демонстрація» (перегляд,
  // додавання та учні об'єднані там). Пункти цих розділів у навігації ховаються
  // ЛИШЕ для вчителя; самі сторінки за прямим URL працюють без змін, тому
  // функціональність не втрачається (див. DECISIONS.md).
  if (isTeacher) {
    if ($("navMaterialsLink")) $("navMaterialsLink").style.display = "none";
    if ($("navUploadLink")) $("navUploadLink").style.display = "none";
    if ($("navStudentsLink")) $("navStudentsLink").style.display = "none";
  } else if ($("navMaterialsLink")) {
    $("navMaterialsLink").style.display = ""; // повернути після виходу з ролі вчителя
  }

  if (isUploadPage) {
    if ($("studentUploadBlock")) $("studentUploadBlock").style.display = isTeacher ? "none" : "block";
    if ($("teacherUploadBlock")) $("teacherUploadBlock").style.display = isTeacher ? "grid" : "none";
  }

  if (isDemoPage) {
    if ($("teacherDemoControls")) $("teacherDemoControls").style.display = isTeacher ? "flex" : "none";
    if ($("teacherBroadcastPanel")) $("teacherBroadcastPanel").style.display = isTeacher ? "block" : "none";
    if ($("demoGridContainer")) {
      $("demoGridContainer").classList.toggle("student-demo-layout", !isTeacher);
    }
    // Issue #61: на спільному слайді зони навігації — лише в і викладача;
    // після зміні ролі наявні зони у не-викладача прибираються
    if (!isTeacher) document.querySelectorAll(".slide-zone").forEach(z => z.remove());
  }

  if (isMaterialsPage) {
    // Issue #63: викладач не спостерігає за демонстрацією на цій сторінці —
    // після входу з ролі учня повертаємо каталог і локальний перегляд
    if (isTeacher && materialsDemoActive) setMaterialsDemoMode(false, sharedState || {});
    if ($("materialsSubtitle") && !materialsDemoActive) {
      $("materialsSubtitle").textContent = isTeacher
        ? "Каталог навчальних матеріалів. Ви можете відкривати, транслювати, приховувати та видаляти файли."
        : "Оберіть матеріал для індивідуального вивчення. Особистий перегляд не впливає на інших учасників.";
    }
  }
}

function openRoleModal() {
  if ($("roleModal")) {
    $("roleModal").style.display = "flex";
    if ($("modalPinError")) $("modalPinError").style.display = "none";
    if ($("modalTeacherPin")) $("modalTeacherPin").value = "";
    if ($("modalStudentError")) $("modalStudentError").style.display = "none";
    // Pre-fill full name if already set (Issue #6: одне поле для ПІБ)
    if ($("modalStudentName")) $("modalStudentName").value = studentDisplayName || "";
  }
}

function closeRoleModal() {
  if ($("roleModal")) $("roleModal").style.display = "none";
}

function setRole(newRole, newPin = "", newName = "") {
  const prevRole = role;
  role = newRole;
  localStorage.setItem("portalRole", newRole);
  // Issue #63 (доробка): вихід викладача або перехід на роль учня скасовує
  // HttpOnly медіа-cookie — інакше в цьому браузері лишився б доступ до
  // прихованих медіафайлів після завершення сеансу викладача
  if (prevRole === "teacher" && newRole !== "teacher") {
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }
  if (newRole === "teacher") {
    pin = newPin;
    sessionStorage.setItem("portalPin", newPin);
    studentDisplayName = "";
  } else if (newRole === "student") {
    pin = "";
    sessionStorage.removeItem("portalPin");
    if (newName) {
      studentDisplayName = newName;
      localStorage.setItem("portalStudentName", newName);
      ensureStudentId();
      // Send first heartbeat immediately
      sendHeartbeat();
    }
  } else {
    // logout. Вихід учителя (Issue #63): одразу зупинити спільну демонстрацію,
    // поки є PIN, — інакше учні застрягають у режимі показу без керування.
    // Якщо запит не дійде, сервер доб'є тайм-аутом присутності викладача.
    if (prevRole === "teacher") {
      fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, stop: true })
      }).catch(() => {});
    }
    pin = "";
    sessionStorage.removeItem("portalPin");
    studentDisplayName = "";
    localStorage.removeItem("portalStudentName");
    localStorage.removeItem("portalStudentId");
    studentId = "";
  }
  closeRoleModal();
  updateRoleUI();
  filesReady = refreshFiles();
  // Миттєвий старт опитування, якщо увійшли як викладач у поточній сесії
  // (раніше список оновлювався лише після перезавантаження сторінки)
  if (newRole === "teacher") {
    startPresencePolling();
    startTeacherHeartbeat();
  } else {
    stopPresencePolling();
    stopTeacherHeartbeat();
  }
  // Симетрично: учень, який увійшов у поточній сесії, шле heartbeat одразу
  if (newRole === "student" && studentDisplayName) startHeartbeat();
  else stopHeartbeat();
  // Issue #63: сторінка перегляду одразу дізнається серверний стан демонстрації
  // (режим «спостереження» або каталог) — не чекаючи чергового інтервалу
  if (isMaterialsPage && newRole !== "teacher") filesReady.finally(() => pollState(true));
}

// Issue #6: одне поле для прізвища та імені
const NAME_PART_RE = /^[А-Яа-яЄєІіЇїҐґA-Za-z'’\-]+$/;

// Student login button
if ($("btnChooseStudent")) {
  $("btnChooseStudent").onclick = () => {
    const fullName = ($("modalStudentName") ? $("modalStudentName").value.trim() : "");
    const parts = fullName.split(/\s+/).filter(Boolean);
    const valid = parts.length >= 2 && parts.length <= 4 && parts.every(p => NAME_PART_RE.test(p));
    if (!valid) {
      if ($("modalStudentError")) {
        $("modalStudentError").textContent = "Введіть прізвище та ім'я (2-4 слова, літери, дефіс або апостроф). Напр. Коваленко Олена";
        $("modalStudentError").style.display = "block";
      }
      return;
    }
    setRole("student", "", parts.join(" "));
  };
}

// Enter key in student name field
["modalStudentName"].forEach(id => {
  if ($(id)) {
    $(id).addEventListener("keydown", e => {
      if (e.key === "Enter") $("btnChooseStudent").click();
    });
  }
});

if ($("btnChooseTeacher")) {
  $("btnChooseTeacher").onclick = async () => {
    const inputPin = $("modalTeacherPin") ? $("modalTeacherPin").value.trim() : "";
    if (!inputPin) {
      if ($("modalPinError")) { $("modalPinError").textContent = "Будь ласка, введіть PIN."; $("modalPinError").style.display = "block"; }
      return;
    }
    try {
      await api("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: inputPin })
      });
      setRole("teacher", inputPin);
    } catch {
      if ($("modalPinError")) { $("modalPinError").textContent = "Невірний PIN викладача."; $("modalPinError").style.display = "block"; }
    }
  };
}

if ($("modalTeacherPin")) {
  $("modalTeacherPin").addEventListener("keydown", e => {
    if (e.key === "Enter") $("btnChooseTeacher").click();
  });
}

if ($("btnSwitchRole")) {
  $("btnSwitchRole").onclick = () => {
    if (role === "teacher") { setRole(""); } else { openRoleModal(); }
  };
}

if ($("btnPromptTeacherLogin")) {
  $("btnPromptTeacherLogin").onclick = openRoleModal;
}

// ---------------------------------------------------------------------------
// Files list
// ---------------------------------------------------------------------------
async function refreshFiles() {
  try {
    const headers = {};
    if (pin && role === "teacher") headers["X-Portal-Pin"] = pin;
    const response = await api("/api/files", { headers });
    files = await response.json();
    // Issue #63 Р: список категорій читається публічно (GET /api/categories) —
    // учні групують каталог за категоріями, як і викладач
    try {
      const categoryResponse = await api("/api/categories");
      categories = (await categoryResponse.json()) || [];
    } catch {
      categories = [];
    }
    updateUploadCategoryOptions();
    if ($("files")) renderFiles();
    if (isMaterialsPage) setStatus("Каталог доступний. Матеріалів: " + files.length + ".");
    else if (isUploadPage) setStatus("Файлів на сервері: " + files.length + ".");
  } catch (error) {
    if ($("files")) setStatus("Помилка завантаження файлів: " + error.message);
  }
}

function updateUploadCategoryOptions() {
  const select = $("uploadCategory");
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const uncategorized = document.createElement("option");
  uncategorized.value = "";
  uncategorized.textContent = "Без категорії";
  select.append(uncategorized);
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.name;
    select.append(option);
  }
  if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
}

async function createCategory() {
  if (!pin || role !== "teacher") { setStatus("Необхідно увійти як викладач."); return; }
  const name = window.prompt("Назва нової категорії:");
  if (name === null) return;
  try {
    await api("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, name })
    });
    await refreshFiles();
    const created = categories.find(category => category.name.toLocaleLowerCase("uk") === name.trim().toLocaleLowerCase("uk"));
    if (created && $("uploadCategory")) $("uploadCategory").value = created.id;
    setStatus("Категорію створено: " + name.trim());
  } catch (error) { alert("Не вдалося створити категорію: " + error.message); }
}

async function deleteCategory(category) {
  if (!pin || role !== "teacher") { alert("Потрібен PIN викладача."); return; }
  if (!confirm("Видалити категорію «" + category.name + "»? Матеріали залишаться на сервері та перейдуть у «Без категорії».")) return;
  try {
    const result = await api("/api/categories/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, categoryId: category.id })
    });
    await refreshFiles();
    setStatus("Категорію видалено. Матеріалів збережено: " + (result.affectedFiles || 0) + ".");
  } catch (error) { alert("Не вдалося видалити категорію: " + error.message); }
}

async function setFileCategory(fileId, categoryId) {
  try {
    await api("/api/files/category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, file: fileId, categoryId })
    });
    await refreshFiles();
  } catch (error) { alert("Не вдалося перемістити матеріал: " + error.message); }
}

// Issue #63 (§3.1): перейменування категорії — зберігає id, порядок і склад
async function renameCategory(category) {
  if (!pin || role !== "teacher") { alert("Потрібен PIN викладача."); return; }
  const name = window.prompt("Нова назва категорії:", category.name);
  if (name === null) return;
  if (!name.trim()) { alert("Назва категорії не може бути порожньою."); return; }
  try {
    await api("/api/categories/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, categoryId: category.id, name: name.trim() })
    });
    await refreshFiles();
    setStatus("Категорію перейменовано: «" + name.trim() + "».");
  } catch (error) { alert("Не вдалося перейменувати категорію: " + error.message); }
}

// Issue #63 (§3.1): переміщення категорії вгору/вниз — порядок на сервері
async function reorderCategory(category, direction) {
  if (!pin || role !== "teacher") { alert("Потрібен PIN викладача."); return; }
  try {
    await api("/api/categories/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, categoryId: category.id, direction })
    });
    await refreshFiles();
  } catch (error) { alert("Не вдалося змінити порядок категорій: " + error.message); }
}

// Issue #63 (§3.2): перейменування матеріалу — лише показна назва на сервері
async function renameMaterial(fileId, currentName) {
  if (!pin || role !== "teacher") { alert("Потрібен PIN викладача."); return; }
  const name = window.prompt("Нова назва матеріалу:", currentName);
  if (name === null) return;
  if (!name.trim()) { alert("Назва матеріалу не може бути порожньою."); return; }
  try {
    await api("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, file: fileId, name: name.trim() })
    });
    await refreshFiles();
    setStatus("Матеріал перейменовано: «" + name.trim() + "».");
  } catch (error) { alert("Не вдалося перейменувати матеріал: " + error.message); }
}

async function reorderMaterial(fileId, direction) {
  try {
    await api("/api/files/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, file: fileId, direction })
    });
    await refreshFiles();
  } catch (error) { alert("Не вдалося змінити порядок: " + error.message); }
}

async function retrySlideConversion(fileId) {
  try {
    const manifest = await prepareSlidesBg(fileId);
    setStatus("PNG-слайди готові: " + manifest.pageCount + " стор.");
    await refreshFiles();
  } catch (error) {
    setStatus("Помилка конвертації «" + fileId + "»: " + error.message);
    await refreshFiles();
  }
}

function createFileCard(file, isTeacher, showCategoryActions) {
  const item = document.createElement("div");
  item.className = "file" + (file.hidden ? " file-is-hidden" : "");
  const info = document.createElement("div");
  info.className = "file-info";
  // Issue #63 (Етап 4): видима текстова мітка «Приховано» прибрана — прихований
  // стан позначається насиченим червоним оформленням картки (.file-is-hidden).
  // Для скринрідера стан дублюється службовим текстом, щоб не покладатися лише
  // на колір; видимий індикатор дії «Приховати/Показати» — іконка eye/eye-off.
  const typeTag = SLIDE_EXTS.has(file.ext) ? "🖼️" : "🎬";
  info.innerHTML = '<div class="file-name">' + typeTag + " " + esc(file.name) +
    (file.hidden ? '<span class="sr-only">Приховано від учнів</span>' : "") +
    '</div><div class="hint">' + esc(file.ext.toUpperCase()) + " • " + formatSize(file.size) + "</div>";

  if (file.description) {
    const descWrap = document.createElement("div");
    descWrap.className = "file-desc-wrap";
    const desc = document.createElement("div");
    desc.className = "file-desc";
    desc.textContent = String(file.description);
    desc.tabIndex = 0;
    desc.setAttribute("aria-label", "Опис матеріалу: " + String(file.description));
    const tooltip = document.createElement("div");
    tooltip.className = "file-desc-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = String(file.description);
    const infoButton = document.createElement("button");
    infoButton.type = "button";
    infoButton.className = "file-desc-info";
    infoButton.textContent = "i";
    infoButton.setAttribute("aria-label", "Показати повний опис матеріалу");
    infoButton.setAttribute("aria-expanded", "false");
    const fullDescription = document.createElement("div");
    fullDescription.className = "file-desc-full";
    fullDescription.hidden = true;
    fullDescription.textContent = String(file.description);
    infoButton.addEventListener("click", () => {
      const open = fullDescription.hidden;
      fullDescription.hidden = !open;
      infoButton.setAttribute("aria-expanded", String(open));
      infoButton.setAttribute("aria-label", open ? "Приховати повний опис матеріалу" : "Показати повний опис матеріалу");
    });
    descWrap.append(desc, tooltip, infoButton, fullDescription);
    info.append(descWrap);
  }

  if (isTeacher && SLIDE_EXTS.has(file.ext) && file.conversionStatus !== "ready") {
    const conversion = document.createElement("div");
    conversion.className = "conversion-state" + (file.conversionStatus === "failed" ? " conversion-error" : "");
    conversion.textContent = file.conversionStatus === "failed"
      ? "Помилка конвертації: " + (file.conversionError || "невідома помилка")
      : file.conversionStatus === "converting" ? "Конвертація PNG-слайдів…" : "PNG-слайди ще не готові";
    info.append(conversion);
  }

  const actions = document.createElement("div");
  actions.className = "file-actions";
  const fileId = file.id || file.name;
  if (isMaterialsPage) {
    // Issue #63 (Етап 4): усі кнопки дій — іконка + підпис; на мобільному
    // підпис ховається (лише іконки), назви дій зберігаються в aria-label/title
    const local = actionButton(
      "secondary btn-sm", "eye", "Відкрити",
      "Відкрити для себе (індивідуальний перегляд)",
      "Відкрити для себе: " + file.name,
      () => displayLocalFile(fileId)
    );
    actions.append(local);
    if (isTeacher) {
      // Іконка демонстрації — monitor-play (екран/презентація), не око:
      // показ всім має відрізнятися від приватного «Відкрити/Перегляд»
      const broadcast = actionButton(
        "btn-sm", "monitor-play", "Транслювати",
        "Спільна демонстрація для всіх учнів",
        "Транслювати всім: " + file.name,
        () => broadcastFile(fileId, true)
      );
      actions.append(broadcast);
      const hideBtn = actionButton(
        "btn-sm " + (file.hidden ? "btn-success" : "btn-warning"),
        file.hidden ? "eye-off" : "eye",
        file.hidden ? "Показати" : "Приховати",
        file.hidden ? "Показати матеріал учням" : "Приховати матеріал від учнів",
        (file.hidden ? "Показати" : "Приховати") + " для учнів: " + file.name,
        () => toggleHideFile(fileId, file.hidden)
      );
      actions.append(hideBtn);
      const delBtn = actionButton(
        "btn-sm btn-danger", "trash-2", "Видалити",
        "Видалити матеріал зі сервера",
        "Видалити матеріал: " + file.name,
        () => deleteFile(fileId, file.name)
      );
      actions.append(delBtn);
    }
  } else if (isDemoPage && isTeacher) {
    // Issue #63 (§3.2/§3.3): приватний перегляд відрізняється від спільної
    // демонстрації не лише кольором, а й піктограмою та підписом (§4).
    // Приватний перегляд — око (eye); демонстрація всім — екран/презентація
    // (monitor-play), а НЕ око (вимога Етапу 4 §3)
    const previewBtn = actionButton(
      "secondary btn-sm", "eye", "Перегляд",
      "Приватний перегляд (лише для вас)",
      "Приватний перегляд: " + file.name,
      () => openPreviewModal(fileId, previewBtn)
    );
    const broadcast = actionButton(
      "btn-sm", "monitor-play", "Показувати всім",
      "Спільна демонстрація для всіх учнів",
      "Показувати всім: " + file.name,
      () => broadcastFile(fileId, false)
    );
    actions.append(previewBtn, broadcast);
    if (showCategoryActions) {
      // Видимість для учнів, перейменування, видалення — дії вчителя (§3.2)
      const hideBtn = actionButton(
        "btn-sm " + (file.hidden ? "btn-success" : "btn-warning"),
        file.hidden ? "eye-off" : "eye",
        file.hidden ? "Показати" : "Приховати",
        file.hidden ? "Показати матеріал учням" : "Приховати матеріал від учнів",
        (file.hidden ? "Показати" : "Приховати") + " для учнів: " + file.name,
        () => toggleHideFile(fileId, file.hidden)
      );
      const renameBtn = actionButton(
        "secondary btn-sm order-button", "edit", "",
        "Перейменувати матеріал",
        "Перейменувати матеріал: " + file.name,
        () => renameMaterial(fileId, file.name)
      );
      const delBtn = actionButton(
        "btn-sm btn-danger", "trash-2", "Видалити",
        "Видалити матеріал зі сервера",
        "Видалити матеріал: " + file.name,
        () => deleteFile(fileId, file.name)
      );
      actions.append(hideBtn, renameBtn, delBtn);
      const up = document.createElement("button");
      up.type = "button"; up.className = "secondary btn-sm order-button"; up.append(iconSvg("arrow-up"));
      up.title = "Перемістити матеріал вище"; up.setAttribute("aria-label", "Перемістити вище: " + file.name);
      up.onclick = () => reorderMaterial(fileId, "up");
      const down = document.createElement("button");
      down.type = "button"; down.className = "secondary btn-sm order-button"; down.append(iconSvg("arrow-down"));
      down.title = "Перемістити матеріал нижче"; down.setAttribute("aria-label", "Перемістити нижче: " + file.name);
      down.onclick = () => reorderMaterial(fileId, "down");
      actions.append(up, down);
      const move = document.createElement("button");
      move.type = "button"; move.className = "secondary btn-sm category-move-button";
      move.append(iconSvg("folder-input")); move.title = "Перемістити до категорії";
      move.setAttribute("aria-label", "Перемістити до категорії: " + file.name);
      const menu = document.createElement("div"); menu.className = "category-menu"; menu.hidden = true;
      const options = [{ id: "", name: "Без категорії" }, ...categories];
      for (const category of options) {
        const option = document.createElement("button");
        option.type = "button"; option.className = "secondary btn-sm"; option.textContent = category.name;
        option.onclick = () => setFileCategory(fileId, category.id); menu.append(option);
      }
      const create = document.createElement("button");
      create.type = "button"; create.className = "btn-sm category-create-option";
      create.append(iconSvg("plus"), document.createTextNode(" Створити категорію")); create.onclick = createCategory; menu.append(create);
      move.onclick = () => { menu.hidden = !menu.hidden; move.setAttribute("aria-expanded", String(!menu.hidden)); };
      actions.append(move);
      item.append(info, actions, menu);
    } else item.append(info, actions);
    if (SLIDE_EXTS.has(file.ext) && file.conversionStatus !== "ready") {
      const retry = actionButton(
        "secondary btn-sm", "refresh-cw", "Повторити конвертацію",
        "Повторити конвертацію PNG-слайдів",
        "Повторити конвертацію: " + file.name,
        () => retrySlideConversion(fileId)
      );
      actions.append(retry);
    }
    return item;
  } else if (isUploadPage && isTeacher) {
    const hideBtn = actionButton(
      "btn-sm " + (file.hidden ? "btn-success" : "btn-warning"),
      file.hidden ? "eye-off" : "eye",
      file.hidden ? "Показати" : "Приховати",
      file.hidden ? "Показати матеріал учням" : "Приховати матеріал від учнів",
      (file.hidden ? "Показати" : "Приховати") + " для учнів: " + file.name,
      () => toggleHideFile(fileId, file.hidden)
    );
    actions.append(hideBtn);
    const delBtn = actionButton(
      "btn-sm btn-danger", "trash-2", "Видалити",
      "Видалити матеріал зі сервера",
      "Видалити матеріал: " + file.name,
      () => deleteFile(fileId, file.name)
    );
    actions.append(delBtn);
  }
  item.append(info, actions);
  return item;
}

// Issue #63 Р: стан акордеона категорій зберігається в пам'яті сторінки за
// id категорії ("" — «Без категорії») і переживає перерисовку каталогу.
// Початковий стан (вимога Tech-lead §2.3): УСІ категорії згорнуті при
// відкритті каталогу — розгортаються лише ті, що відкрив користувач у цій
// сесії. Незалежне згортання: одночасно можуть бути відкриті кілька
// категорій (див. DECISIONS.md — запис про акордеон замінено).
const expandedCategoryIds = new Set();

function renderCategoryGroups(root) {
  const isTeacher = role === "teacher";
  // Дії над категоріями/порядком — лише панель викладача на «Демонстрації»
  const showCategoryActions = isDemoPage && isTeacher;
  const orderedCategories = [...categories].sort((a, b) => (a.order || 0) - (b.order || 0));
  const groups = [...orderedCategories.map(category => ({ id: category.id, name: category.name, category })),
    { id: "", name: "Без категорії", category: null }];
  for (const group of groups) {
    const groupFiles = files.filter(file => (file.categoryId || "") === group.id);
    const expanded = expandedCategoryIds.has(group.id);
    const bodyId = "category-body-" + (group.id || "uncategorized");

    const section = document.createElement("section");
    section.className = "category-section" + (expanded ? "" : " is-collapsed");
    const header = document.createElement("div"); header.className = "category-heading";
    const title = document.createElement("h4");

    // Акордеон: кнопка-заголовок працює мишею, клавіатурою (Enter/Space) і
    // дотиком; клік поза кнопкою (наприклад, «Видалити категорію») не згортає
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "category-toggle";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-controls", bodyId);
    toggle.setAttribute("aria-label", (expanded ? "Згорнути" : "Розгорнути") + " категорію «" + group.name + "»");
    const chevron = document.createElement("span");
    chevron.className = "category-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = expanded ? "▾" : "▸";
    // Issue #63 (Етап 4): назва в окремому span — довгі назви коротуються
    // еліпсисом, а кнопки дій залишаються в тому самому рядку з назвою
    const nameSpan = document.createElement("span");
    nameSpan.className = "category-name";
    nameSpan.textContent = " " + group.name + " ";
    toggle.append(iconSvg("folder"), nameSpan, chevron);
    title.append(toggle);
    header.append(title);
    if (group.category && showCategoryActions) {
      // Issue #63 (§3.1): компактні дії над категорією — перейменування,
      // порядок (вгору/вниз), видалення з підтвердженням. Кнопки поза
      // кнопкою-заголовком, тому клік по них не згортає акордеон
      const bar = document.createElement("div");
      bar.className = "category-actions";

      const rename = document.createElement("button");
      rename.type = "button"; rename.className = "secondary btn-sm order-button";
      rename.append(iconSvg("edit"));
      rename.title = "Перейменувати категорію";
      rename.setAttribute("aria-label", "Перейменувати категорію «" + group.name + "»");
      rename.onclick = () => renameCategory(group.category);

      const up = document.createElement("button");
      up.type = "button"; up.className = "secondary btn-sm order-button"; up.append(iconSvg("arrow-up"));
      up.title = "Перемістити категорію вище";
      up.setAttribute("aria-label", "Перемістити категорію вище: «" + group.name + "»");
      up.onclick = () => reorderCategory(group.category, "up");

      const down = document.createElement("button");
      down.type = "button"; down.className = "secondary btn-sm order-button"; down.append(iconSvg("arrow-down"));
      down.title = "Перемістити категорію нижче";
      down.setAttribute("aria-label", "Перемістити категорію нижче: «" + group.name + "»");
      down.onclick = () => reorderCategory(group.category, "down");

      const remove = actionButton(
        "secondary btn-sm", "trash-2", "Видалити категорію",
        "Видалити категорію",
        "Видалити категорію " + group.name,
        () => deleteCategory(group.category)
      );

      bar.append(rename, up, down, remove);
      header.append(bar);
    }
    section.append(header);

    const body = document.createElement("div");
    body.className = "category-body";
    body.id = bodyId;
    body.hidden = !expanded;
    if (!groupFiles.length) {
      const empty = document.createElement("p"); empty.className = "hint category-empty";
      empty.textContent = "У цій категорії поки немає матеріалів."; body.append(empty);
    } else {
      for (const file of groupFiles) body.append(createFileCard(file, isTeacher, showCategoryActions));
    }
    section.append(body);

    toggle.onclick = () => {
      const nowExpanded = !expandedCategoryIds.has(group.id);
      if (nowExpanded) expandedCategoryIds.add(group.id);
      else expandedCategoryIds.delete(group.id);
      body.hidden = !nowExpanded;
      section.classList.toggle("is-collapsed", !nowExpanded);
      toggle.setAttribute("aria-expanded", String(nowExpanded));
      toggle.setAttribute("aria-label", (nowExpanded ? "Згорнути" : "Розгорнути") + " категорію «" + group.name + "»");
      chevron.textContent = nowExpanded ? "▾" : "▸";
    };

    root.append(section);
  }
}

function renderFiles() {
  const root = $("files");
  if (!root) return;
  root.replaceChildren();
  if (!files.length && !(isDemoPage && role === "teacher")) {
    const msg = role === "teacher"
      ? "Матеріалів ще немає. Завантажте перший файл."
      : "Матеріали наразі відсутні. Очікуйте відкриття матеріалів викладачем.";
    root.innerHTML = '<div class="empty">' + msg + '</div>';
    return;
  }

  const isTeacher = role === "teacher";
  // Issue #63 Р: каталог групують категорії для всіх ролей на сторінці
  // перегляду (учні бачать категорії) та для викладача на «Демонстрації»
  if (isMaterialsPage || (isDemoPage && isTeacher)) {
    renderCategoryGroups(root);
    return;
  }
  for (const file of files) root.append(createFileCard(file, isTeacher, false));
}
async function toggleHideFile(name, currentHidden) {
  if (!pin) { alert("Потрібен PIN викладача."); return; }
  try {
    await api("/api/files/toggle-hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, file: name, hidden: !currentHidden })
    });
    setStatus(currentHidden ? "Файл показано учням: " + name : "Файл приховано від учнів: " + name);
    await refreshFiles();
  } catch (e) { alert("Помилка: " + e.message); }
}

async function deleteFile(fileId, displayName) {
  if (!pin) { alert("Потрібен PIN викладача."); return; }
  const shownName = displayName || fileId;
  if (!confirm("Видалити файл «" + shownName + "» з сервера?")) return;
  try {
    await api("/api/files/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, file: fileId })
    });
    setStatus("Файл видалено: " + shownName);
    if (localCurrentFile === fileId && $("viewer")) {
      $("viewer").innerHTML = '<div class="empty">Файл видалено. Оберіть інший матеріал.</div>';
    }
    await refreshFiles();
  } catch (e) { alert("Помилка видалення: " + e.message); }
}

// ---------------------------------------------------------------------------
// LOCAL VIEWER (Materials page)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Issue #63: плавне прокручування до потрібного вікна (§2.7 учень, §3.4 вчитель)
// ---------------------------------------------------------------------------

/**
 * Плавно прокручує сторінку до потрібного вікна (§2.7 учень, §3.4 вчитель).
 * Якщо елемент уже повністю видимий — рух не виконується (§3.4: не прокручувати
 * зайвого). Враховує мобільний екран (вікно може бути під каталогом).
 * block: "nearest" — мінімальний рух до видимості; "start" — верх елемента у
 * вікні (щоб бачити його від початку одразу після запуску показу).
 */
function scrollToPanel(panel, block = "nearest") {
  if (!panel || typeof panel.scrollIntoView !== "function") return false;
  const rect = panel.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const fullyVisible = rect.top >= 0 && rect.bottom <= vh && rect.left >= 0 && rect.right <= vw;
  if (fullyVisible) return false;
  panel.scrollIntoView({ behavior: "smooth", block: block, inline: "nearest" });
  return true;
}

/** Фокус на контейнері вікна без стрибка прокрутки — доступність/клавіатура */
function focusViewer(viewerEl) {
  if (!viewerEl) return;
  try {
    viewerEl.tabIndex = -1;
    viewerEl.focus({ preventScroll: true });
  } catch { /* старі браузери без options */ }
}

function displayLocalFile(fileId) {
  const file = files.find(f => (f.id === fileId || f.name === fileId));
  if (!file || !$("viewer")) return;

  const actualId = file.id || fileId;
  localCurrentFile = actualId;
  localPageNum = 1;
  videoElement = null;

  if ($("viewerTitle")) $("viewerTitle").textContent = "Особистий перегляд: " + (file.name || actualId);
  $("viewer").replaceChildren();

  // §2.7: учень бачить відкритий матеріал — фокус на вікні та плавна
  // прокрутка до нього (на мобільному вікно зазвичай під каталогом)
  focusViewer($("viewer"));
  scrollToPanel($("viewer"));

  if (SLIDE_EXTS.has(file.ext)) {
    if ($("pdfControls")) $("pdfControls").style.display = "flex";

    // Issue #61: нове відкриття матеріалу — показуємо початкову підказку навігації
    setSlideNavHint(true);

    prepareAndShowSlides(actualId, 1, pageCount => {
      localPageCount = pageCount;
      renderSlideImage(actualId, 1, pageCount);
    });
    return;
  }

  if ($("pdfControls")) $("pdfControls").style.display = "none";

  const video = document.createElement("video");
  video.src = fileUrl(actualId);
  video.playsInline = true;
  video.preload = "metadata";
  video.controls = true;
  $("viewer").append(video);
}

function setLocalPage(page) {
  // Issue #63: у режимі спільної демонстрації позицію задає лише викладач
  if (isMaterialsPage && materialsDemoActive) return;
  if (!localCurrentFile || !SLIDE_EXTS.has(extOf(localCurrentFile))) return;
  localPageNum = Math.max(1, Math.min(localPageCount || 1, page));
  renderSlideImage(localCurrentFile, localPageNum, localPageCount || 1);
}

function stepLocalPage(delta) {
  setLocalPage(localPageNum + delta);
}

// ---------------------------------------------------------------------------
// Issue #63: два режими однієї сторінки учня («Перегляд матеріалів»)
// ---------------------------------------------------------------------------
// Режим визначається за СЕРВЕРНИМ станом демонстрації (/api/state), а не за
// локальним станом браузера. Початок показу вчителем ховає вибір матеріалів,
// категорії та самостійну навігацію — учень лише дивиться синхронізовану
// демонстрацію. Зупинка показу повертає каталог на тій самій сторінці без
// перезавантаження, і учень знову обирає матеріали самостійно.

function setMaterialsDemoMode(active, state = {}) {
  materialsDemoActive = active;
  const catalog = $("materialsCatalogPanel");
  if (catalog) catalog.style.display = active ? "none" : "";
  if (active) {
    if ($("materialsSubtitle")) {
      $("materialsSubtitle").textContent =
        "Триває спільна демонстрація викладача: вибір матеріалів і самостійна навігація вимкнені.";
    }
    // Самостійна навігація вимкнена: локальні контроли сховано, активні
    // зони зображення прибрано (подальші слайди показує pollState з сервера)
    if ($("pdfControls")) $("pdfControls").style.display = "none";
    document.querySelectorAll(".slide-zone").forEach(z => z.remove());
    setSlideNavHint(false);
    if ($("viewerTitle")) $("viewerTitle").textContent = "Спільна демонстрація";
    setStatus("Демонстрацію розпочато викладачем.");
    return;
  }
  // Зупинка демонстрації: каталог і особистий перегляд повертаються на цій
  // самій сторінці; зміст глядача відновлюється з локального стану
  if ($("materialsSubtitle")) {
    $("materialsSubtitle").textContent = role === "teacher"
      ? "Каталог навчальних матеріалів. Ви можете відкривати, транслювати, приховувати та видаляти файли."
      : "Оберіть матеріал для індивідуального вивчення. Особистий перегляд не впливає на інших учасників.";
  }
  restoreLocalViewer();
}

/** Повернення до особистого перегляду після зупинки демонстрації */
function restoreLocalViewer() {
  if (!$("viewer")) return;
  const file = localCurrentFile
    ? files.find(f => (f.id === localCurrentFile || f.name === localCurrentFile))
    : null;
  if (file) {
    const actualId = file.id || localCurrentFile;
    localCurrentFile = actualId;
    if ($("viewerTitle")) $("viewerTitle").textContent = "Особистий перегляд: " + file.name;
    if (SLIDE_EXTS.has(file.ext)) {
      if ($("pdfControls")) $("pdfControls").style.display = "flex";
      setSlideNavHint(true);
      renderSlideImage(actualId, Math.max(1, localPageNum || 1), localPageCount || 1);
      return;
    }
    displayLocalFile(actualId);
    return;
  }
  if ($("pdfControls")) $("pdfControls").style.display = "none";
  if ($("viewerTitle")) $("viewerTitle").textContent = "Особистий перегляд";
  $("viewer").innerHTML = '<div class="empty">Оберіть файл зі списку та натисніть «Відкрити для себе».</div>';
}

/**
 * Issue #63 (Етап 4): якщо учень саме переглядав матеріал, який учитель зробив
 * прихованим (або видалив), — коректно завершити цей перегляд і повернути його
 * до актуального каталогу. Викликається після перечитування каталогу в pollState:
 * для учня прихований матеріал зникає з files, отже, локальний перегляд не може
 * тривати. Спільна демонстрація НЕ переривається (учитель має право показувати
 * приховані матеріали) — режим демонстрації перевіряється окремо.
 */
function closeLocalViewIfHidden() {
  if (!isMaterialsPage || materialsDemoActive || role === "teacher" || !localCurrentFile) return;
  const viewing = files.find(f => (f.id === localCurrentFile || f.name === localCurrentFile));
  if (viewing) return;
  localCurrentFile = "";
  localPageNum = 1;
  localPageCount = 1;
  restoreLocalViewer();
}

// ---------------------------------------------------------------------------
// Issue #63 (§3.3): приватний перегляд викладача в модальному вікні
// ---------------------------------------------------------------------------
// Відкривається дією «👁️ Перегляд» на сторінці «Демонстрація». Показує матеріал
// ЛИШЕ викладачу і НЕ змінює стан демонстрації (/api/control не викликається).
// Вимоги §3.3: закриття кнопкою ✕ або Escape, фокус повертається на кнопку
// виклику, Tab утримується в межах діалогу, фон недоступний для фокуса.

let previewOpen = false;
let previewFileId = "";
let previewPage = 1;
let previewPageCount = 1;
let previewInvoker = null;
let previewVideo = null;

/** Контекст рендерингу слайдів для контейнера модального прев'ю */
function previewSlideCtx() {
  return {
    viewer: $("previewViewer"),
    label: $("previewPageLabel"),
    input: $("previewPageInput"),
    zoneAllowed: true, // приватна навігація дозволена завжди
    onZoneStep: delta => previewSetPage(previewPage + delta)
  };
}

function previewSetPage(page) {
  if (!previewFileId || !SLIDE_EXTS.has(extOf(previewFileId))) return;
  previewPage = Math.max(1, Math.min(previewPageCount || 1, page));
  renderSlideImage(previewFileId, previewPage, previewPageCount || 1, previewSlideCtx());
}

function previewRender(fileId) {
  const file = files.find(f => (f.id === fileId || f.name === fileId));
  if (!file || !$("previewViewer")) return;
  previewFileId = file.id || fileId;
  previewPage = 1;
  previewPageCount = 1;
  previewVideo = null;
  if ($("previewModalTitle")) $("previewModalTitle").textContent = "Приватний перегляд: " + file.name;
  $("previewViewer").replaceChildren();
  if (SLIDE_EXTS.has(file.ext)) {
    if ($("previewControls")) $("previewControls").style.display = "flex";
    prepareAndShowSlides(previewFileId, 1, count => {
      previewPageCount = count;
      renderSlideImage(previewFileId, 1, count, previewSlideCtx());
    }, $("previewViewer"));
    return;
  }
  if ($("previewControls")) $("previewControls").style.display = "none";
  const video = document.createElement("video");
  video.src = fileUrl(previewFileId);
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  $("previewViewer").append(video);
  previewVideo = video;
}

function openPreviewModal(fileId, invoker) {
  const modal = $("previewModal");
  if (!modal) return;
  previewInvoker = invoker || document.activeElement;
  previewOpen = true;
  modal.style.display = "flex";
  previewRender(fileId);
  if ($("previewClose")) $("previewClose").focus();
}

function closePreviewModal() {
  const modal = $("previewModal");
  if (!modal || !previewOpen) return;
  previewOpen = false;
  // Доступність: спочатку знімаємо фокус із елемента всередині діалогу ДО
  // приховування. Інакше браузер, обробляючи display:none відкладено, скидає
  // фокус на <body> вже після нашого focus() нижче — і повернення фокусу
  // на кнопку «Перегляд» не відбувається (перевірено браузерним тестом)
  if (modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal.style.display = "none";
  if (previewVideo) {
    try { previewVideo.pause(); } catch { /* відео вже знято з DOM */ }
    previewVideo = null;
  }
  previewFileId = "";
  if ($("previewViewer")) $("previewViewer").replaceChildren();
  // Доступність: фокус повертається на кнопку, що відкрила діалог
  if (previewInvoker && document.contains(previewInvoker)) previewInvoker.focus();
  previewInvoker = null;
}

if ($("previewClose")) $("previewClose").onclick = closePreviewModal;
if ($("previewPrev")) $("previewPrev").onclick = () => previewSetPage(previewPage - 1);
if ($("previewNext")) $("previewNext").onclick = () => previewSetPage(previewPage + 1);
if ($("previewGoto")) {
  $("previewGoto").onclick = () => {
    const target = parseInt($("previewPageInput").value, 10);
    if (Number.isFinite(target)) previewSetPage(target);
  };
}
if ($("previewPageInput")) {
  $("previewPageInput").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const target = parseInt(e.currentTarget.value, 10);
      if (Number.isFinite(target)) previewSetPage(target);
    }
  });
}
if ($("previewModal")) {
  // Клік по фону закриває; клік у картці — ні
  $("previewModal").addEventListener("click", e => {
    if (e.target === $("previewModal")) closePreviewModal();
  });
}

document.addEventListener("keydown", e => {
  if (!previewOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closePreviewModal();
    return;
  }
  if (e.key !== "Tab") return;
  const card = $("previewModal") ? $("previewModal").querySelector(".modal-card") : null;
  if (!card) return;
  const focusables = card.querySelectorAll(
    'button:not([disabled]), input, video[controls], a[href], [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!card.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// ---------------------------------------------------------------------------
// BROADCAST & DEMO (Demonstration page)
// ---------------------------------------------------------------------------
async function postControl(data) {
  if (!pin || role !== "teacher") throw new Error("Потрібні права викладача.");
  const response = await api("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, ...data })
  });
  return response.json();
}

async function broadcastFile(fileId, navigateToDemo = false) {
  try {
    const file = files.find(f => (f.id === fileId || f.name === fileId));
    const actualId = file ? (file.id || file.name) : fileId;
    const ext = extOf(actualId);
    const kind = SLIDE_EXTS.has(ext) ? "slides" : "video";
    await postControl({ file: actualId, kind, page: 1, time: 0, playing: false });
    if (navigateToDemo) {
      window.location.href = "/demonstration";
    } else {
      await pollState(true);
      // §3.4: після УСПІШНОГО запуску — плавно до спільного вікна (верх панелі,
      // щоб бачити його одразу); рух лише якщо стан реально має файл і вікно
      // не видиме повністю (scrollToPanel)
      if (sharedState && sharedState.file) {
        scrollToPanel(document.querySelector(".demo-screen-panel"), "start");
      }
    }
  } catch (error) {
    alert("Не вдалося розпочати показ: " + error.message);
  }
}

function displaySharedFile(fileId, state = {}) {
  if (!$("viewer")) return;
  videoElement = null;

  const file = files.find(f => (f.id === fileId || f.name === fileId));
  // Issue #63 (доробка): назва зі стану показу — прихований матеріал учень не
  // бачить у каталозі, тож у його files[] його немає, а заголовок має бути
  // людським, а не сирим id
  const displayName = (state && state.fileName) || (file ? file.name : fileId);

  if ($("viewerTitle")) $("viewerTitle").textContent = "Спільна демонстрація: " + displayName;
  $("viewer").replaceChildren();

  // Slides (PDF or PPTX) — render as PNG images
  if (state.kind === "slides" || state.kind === "pdf" || SLIDE_EXTS.has(extOf(fileId))) {
    const pageNum = Math.max(1, state.page || 1);

    // Issue #61: початкова підказка показується при новому відкритті матеріалу
    // (при зміні слайду в межах того самого файлу не скидається)
    if (sharedNavHintFile !== fileId) {
      sharedNavHintFile = fileId;
      setSlideNavHint(true);
    }

    // Check if slides are ready or prepare them
    fetch("/api/slides/info?file=" + encodeURIComponent(fileId))
      .then(r => r.ok ? r.json() : null)
      .then(manifest => {
        if (manifest && manifest.ready) {
          demoPageCount = manifest.pageCount;
          renderSlideImage(fileId, pageNum, manifest.pageCount);
        } else {
          // If slides not prepared yet, prepare and display
          prepareAndShowSlides(fileId, pageNum, pageCount => {
            demoPageCount = pageCount;
            renderSlideImage(fileId, pageNum, pageCount);
          });
        }
      })
      .catch(() => {
        renderSlideImage(fileId, pageNum, pageNum);
      });
    return;
  }

  // Video / audio
  if ($("pageLabel")) $("pageLabel").textContent = "Відео";
  const isTeacher = role === "teacher";
  const video = document.createElement("video");
  video.src = fileUrl(fileId);
  video.playsInline = true;
  video.preload = "metadata";
  video.controls = isTeacher;
  videoElement = video;
  $("viewer").append(video);

  video.addEventListener("loadedmetadata", () => {
    if (state.time > 0 && Number.isFinite(state.time)) video.currentTime = state.time;
    if (state.playing) video.play().catch(() => {});
  });

  if (isTeacher) {
    video.addEventListener("play", () => sendVideoState(true));
    video.addEventListener("pause", () => { if (!video.ended) sendVideoState(false); });
    video.addEventListener("seeked", () => sendVideoState(!video.paused));
    video.addEventListener("timeupdate", () => {
      if (Date.now() - lastVideoUpdate > 2000) {
        lastVideoUpdate = Date.now();
        sendVideoState(!video.paused);
      }
    });
  }

  if (!state.playing) video.pause();
}

async function sendVideoState(playing) {
  if (role !== "teacher" || !videoElement || applyingRemote || !sharedState || !sharedState.file) return;
  try {
    await postControl({ file: sharedState.file, kind: "video", time: videoElement.currentTime || 0, playing });
  } catch (e) { console.error("Video sync:", e.message); }
}

async function setSharedPage(page) {
  if (role !== "teacher" || !sharedState || !sharedState.file) return;
  const next = Math.max(1, Math.min(demoPageCount || 9999, page));
  try {
    await postControl({ file: sharedState.file, kind: "slides", page: next });
    await pollState(true);
  } catch (e) { alert("Не вдалося перейти до слайду: " + e.message); }
}

async function changeSharedPage(delta) {
  if (!sharedState || !sharedState.file) return;
  await setSharedPage((sharedState.page || 1) + delta);
}

async function pollState(force = false) {
  // Сторінка перегляду: учні дізнаються про демонстрацію зі СЕРВЕРНОГО стану
  // (та самий шлях при перезавантаженні чи повторному підключенні); викладач
  // керує показом на сторінці «Демонстрація» і тут не спостерігає
  if (!isDemoPage && !isMaterialsPage) return;
  if (isMaterialsPage && role === "teacher") return;
  try {
    const response = await api("/api/state");
    const state = await response.json();
    const prev = sharedState;
    sharedState = state;

    // Issue #63 (Етап 4): нова ревізія — сигнал, що вчитель оновив щось спільне
    // (зокрема приховав або опублікував матеріал; toggle-hide теж піднімає ревізію
    // через stateService.touch()). Учень перечитує каталог із сервера: прихований
    // матеріал зникає, опублікований з'являється — без перезавантаження сторінки,
    // через НАЯВНИЙ механізм /api/state (без окремого каналу сповіщень).
    // Лічильник тут окремий від lastRevision (див. коментар біля його оголошення).
    if (role !== "teacher") {
      if (force) {
        lastCatalogRevision = state.revision;
      } else if (state.revision !== lastCatalogRevision) {
        lastCatalogRevision = state.revision;
        await refreshFiles();
        closeLocalViewIfHidden();
      }
    }

    // Issue #63: перемикання режимів сторінки учня без перезавантаження —
    // за серверним станом демонстрації (початок ховає каталог, зупинка повертає)
    if (isMaterialsPage && Boolean(state.file) !== materialsDemoActive) {
      setMaterialsDemoMode(Boolean(state.file), state);
    }

    if (!state.file) {
      if (isDemoPage) {
        if ($("viewerTitle")) $("viewerTitle").textContent = "Спільний екран";
        if (!force && $("viewer")) {
          $("viewer").innerHTML = '<div class="empty">Очікування початку демонстрації від викладача…</div>';
        }
        setStatus("Показ ще не розпочато.");
      } else {
        setStatus("Демонстрацію не ведеться. Каталог доступний для самостійного перегляду.");
      }
      return;
    }

    const file = files.find(f => (f.id === state.file || f.name === state.file));
    // Issue #63 (доробка): назва зі стану — актуальна і для прихованого
    // матеріалу, якого немає в каталозі учня
    const displayName = state.fileName || (file ? file.name : state.file);

    const changed = force || state.revision !== lastRevision;
    if (changed) {
      lastRevision = state.revision;
      const ext = extOf(state.file);
      if (SLIDE_EXTS.has(ext)) {
        if (!prev || prev.file !== state.file || prev.page !== state.page || force) {
          const pageNum = Math.max(1, state.page || 1);
          setStatus("Демонстрація: " + displayName + " — слайд " + pageNum + (demoPageCount > 1 ? " / " + demoPageCount : ""));
          displaySharedFile(state.file, state);
        }
      } else {
        setStatus("Демонстрація: " + displayName);
        displaySharedFile(state.file, state);
      }
      return;
    }

    // Video sync for non-teacher viewers
    if (videoElement && state.kind === "video" && role !== "teacher") {
      applyingRemote = true;
      const drift = Math.abs(videoElement.currentTime - state.time);
      if (drift > 2) videoElement.currentTime = state.time;
      if (state.playing && videoElement.paused) videoElement.play().catch(() => {});
      else if (!state.playing && !videoElement.paused) videoElement.pause();
      applyingRemote = false;
    }
  } catch {
    setStatus("Зв'язок із сервером втрачено. Повторна спроба…");
  }
}

// ---------------------------------------------------------------------------
// Teacher: wait for automatically generated slides / retry conversion
// ---------------------------------------------------------------------------
async function waitForSlideConversion(fileId, maxAttempts = 180) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await api("/api/slides/info?file=" + encodeURIComponent(fileId));
    const info = await response.json();
    if (info.ready && Number.isInteger(info.pageCount) && info.pageCount > 0) return info;
    if (info.failed) throw new Error(info.error || "Помилка конвертації PNG-слайдів");
    setUploadStatus("Конвертація PNG-слайдів: " + fileId + "…");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Перевищено час очікування конвертації PNG-слайдів");
}

async function prepareSlidesBg(fileId) {
  const response = await api("/api/slides/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Portal-Pin": pin },
    body: JSON.stringify({ file: fileId })
  });
  const manifest = await response.json();
  // POST /api/slides/prepare повертає маніфест лише після завершення ensureSlides().
  if (!manifest || !Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) {
    throw new Error("Сервер не підтвердив готовність PNG-слайдів");
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
// Issue #61: ті самі обробники використовує навігація зонами зображення
if ($("prevPage")) $("prevPage").onclick = () => navigateSlide(-1);
if ($("nextPage")) $("nextPage").onclick = () => navigateSlide(1);

// Issue #9: перехід на потрібний слайд за номером з клавіатури
function gotoPageInput() {
  const input = $("pageInput");
  if (!input) return;
  const target = parseInt(input.value, 10);
  if (!Number.isFinite(target)) {
    setStatus("Введіть номер сторінки.");
    return;
  }
  const count = isDemoPage ? (demoPageCount || 1) : (localPageCount || 1);
  const page = Math.max(1, Math.min(count, target));
  input.value = page;
  if (isDemoPage) setSharedPage(page);
  else setLocalPage(page);
}

if ($("gotoPage")) $("gotoPage").onclick = gotoPageInput;
if ($("pageInput")) {
  $("pageInput").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      gotoPageInput();
    }
  });
}

if ($("refresh")) $("refresh").onclick = refreshFiles;
if ($("showShared")) $("showShared").onclick = () => pollState(true);

// Issue #63: викладач зупиняє спільну демонстрацію — сервер скидає стан,
// сторінки учнів самі повертаються до самостійного перегляду (режим за
// серверним станом, без перезавантаження)
if ($("stopDemo")) {
  $("stopDemo").onclick = async () => {
    try {
      await postControl({ stop: true });
      await pollState(true);
    } catch (e) {
      alert("Не вдалося зупинити демонстрацію: " + e.message);
    }
  };
}

// Issue #63 Етап 3: черга зберігає File та опис незалежно від DOM file input.
function renderUploadQueue() {
  const queue = $("uploadQueue");
  if (!queue) return;
  queue.replaceChildren();

  for (const item of uploadQueueState) {
    const row = document.createElement("div");
    row.className = "upload-queue-item";

    const details = document.createElement("div");
    details.className = "upload-queue-details";
    const nameEl = document.createElement("div");
    nameEl.className = "upload-queue-name";
    nameEl.textContent = "📄 " + item.file.name;
    details.append(nameEl);

    if (item.status === "uploading") {
      const state = document.createElement("div");
      state.className = "upload-queue-state";
      state.textContent = "Завантаження…";
      details.append(state);
    } else if (item.error) {
      const state = document.createElement("div");
      state.className = "upload-queue-state upload-queue-error";
      state.textContent = "Помилка: " + item.error;
      details.append(state);
    }

    const desc = document.createElement("input");
    desc.type = "text";
    desc.className = "upload-desc";
    desc.maxLength = 500;
    desc.placeholder = "Опис (необов'язково)";
    desc.value = item.description;
    desc.disabled = uploadInProgress;
    desc.addEventListener("input", () => { item.description = desc.value; });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary btn-sm upload-queue-remove";
    remove.textContent = "Прибрати";
    remove.setAttribute("aria-label", "Прибрати з черги файл " + item.file.name);
    remove.disabled = uploadInProgress;
    remove.addEventListener("click", () => {
      uploadQueueState = uploadQueueState.filter((queued) => queued.key !== item.key);
      renderUploadQueue();
    });

    row.append(details, desc, remove);
    queue.append(row);
  }
}

if ($("createCategoryFromUpload")) $("createCategoryFromUpload").onclick = createCategory;
// Issue #63 (§3.1): «Створити категорію» безпосередньо в панелі «Матеріали»
if ($("createCategoryBtn")) $("createCategoryBtn").onclick = createCategory;

if ($("uploadFile")) {
  $("uploadFile").addEventListener("change", () => {
    const input = $("uploadFile");
    const selected = Array.from(input.files || []);
    const duplicates = [];
    for (const file of selected) {
      // Ім'я є видимим ключем для користувача: не додаємо дубль непомітно.
      const existing = uploadQueueState.find((queued) => queued.file.name === file.name);
      if (existing) {
        duplicates.push(file.name);
        continue;
      }
      uploadQueueState.push({
        key: uploadQueueNextId++,
        file,
        description: "",
        status: "queued",
        error: ""
      });
    }
    // Очищення input дозволяє повторно вибрати той самий файл; черга живе окремо.
    input.value = "";
    renderUploadQueue();
    if (duplicates.length) {
      setUploadStatus("Не додано дублікати за ім'ям: " + duplicates.join(", ") +
        ". Уже додані файли та їхні описи залишилися в черзі.");
    } else if (selected.length) {
      setUploadStatus("У черзі файлів: " + uploadQueueState.length + ".");
    }
  });
}

// Upload handler: повторний запуск обробляє лише поточну чергу невдалих файлів.
if ($("upload") && $("uploadFile")) {
  $("upload").onclick = async () => {
    if (uploadInProgress) return;
    if (!uploadQueueState.length) {
      setUploadStatus("Оберіть файли для завантаження.");
      return;
    }
    if (!pin || role !== "teacher") {
      setUploadStatus("Необхідно увійти як викладач.");
      openRoleModal();
      return;
    }

    const button = $("upload");
    uploadInProgress = true;
    button.disabled = true;
    let uploadedCount = 0;
    const uploadedSlideIds = [];
    const failures = [];
    const conversionFailures = [];

    try {
      const batch = uploadQueueState.slice();
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        if (!uploadQueueState.some((queued) => queued.key === item.key)) continue;
        item.status = "uploading";
        item.error = "";
        renderUploadQueue();
        setUploadStatus("Завантаження " + (i + 1) + " з " + batch.length + ": " + item.file.name + "…");

        let url = "/api/upload?name=" + encodeURIComponent(item.file.name);
        const description = item.description.trim();
        const categoryId = $("uploadCategory") ? $("uploadCategory").value : "";
        if (description) url += "&description=" + encodeURIComponent(description);
        if (categoryId) url += "&categoryId=" + encodeURIComponent(categoryId);

        try {
          const response = await api(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "X-Portal-Pin": pin },
            body: item.file
          });
          const result = await response.json();
          const fileId = result.id || item.file.name;
          uploadedCount++;
          if (SLIDE_EXTS.has(extOf(fileId))) {
            if (result.conversionStatus === "failed") conversionFailures.push(fileId + " — " + (result.conversionError || "PNG-слайди не готові"));
            else uploadedSlideIds.push(fileId);
          }
          // Оригінал збережено навіть у разі помилки конвертації; не дублюємо upload.
          uploadQueueState = uploadQueueState.filter((queued) => queued.key !== item.key);
        } catch (error) {
          item.status = "error";
          item.error = error && error.message ? error.message : "Невідома помилка";
          failures.push(item.file.name + " — " + item.error);
        }
      }

      renderUploadQueue();
      // Конвертація виконується сервером у фоні; очікуємо підтвердження API,
      // не запускаючи повторну конвертацію для кожного щойно завантаженого файлу.
      for (const fileId of uploadedSlideIds) {
        try {
          setUploadStatus("Очікування PNG-слайдів: " + fileId + "…");
          await waitForSlideConversion(fileId);
        } catch (error) {
          conversionFailures.push(fileId + " — " + (error.message || "Помилка конвертації"));
        }
      }

      let summary = "Завантажено: " + uploadedCount + ". У черзі залишилося: " + uploadQueueState.length + ".";
      if (failures.length) summary += " Не вдалося завантажити: " + failures.join("; ") + ".";
      if (conversionFailures.length) {
        summary += " Помилка підготовки PNG (оригінали збережено, матеріали не готові до показу): " + conversionFailures.join("; ") + ".";
      } else if (uploadedSlideIds.length) {
        summary += " PNG-слайди підтверджено готовими.";
      }
      if (!failures.length && !conversionFailures.length) summary = "✅ " + summary;
      else summary = "⚠️ " + summary;
      setUploadStatus(summary);
      await refreshFiles();
    } catch (error) {
      setUploadStatus("Помилка обробки черги: " + (error && error.message ? error.message : "невідома помилка") +
        ". Невдалі файли залишено в черзі.");
    } finally {
      uploadInProgress = false;
      button.disabled = false;
      renderUploadQueue();
    }
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
// Issue #63: список файлів завантажуємо першим — pollState і displaySharedFile
// шукають ім'я файлу у масиві files і без нього показують сирий id (гонка двох
// паралельних fetch на завантаженні сторінки)
let filesReady = Promise.resolve();
if (!role) {
  openRoleModal();
  updateRoleUI();
} else {
  updateRoleUI();
  filesReady = refreshFiles();
}

if (isDemoPage) {
  // Перший pollState після завантаження списку файлів; подальші — за інтервалом
  filesReady.finally(() => pollState(true));
  setInterval(() => pollState(false), DEMO_STATE_POLL_MS);
}

// Issue #63: одна сторінка учня з двома режимами. Учень (або гість без ролі)
// дізнається про демонстрацію зі СЕРВЕРНОГО стану: початок/зупинка показу
// перемикають сторінку без перезавантаження; перезавантаження або повторне
// підключення проходять той самий шлях і одразу отримують актуальний стан
if (isMaterialsPage) {
  filesReady.finally(() => {
    if (role !== "teacher") pollState(true);
  });
  setInterval(() => {
    if (role !== "teacher") pollState(false);
  }, DEMO_STATE_POLL_MS);
}

// Issue #7: учень повідомляє сервер про активність свого сеансу.
// Обробники реєструються завжди (усередині — перевірка ролі), щоб вхід учня
// в поточній сесії також працював, а не лише при перезавантаженні сторінки.
document.addEventListener("visibilitychange", () => {
  reportActivityChange(document.visibilityState !== "hidden");
});
window.addEventListener("pagehide", () => {
  reportActivityChange(false);
  reportTeacherLeave(); // Issue #63: закриття вкладки вчителем зупиняє показ
});
if (role === "student" && studentDisplayName) startHeartbeat();

// Issue #7: викладач опитує список присутності та отримує тости
if (role === "teacher") {
  startPresencePolling();
  // Issue #63: heartbeat викладача — без нього активний показ зупиняється
  // автоматично, коли вчитель іде (вкладка, «Вийти», зв'язок)
  startTeacherHeartbeat();
  // Issue #63 (доробка): оновлюємо HttpOnly медіа-cookie. При перезавантаженні
  // сторінки PIN береться з sessionStorage, але cookie видавався лише при
  // вході — без оновлення <img>/<video> викладача втратили б доступ після
  // вичерпання терміну дії; запит нічого не змінює, якщо PIN невірний
  if (pin) {
    fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    }).catch(() => {});
  }
}
