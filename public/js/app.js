const $ = id => document.getElementById(id);

// Role & Session PIN management
let role = localStorage.getItem("portalRole") || "";
let pin = sessionStorage.getItem("portalPin") || "";
// Issue #85: ідентифікатор облікового запису персонального PIN викладача та
// прапорець адміністратора (відповідь POST /api/auth/verify). Потрібні для
// заголовка X-Portal-Teacher (сервер зараховує спроби за обліковим записом)
// і для показу адміністративного розділу «Викладачі». Сам PIN у відповідь
// не повертається, у сесію теж не потрапляє.
let teacherId = sessionStorage.getItem("portalTeacherId") || "";
let isAdmin = sessionStorage.getItem("portalAdmin") === "1";
let teacherFullName = sessionStorage.getItem("portalTeacherFullName") || "";
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
// Issue #63 (доробка): ревізія каталогу. Сервер збільшує state.revision при
// зміні видимості/складу каталогу (toggle-hide тощо), тому клієнт учня
// перечитує /api/files на зміну ревізії — публікація або приховування
// матеріалу викладачем оновлює його список без перезавантаження сторінки.
// null — перший стан ще не отримано (початкове завантаження вже зроблено
// refreshFiles при вході).
let lastCatalogRevision = null;
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

// Issue #63 (доробка): номер останнього відображення у спільному глядачі.
// displaySharedFile асинхронно читає /api/slides/info; якщо за цей час стан
// уже змінився (інший цикл опитування), відповідь застаріла — малювати її
// не можна, інакше глядач відкочується до попереднього матеріалу.
let viewerRenderSeq = 0;

// Issue #63 (доробка): глибина активних циклів опитування стану — див. pollState
let pollBusyDepth = 0;

// Issue #63 (доробка §3): спільний глядач учня очищено через недоступність
// активного матеріалу (state.blocked). Прапорець змушує наступне відновлення
// показу (наприклад, після публікації матеріалу назад) намалювати матеріал
// навіть за того самого файлу й того самого слайда.
let sharedViewerCleared = false;

// Determine current page type
const isDemoPage = Boolean(window.location.pathname.includes("demonstration"));
const isUploadPage = Boolean(window.location.pathname.includes("upload"));
const isStudentsPage = Boolean(window.location.pathname.includes("students"));
// Issue #85: адміністративний розділ «Викладачі» — окрема сторінка, яку не
// можна плутати з «Переглядом матеріалів» (інакше викладача перенаправило б
// на /demonstration і статус каталогу не оновлювався б тут)
const isTeachersPage = Boolean(window.location.pathname.includes("teachers"));
const isMaterialsPage = Boolean(!isDemoPage && !isUploadPage && !isStudentsPage && !isTeachersPage);

// Extensions treated as slides (PNG images, not iframes or video)
const SLIDE_EXTS = new Set([".pdf", ".ppt", ".pptx"]);

// ---------------------------------------------------------------------------
// Issue #85: авторизація запитів викладача (персональний PIN облікового запису)
// ---------------------------------------------------------------------------

/**
 * Авторизаційні заголовки для захищених запитів керування:
 *  - X-Portal-Pin — сам PIN (адміністративний PORTAL_PIN або персональний);
 *  - X-Portal-Teacher — ідентифікатор облікового запису викладача. Він потрібен
 *    серверу, щоб перевіряти САМЕ цей запис (активність, ліміт спроб) і не
 *    приймати персональний PIN за адміністративний. Для адміністратора
 *    (після входу за PORTAL_PIN) цього заголовка немає — він і раніше
 *    авторизувався лише X-Portal-Pin.
 */
function applyAuthHeaders(headers) {
  if (pin) headers["X-Portal-Pin"] = pin;
  if (teacherId) headers["X-Portal-Teacher"] = teacherId;
  return headers;
}

/**
 * Обробка відповіді входу POST /api/auth/verify: сервер або підтверджує
 * адміністратора (admin: true), або називає обліковий запис викладача
 * (teacherId + fullName). Обидва випадки — role "teacher" для клієнта;
 * PIN у відповідь не приходить (лише зберігається з форми входу).
 */
function applyLoginResponse(data) {
  teacherId = data && data.teacherId ? String(data.teacherId) : "";
  isAdmin = Boolean(data && data.admin);
  // Зберігаємо ПІБ викладача/адміністратора для відображення біля кнопки «Вийти»
  teacherFullName = data && data.fullName ? String(data.fullName) : "";
  if (teacherId) sessionStorage.setItem("portalTeacherId", teacherId);
  else sessionStorage.removeItem("portalTeacherId");
  if (teacherFullName) sessionStorage.setItem("portalTeacherFullName", teacherFullName);
  else sessionStorage.removeItem("portalTeacherFullName");
  if (isAdmin) sessionStorage.setItem("portalAdmin", "1");
  else sessionStorage.removeItem("portalAdmin");
}

/** Issue #85: очищення контексту облікового запису (вихід або вхід як учень) */
function clearLoginContext() {
  teacherId = "";
  teacherFullName = "";
  isAdmin = false;
  sessionStorage.removeItem("portalTeacherId");
  sessionStorage.removeItem("portalTeacherFullName");
  sessionStorage.removeItem("portalAdmin");
}

function setStatus(text) {
  if ($("status")) {
    $("status").textContent = text;
    // Issue #75 (доробка): у рядку з заголовком «Спільний екран» статус може
    // обрізатися еліпсисом — повний текст завжди доступний у підказці
    $("status").title = text;
  }
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
    const response = await fetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: ensureStudentId(), name: studentDisplayName, active })
    });
    // Issue #63 (Етап 5): сесію скасовано (перезапуск сервера) — вхід заново
    if (response.status === 401) handleSessionExpired();
  } catch { /* silent */ }
}

let heartbeatTimer = null;

/** Старт heartbeat учня (перший виклик у setRole), далі — за інтервалом */
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // Issue #83: перший heartbeat — НЕГАЙНО, а не через 2 с: сервер прив'язує
  // studentId до сесії саме в ньому, і відповідь на тестування до прив'язки
  // відхиляється більшістю (409)
  void sendHeartbeat();
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
// Вихід вчителя: зупинка демонстрації при закритті вкладки (Issue #63).
// Довга відсутність вчителя на сайті демонстрацію НЕ зупиняє — автозупинку
// прибрано рішенням власника (2026-11-12), див. DECISIONS.md.
// ---------------------------------------------------------------------------

/**
 * Закриття вкладки викладачем (pagehide): sendBeacon несе PIN у тілі, бо не
 * дозволяє заголовки; якщо показ активний — сервер зупиняє його одразу.
 */
function reportTeacherLeave() {
  if (role !== "teacher" || !pin) return;
  const body = JSON.stringify({ pin, teacherId, stop: true });
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
  // Issue #79: конфігурація сигналів потрібна викладачу для іконок у рядках
  // учнів і біля лічильника (перезавантажується після кожної CRUD-операції)
  void loadSignalConfig();
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
    applyAuthHeaders(headers);
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
  lastStudentsList = Array.isArray(list) ? list : [];
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
      // Issue #75 (доробка за зворотним зв'язком власника): статус — лише
      // крапка відповідного кольору; назва стану лишається в title/aria-label
      const statusDot = s.online
        ? '<span class="status-dot status-dot-online" title="Онлайн" role="img" aria-label="Онлайн"></span>'
        : '<span class="status-dot status-dot-offline" title="Неактивний" role="img" aria-label="Неактивний"></span>';
      // Issue #75: ім'я та IP-адреса в ОДНОМУ рядку (IP — дрібним сірим одразу
      // після імені); без IP рядок не показується, сервер надає s.ip із запиту
      const ipLine = s.ip
        ? '<span class="student-ip">' + esc(s.ip) + "</span>"
        : "";
      // Issue #83: обраний варіант біля імені (вчитель бачить у реальному
      // часі). Дані — із персонального поля state.testing (лише в нього є
      // answers): показуються лише коли є поточне запитання, тобто під час
      // активного тестування та після завершення (результати зберігаються)
      const testingAnswers = (role === "teacher" && testingState &&
        testingState.question && testingState.answers)
        ? testingState.answers : null;
      let answerLabel = "";
      if (testingAnswers) {
        const value = Number.isInteger(testingAnswers[s.id])
          ? testingAnswers[s.id] : null;
        answerLabel = value !== null
          ? '<span class="student-test-answer" title="Обраний варіант">' +
            esc(TESTING_VARIANT_LETTERS[value] || "?") + "</span>"
          : '<span class="student-test-answer is-missing" title="Відповіді ще немає">—</span>';
      }
      // Issue #79: іконки сигналів праворуч у рядку, біля крапки онлайн (без
      // текстових написів): колір — із налаштувань сигналу, активний сигнал —
      // стан is-active з серверного персонального стану; офлайн-учню іконка
      // недоступна (сервер усе одно перевіряє адресата)
      const signalBtns = (role === "teacher" && signalConfig.length)
        ? '<span class="student-signals">' + signalConfig.map((sig) => {
            const active = findActiveSignal(sig.id, s.id);
            const label = "Сигнал «" + sig.text + "»" + (s.online ? "" : " — учень офлайн");
            return '<button type="button" class="signal-send-btn' + (active ? " is-active" : "") +
              '" data-signal-id="' + esc(sig.id) + '" data-target="' + esc(s.id) +
              '" style="color:' + esc(sig.color) + '" title="' + esc(label) +
              '" aria-label="' + esc(label) + '"' + (s.online ? "" : " disabled") + ">" +
              signalIconSvg(sig.icon) + "</button>";
          }).join("") + "</span>"
        : "";
      item.innerHTML =
        '<span class="student-info">' +
        '<span class="student-name">' + esc(s.name) + "</span>" +
        ipLine +
        answerLabel +
        "</span>" +
        signalBtns +
        statusDot;
      root.append(item);
    }
  }
}

// ---------------------------------------------------------------------------
// Issue #79: універсальні візуальні сигнали учням
// ---------------------------------------------------------------------------

/** Конфігурація сигналів викладача та доступний набір іконок (GET /api/signals) */
let signalConfig = [];
let signalIcons = [];
/** Останній список присутності — для повторного рендеру рядків без опитування */
let lastStudentsList = [];
/** Активні сигнали у вигляді викладача (поле signals стану / відповідь send) */
let activeSignalsState = [];
/** Ключ активних станів — щоб не перерисовувати іконки на кожне опитування */
let activeSignalsKey = "";

/** Іконка сигналу зі спрайта (колір задається інлайн-стилем кнопки) */
function signalIconSvg(icon) {
  return '<svg class="ui-icon" aria-hidden="true"><use href="/icons.svg#' + esc(icon) + '"></use></svg>';
}

/** Активний запис для пари (сигнал, ціль) — активний стан іконок */
function findActiveSignal(signalId, target) {
  return activeSignalsState.find((entry) =>
    entry.signalId === signalId && entry.target === target
  ) || null;
}

/** Завантаження конфігурації: список сигналів + набір іконок (лише викладач) */
async function loadSignalConfig() {
  if (role !== "teacher" || !pin) return;
  try {
    const headers = {};
    applyAuthHeaders(headers);
    const response = await api("/api/signals", { headers });
    const data = await response.json();
    signalConfig = Array.isArray(data.signals) ? data.signals : [];
    signalIcons = Array.isArray(data.icons) ? data.icons : [];
    fillSignalIconSelect();
    renderSignalList();
    renderGroupSignalIcons();
    renderStudentsList(lastStudentsList);
  } catch { /* без конфігурації іконки сигналів просто не показуються */ }
}

/** Наповнення select іконками зі спрайта проєкту (значення — id символів) */
function fillSignalIconSelect() {
  const select = $("signalIconSelect");
  if (!select) return;
  select.replaceChildren();
  for (const name of signalIcons) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  if (signalIcons.length && !select.value) select.value = signalIcons[0];
}

/** Список сигналів у підблоку: іконка + напис + параметри + дії */
function renderSignalList() {
  const root = $("signalList");
  if (!root) return;
  root.replaceChildren();
  if (!signalConfig.length) {
    root.innerHTML = '<div class="empty">Сигналів ще немає — створіть перший.</div>';
    return;
  }
  const sorted = signalConfig.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const sig of sorted) {
    const flags = [sig.duration + " с", sig.opacity + "%"];
    if (sig.untilDismiss) flags.push("до зняття");
    if (sig.forAll) flags.push("для всіх");
    const item = document.createElement("div");
    item.className = "signal-item";
    item.dataset.id = sig.id;
    item.innerHTML =
      '<span class="signal-item-icon" style="color:' + esc(sig.color) + '">' + signalIconSvg(sig.icon) + "</span>" +
      '<span class="signal-item-text">' + esc(sig.text) + "</span>" +
      '<span class="signal-item-meta hint">' + esc(flags.join(" · ")) + "</span>" +
      '<span class="row signal-item-actions">' +
      iconAction("preview", "Попередній перегляд", "eye", sig.text) +
      iconAction("edit", "Редагувати", "edit", sig.text) +
      iconAction("up", "Вище", "arrow-up", sig.text) +
      iconAction("down", "Нижче", "arrow-down", sig.text) +
      iconAction("delete", "Видалити", "trash-2", sig.text) +
      "</span>";
    root.append(item);
  }
}

/** Кнопка-іконка дії в рядку сигналу (дії ловляться делегуванням на #signalList) */
function iconAction(act, title, icon, text) {
  const label = title + " сигнал «" + text + "»";
  return '<button type="button" class="secondary btn-sm icon-btn" data-act="' + act +
    '" title="' + esc(title) + '" aria-label="' + esc(label) + '">' +
    signalIconSvg(icon) + "</button>";
}

/** Групові сигнали («Застосувати для всіх») — одразу біля лічильника учнів */
function renderGroupSignalIcons() {
  const root = $("studentsGroupSignals");
  if (!root) return;
  root.replaceChildren();
  const forAll = signalConfig.filter((sig) => sig.forAll)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const sig of forAll) {
    const active = findActiveSignal(sig.id, "all");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "group-signal-btn" + (active ? " is-active" : "");
    btn.dataset.signalId = sig.id;
    btn.dataset.target = "all";
    btn.style.color = sig.color;
    btn.title = "Сигнал для всіх: " + sig.text;
    btn.setAttribute("aria-label", "Сигнал для всіх учнів: " + sig.text);
    btn.innerHTML = signalIconSvg(sig.icon);
    root.append(btn);
  }
}

/** Оновлення станів іконок викладача з нового переліку активних сигналів */
function applyTeacherSignals(list) {
  const next = Array.isArray(list) ? list : [];
  activeSignalsState = next;
  const key = next.map((e) => e.id + ":" + e.signalId + ":" + e.target).join("|");
  if (key === activeSignalsKey) return;
  activeSignalsKey = key;
  renderStudentsList(lastStudentsList);
  renderGroupSignalIcons();
}

/**
 * Натискання іконки сигналу: активний сигнал «до зняття» знімається повторним
 * натисканням, сигнал із тривалістю — перенадсилається (сервер перезапускає
 * таймер); відповідь сервера оновлює стани іконок без очікування опитування.
 */
async function handleSignalButtonClick(signalId, target) {
  const conf = signalConfig.find((sig) => sig.id === signalId);
  if (!conf || role !== "teacher") return;
  const active = findActiveSignal(signalId, target);
  const action = active && active.untilDismiss ? "dismiss" : "send";
  try {
    const headers = { "Content-Type": "application/json" };
    applyAuthHeaders(headers);
    const response = await api("/api/signals/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify({ signalId, target })
    });
    const data = await response.json();
    if (!response.ok) {
      showToast("⚠️ " + (data.message || "Не вдалося виконати сигнал"), "warning");
      return;
    }
    applyTeacherSignals(data.active || []);
  } catch {
    if (sessionExpiredHandled) return; // оброблено api()
    showToast("⚠️ Немає зв'язку зі сервером", "warning");
  }
}

// --- Оверлей ефекту: учень бачить сигнали, викладач — попередній перегляд ---

let signalEffectTimer = null;
let signalSteadyTimer = null;
let currentSignalId = "";

function clearSignalTimers() {
  if (signalEffectTimer) { clearTimeout(signalEffectTimer); signalEffectTimer = null; }
  if (signalSteadyTimer) { clearTimeout(signalSteadyTimer); signalSteadyTimer = null; }
}

/** Приховати оверлей (таймер тривалості, завершення показу, кінець стану) */
function hideSignalEffect() {
  clearSignalTimers();
  currentSignalId = "";
  const overlay = $("signalOverlay");
  if (!overlay) return;
  overlay.style.display = "none";
  overlay.classList.remove("signal-overlay-steady");
  const textEl = overlay.querySelector(".signal-overlay-text");
  if (textEl) textEl.textContent = "";
}

/**
 * Показати сигнал: рамка зі світінням і напис поверх матеріалу. Повторне
 * надсилання приходить з новим id — анімації й таймер стартують заново;
 * «до зняття» після початкової анімації переходить у спокійний стан і лишається
 * до зняття (таймер не встановлюється).
 */
function showSignalEffect(signal) {
  const overlay = $("signalOverlay");
  if (!overlay) return;
  const textEl = overlay.querySelector(".signal-overlay-text");
  clearSignalTimers();
  overlay.classList.remove("signal-overlay-steady");
  overlay.style.setProperty("--signal-color", signal.color || "#e03131");
  const opacity = Number(signal.opacity);
  const opacityRatio = Number.isFinite(opacity)
    ? Math.min(100, Math.max(0, opacity)) / 100
    : 0.75;
  overlay.style.setProperty("--signal-opacity", String(opacityRatio));
  if (textEl) textEl.textContent = signal.text || "";
  overlay.style.display = "block";
  currentSignalId = signal.id;
  // Рестарт CSS-анімацій: зміна layout форсує перезапуск keyframes
  void overlay.offsetWidth;
  if (signal.untilDismiss) {
    // Постійний сигнал: початкова анімація, далі — дуже ненав'язливе пульсування
    signalSteadyTimer = setTimeout(() => overlay.classList.add("signal-overlay-steady"), 1600);
  } else {
    const durationMs = Number(signal.durationMs) > 0 ? Number(signal.durationMs) : 3000;
    signalEffectTimer = setTimeout(hideSignalEffect, durationMs);
  }
}

/**
 * Обробка персонального поля signals стану для учня: показується найновіший
 * активний сигнал (індивідуальний чи груповий); коли він завершується —
 * наступний, якщо є; без активних сигналів оверлей приховується. Зупинка
 * показу на сервері очищає перелік — оверлей зникає автоматично.
 */
function applyStudentSignals(list) {
  const active = Array.isArray(list) ? list : [];
  if (!active.length) {
    if (currentSignalId) hideSignalEffect();
    return;
  }
  const primary = active.slice()
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  if (currentSignalId === primary.id) return;
  showSignalEffect(primary);
}

/** Попередній перегляд викладача — локально, без надсилання учням */
function previewSignal(sig) {
  showSignalEffect({
    id: "preview_" + Date.now(),
    text: sig.text,
    color: sig.color,
    opacity: sig.opacity,
    // Для «до зняття» показ обмежується, щоб попередній перегляд не завис
    durationMs: sig.untilDismiss ? 5000 : sig.duration * 1000,
    untilDismiss: false,
    startedAt: Date.now()
  });
}

// --- Форма створення/редагування та дії зі списком ---

function openSignalForm(sig) {
  const form = $("signalForm");
  if (!form) return;
  form.dataset.editingId = sig ? sig.id : "";
  if ($("signalFormStatus")) $("signalFormStatus").textContent = "";
  fillSignalIconSelect();
  const set = (id, value) => { if ($(id)) $(id).value = value; };
  const setChecked = (id, value) => { if ($(id)) $(id).checked = value; };
  set("signalTextInput", sig ? sig.text : "");
  set("signalIconSelect", sig ? sig.icon : (signalIcons[0] || "monitor-play"));
  set("signalColorInput", sig ? sig.color : "#e03131");
  set("signalOpacityInput", String(sig ? sig.opacity : 75));
  set("signalDurationInput", String(sig ? sig.duration : 3));
  setChecked("signalUntilDismissInput", sig ? Boolean(sig.untilDismiss) : false);
  setChecked("signalForAllInput", sig ? Boolean(sig.forAll) : false);
  form.style.display = "grid";
  if ($("signalTextInput")) $("signalTextInput").focus();
}

function closeSignalForm() {
  const form = $("signalForm");
  if (!form) return;
  form.style.display = "none";
  form.dataset.editingId = "";
}

/** POST-запит викладача зі заголовком PIN; повертає data або null + тост */
async function signalApiCall(url, payload) {
  const headers = { "Content-Type": "application/json" };
  applyAuthHeaders(headers);
  const response = await api(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) {
    showToast("⚠️ " + (data.message || "Не вдалося виконати дію"), "warning");
    return null;
  }
  return data;
}

async function saveSignalForm() {
  const form = $("signalForm");
  const editingId = (form && form.dataset.editingId) || "";
  const text = $("signalTextInput") ? $("signalTextInput").value.trim() : "";
  if (!text) {
    if ($("signalFormStatus")) $("signalFormStatus").textContent = "Вкажіть напис сигналу.";
    return;
  }
  const payload = {
    text,
    icon: $("signalIconSelect") ? $("signalIconSelect").value : "monitor-play",
    color: $("signalColorInput") ? $("signalColorInput").value : "#e03131",
    opacity: $("signalOpacityInput") ? Number($("signalOpacityInput").value) : 75,
    duration: $("signalDurationInput") ? Number($("signalDurationInput").value) : 3,
    untilDismiss: $("signalUntilDismissInput") ? $("signalUntilDismissInput").checked : false,
    forAll: $("signalForAllInput") ? $("signalForAllInput").checked : false
  };
  try {
    const url = editingId ? "/api/signals/update" : "/api/signals/create";
    if (editingId) payload.signalId = editingId;
    const data = await signalApiCall(url, payload);
    if (!data) {
      if ($("signalFormStatus")) $("signalFormStatus").textContent = "Не вдалося зберегти сигнал.";
      return;
    }
    closeSignalForm();
    await loadSignalConfig();
  } catch {
    if (sessionExpiredHandled) return;
    if ($("signalFormStatus")) $("signalFormStatus").textContent = "Немає зв'язку зі сервером.";
  }
}

// --- Делеговані обробники (кнопки створюються/перестворюються динамічно) ---

document.addEventListener("click", (event) => {
  if (!event.target || !event.target.closest) return;
  const btn = event.target.closest(".signal-send-btn, .group-signal-btn");
  if (!btn) return;
  void handleSignalButtonClick(btn.dataset.signalId, btn.dataset.target);
});

document.addEventListener("click", async (event) => {
  if (!event.target || !event.target.closest) return;
  const btn = event.target.closest("#signalList [data-act]");
  if (!btn) return;
  const item = btn.closest(".signal-item");
  const sig = item ? signalConfig.find((s) => s.id === item.dataset.id) : null;
  if (!sig) return;
  const act = btn.dataset.act;
  if (act === "preview") { previewSignal(sig); return; }
  if (act === "edit") { openSignalForm(sig); return; }
  if (act === "up" || act === "down") {
    if (await signalApiCall("/api/signals/reorder", { signalId: sig.id, direction: act })) {
      await loadSignalConfig();
    }
    return;
  }
  if (act === "delete") {
    if (!window.confirm("Видалити сигнал «" + sig.text + "»?")) return;
    if (await signalApiCall("/api/signals/delete", { signalId: sig.id })) {
      await loadSignalConfig();
    }
  }
});

document.addEventListener("DOMContentLoaded", () => {
  if ($("signalAddBtn")) $("signalAddBtn").addEventListener("click", () => openSignalForm(null));
  if ($("signalSaveBtn")) $("signalSaveBtn").addEventListener("click", () => void saveSignalForm());
  if ($("signalCancelBtn")) $("signalCancelBtn").addEventListener("click", closeSignalForm);
});

// ---------------------------------------------------------------------------
// Issue #83: MVP системи тестування під час демонстрації
// ---------------------------------------------------------------------------
// Стан приходить у персональному полі state.testing наявного /api/state
// (той самий механізм, що й сигнали в Issue #79): вчителю — статус, кількість
// варіантів, поточне запитання, гістограма й відповіді учнів; учневі — лише
// статус і його власний вибір (yourAnswer). Запис відповіді — POST
// /api/testing/answer (лише сесія учня, studentId сервер бере з прив'язки).

/** Написи варіантів у порядку індексів (0 → А … 3 → Г), як на сервері */
const TESTING_VARIANT_LETTERS = ["А", "Б", "В", "Г"];

/** Останній отриманий стан тестування (state.testing) або null */
let testingState = null;
/** Ключ попереднього стану — щоб не перерисовувати інтерфейс на кожне опитування */
let testingStateKey = null;
/** Кількість варіантів, обрана вчителем для НАСТУПНОГО старту (3 | 4) */
let testOptionCount = 3;
/** Захист від повторних натискань, поки запит до сервера виконується */
let testingBusy = false;

/** JSON-ключ стану (порівняння без глибокої різниці об'єктів) */
function testingKeyOf(view) {
  return view ? JSON.stringify(view) : "";
}

/**
 * Застосувати новий стан тестування (з опитування або з відповіді запиту).
 * @param {object|null} view — state.testing або data.testing з відповіді
 * @param {boolean} force — перерисувати навіть за однакового ключа
 */
function applyTestingState(view, force = false) {
  const next = view || null;
  const key = testingKeyOf(next);
  if (!force && key === testingStateKey) return false;
  testingStateKey = key;
  testingState = next;
  // Поки тестування не запущено, вчитель бачить лише свій вибір перемикача,
  // тому кількість варіантів оновлюємо ТІЛЬКИ з активного/завершеного стану —
  // інакше кожне опитування відкочувало б його до серверного значення
  if (next && next.status !== "idle" && (next.options === 3 || next.options === 4)) {
    testOptionCount = next.options;
  }
  renderTestUI();
  return true;
}

/** Повне оновлення UI тестування: панель вчителя, кнопки учня, бейдж, список */
function renderTestUI() {
  renderTestingPanel();
  renderTestAnswerBar();
  updateViewerTestBadge();
  renderStudentsList(lastStudentsList);
}

/** Панель керування тестуванням у окремому блоці «Тестування» (лише викладач) */
function renderTestingPanel() {
  const panel = $("testPanel");
  if (!panel) return;
  const view = role === "teacher" ? testingState : null;
  const status = view ? view.status : "idle";
  const active = status === "active";

  // Перемикач кількості варіантів: активний лише до старту
  const opt3 = $("testOpt3");
  const opt4 = $("testOpt4");
  const shownOptions = active && view.options === 4 ? 4 : (active ? 3 : testOptionCount);
  if (opt3) {
    opt3.setAttribute("aria-pressed", String(shownOptions === 3));
    opt3.disabled = active;
  }
  if (opt4) {
    opt4.setAttribute("aria-pressed", String(shownOptions === 4));
    opt4.disabled = active;
  }

  // Кнопка дії: Почати → Завершити → Нове тестування
  const toggle = $("testToggleBtn");
  if (toggle) {
    toggle.textContent = status === "active"
      ? "Завершити тестування"
      : (status === "finished" ? "Нове тестування" : "Тестування");
  }

  // Текст стану
  const statusEl = $("testStatus");
  if (statusEl) statusEl.textContent = testingStatusText(view);

  // Гістограма: лише коли є поточне запитання (активне або завершене)
  const histogramEl = $("testHistogram");
  if (histogramEl) {
    const histogram = view && view.question && Array.isArray(view.histogram)
      ? view.histogram : null;
    if (!histogram) {
      histogramEl.replaceChildren();
      histogramEl.style.display = "none";
    } else {
      renderTestHistogram(histogramEl, view);
      histogramEl.style.display = "";
    }
  }
}

/** Текст рядка стану під перемикачем */
function testingStatusText(view) {
  if (!view || view.status === "idle") {
    return "Тестування не активне. Оберіть кількість варіантів і натисніть «Тестування».";
  }
  const question = view.question ? view.question.page : 0;
  if (view.status === "finished") {
    return "Тестування завершено вручну — відповіді заблоковано" +
      (question ? ". Останнє запитання: слайд " + question + "." : ".");
  }
  if (view.accepting) {
    return "Приймання відкрито: запитання, слайд " + question +
      ". Варіанти: " + TESTING_VARIANT_LETTERS.slice(0, view.options).join(", ") + ".";
  }
  if (question) {
    return "Тестування активне, але на цьому слайді запитання немає — приймання зачинено " +
      "(слайд запитання: " + question + ").";
  }
  return "Тестування активне. Відкрийте парний слайд — там з'являться варіанти відповіді.";
}

/** Гістограма відповідей поточного запитання (варіант → смуга → кількість) */
function renderTestHistogram(root, view) {
  root.replaceChildren();
  const histogram = view.histogram;
  const total = histogram.reduce((sum, n) => sum + (Number(n) || 0), 0);
  const max = Math.max(1, ...histogram.map((n) => Number(n) || 0));

  for (let i = 0; i < histogram.length; i += 1) {
    const count = Number(histogram[i]) || 0;
    const row = document.createElement("div");
    row.className = "test-hist-row";
    row.innerHTML =
      '<span class="test-hist-label">' + esc(TESTING_VARIANT_LETTERS[i] || "?") + "</span>" +
      '<span class="test-hist-track"><span class="test-hist-bar" style="width:' +
      Math.round((count / max) * 100) + '%"></span></span>' +
      '<span class="test-hist-count">' + count + "</span>";
    root.append(row);
  }
  const summary = document.createElement("div");
  summary.className = "hint test-hist-summary";
  summary.textContent = total
    ? "Відповіли: " + total + " учн. (останній вибір кожного)"
    : "Відповідей ще немає";
  root.append(summary);
}

/** Кнопки відповіді учня ПІД глядачем: лише поки сервер відкриває приймання */
function renderTestAnswerBar() {
  const bar = $("testAnswerBar");
  if (!bar) return;
  const view = testingState;
  const show = role === "student" && Boolean(view) &&
    view.status === "active" && view.accepting === true;
  if (!show) {
    bar.style.display = "none";
    bar.replaceChildren();
    bar.removeAttribute("data-options");
    return;
  }
  const count = view.options === 4 ? 4 : 3;
  const selected = Number.isInteger(view.yourAnswer) ? view.yourAnswer : -1;
  bar.style.display = "";

  // Кнопки створюються лише при зміні кількості варіантів (інакше кожне
  // опитування знищував би фокус із натиснутої кнопки)
  if (bar.dataset.options !== String(count)) {
    bar.dataset.options = String(count);
    bar.replaceChildren();
    for (let i = 0; i < count; i += 1) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "test-answer-btn";
      btn.dataset.variant = String(i);
      btn.textContent = TESTING_VARIANT_LETTERS[i];
      bar.append(btn);
    }
    // Таймер до авто-кліку «Вперед» праворуч від варіантів (уточнення
    // власника 11-11-2026): створюється разом із кнопками — приховування
    // смуги прибирає його разом зі вмістом (replaceChildren)
    const timer = document.createElement("span");
    timer.id = "testAnswerTimer";
    timer.className = "test-answer-timer";
    bar.append(timer);
  }
  for (const btn of bar.querySelectorAll(".test-answer-btn")) {
    const index = Number(btn.dataset.variant);
    const isSelected = index === selected;
    btn.classList.toggle("is-selected", isSelected);
    btn.setAttribute("aria-pressed", String(isSelected));
  }
}

// ---------------------------------------------------------------------------
// Issue #83 (уточнення власника 11-11-2026): таймер до авто-кліку «Вперед»
// у смузі відповіді учня. Знімок публікує модуль autoNext.js вчителя через
// POST /api/control { autoNext }; учень застосовує ЛИШЕ новий seq (інакше
// опитування /api/state ~0,5 с перезапускало б локальний дедлайн). Локальний
// дедлайн = Date.now() + remainingMs у момент ОТРИМАННЯ — без синхронізації
// годинників між пристроями (похибка ≤ затримка опитування ~0,5 с).
// Смуга (#testAnswerBar) — індикатор: заливка прив'язана ліворуч
// (--an-fill), права межа рухається ліворуч, колір від світло-зеленого
// до світло-червоного за залишком часу (--an-color).
// ---------------------------------------------------------------------------
let autoNextSeq = -1;
let autoNextDeadline = 0;
let autoNextTotalMs = 1;
let autoNextTimerId = null;

/** Світло-зелений #90EE90 (144,238,144) → світло-червоний #F08080 (240,128,128) */
function autoNextFillColor(frac) {
  const green = [144, 238, 144];
  const red = [240, 128, 128];
  const c = green.map((v, i) => Math.round(red[i] + (v - red[i]) * frac));
  return "rgb(" + c[0] + ", " + c[1] + ", " + c[2] + ")";
}

function clearAutoNextTimerUi() {
  const bar = $("testAnswerBar");
  if (bar) {
    bar.style.removeProperty("--an-fill");
    bar.style.removeProperty("--an-color");
    bar.removeAttribute("data-autonext");
  }
  const timer = $("testAnswerTimer");
  if (timer) timer.textContent = "";
}

/** 5 оновлень/сек — той самий кадр, що й таймер панелі вчителя */
function tickAutoNextTimer() {
  const bar = $("testAnswerBar");
  if (!bar || !bar.getClientRects().length) return; // смуга прихована
  const timer = $("testAnswerTimer");
  if (!timer) return; // смугу перестворили — наступний тік знайде новий елемент
  const remain = Math.max(0, autoNextDeadline - Date.now());
  const frac = autoNextTotalMs > 0 ? Math.min(1, remain / autoNextTotalMs) : 0;
  const remainSec = Math.ceil(remain / 1000);
  timer.textContent =
    String(Math.floor(remainSec / 60)).padStart(2, "0") + ":" +
    String(remainSec % 60).padStart(2, "0");
  bar.style.setProperty("--an-fill", (frac * 100).toFixed(2) + "%");
  bar.style.setProperty("--an-color", autoNextFillColor(frac));
  bar.setAttribute("data-autonext", "on");
}

function applyAutoNextState(snap) {
  if (!snap || typeof snap.seq !== "number" || snap.seq === autoNextSeq) return;
  autoNextSeq = snap.seq;
  if (snap.running) {
    const remaining = Number(snap.remainingMs);
    const total = Number(snap.totalMs);
    autoNextDeadline = Date.now() +
      (Number.isFinite(remaining) && remaining > 0 ? remaining : 0);
    autoNextTotalMs = Number.isFinite(total) && total > 0 ? total : 1;
    if (autoNextTimerId === null) {
      autoNextTimerId = setInterval(tickAutoNextTimer, 200);
    }
    tickAutoNextTimer();
  } else {
    if (autoNextTimerId !== null) {
      clearInterval(autoNextTimerId);
      autoNextTimerId = null;
    }
    autoNextDeadline = 0;
    clearAutoNextTimerUi();
  }
}

/**
 * Бейдж із власним вибраного варіанта у куті глядача — на слайді-відповіді
 * (непарний номер більший за 1). Псевдоелемент #viewer[data-test-answer]::after
 * переживає перестворення вмісту глядача при зміні слайда.
 */
function updateViewerTestBadge() {
  const viewer = $("viewer");
  if (!viewer) return;
  const page = sharedState && sharedState.file ? Number(sharedState.page) || 1 : 1;
  const onAnswerSlide = Boolean(sharedState && sharedState.file) && page > 1 && page % 2 === 1;
  const show = role === "student" && onAnswerSlide && testingState &&
    testingState.status !== "idle" && Number.isInteger(testingState.yourAnswer);
  if (show) {
    viewer.setAttribute(
      "data-test-answer",
      TESTING_VARIANT_LETTERS[testingState.yourAnswer] || ""
    );
  } else {
    viewer.removeAttribute("data-test-answer");
  }
}

/** POST із PIN-заголовком для операцій вчителя; помилки — текст із сервера */
async function testingApiCall(url, body) {
  const headers = { "Content-Type": "application/json" };
  applyAuthHeaders(headers);
  const response = await api(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {})
  });
  return response.json();
}

/** Натискання кнопки варіанта учнем (кнопки створюються динамічно) */
async function submitTestAnswer(index) {
  if (role !== "student" || testingBusy) return;
  const view = testingState;
  if (!view || view.status !== "active" || view.accepting !== true) return;
  const limit = view.options === 4 ? 4 : 3;
  if (!Number.isInteger(index) || index < 0 || index >= limit) return;
  testingBusy = true;
  try {
    const data = await testingApiCall("/api/testing/answer", { variant: index });
    applyTestingState(data && data.testing, true);
  } catch (error) {
    showToast("⚠️ " + (error.message || "Не вдалося надіслати відповідь"), "warning");
  } finally {
    testingBusy = false;
  }
}

/** Кнопка «Тестування / Завершити тестування / Нове тестування» (викладач) */
async function handleTestToggle() {
  if (role !== "teacher" || testingBusy) return;
  const status = testingState ? testingState.status : "idle";
  const starting = status !== "active";
  const toggle = $("testToggleBtn");
  testingBusy = true;
  if (toggle) toggle.disabled = true;
  try {
    const data = starting
      ? await testingApiCall("/api/testing/start", { options: testOptionCount })
      : await testingApiCall("/api/testing/finish", {});
    applyTestingState(data && data.testing, true);
    renderStudentsList(lastStudentsList);
  } catch (error) {
    showToast("⚠️ " + (error.message || "Не вдалося виконати дію"), "warning");
  } finally {
    testingBusy = false;
    if (toggle) toggle.disabled = false;
  }
}

/** Вибір кількості варіантів (3 | 4) — лише коли тестування не активне */
function setTestOptions(count) {
  if (role !== "teacher" || testingBusy) return;
  if (testingState && testingState.status === "active") return;
  testOptionCount = count === 4 ? 4 : 3;
  renderTestingPanel();
}

document.addEventListener("click", (event) => {
  if (!event.target || !event.target.closest) return;
  const btn = event.target.closest("#testAnswerBar .test-answer-btn");
  if (!btn) return;
  void submitTestAnswer(Number(btn.dataset.variant));
});

document.addEventListener("DOMContentLoaded", () => {
  for (const id of ["testOpt3", "testOpt4"]) {
    const btn = $(id);
    if (btn) btn.addEventListener("click", () => setTestOptions(Number(btn.dataset.options)));
  }
  if ($("testToggleBtn")) $("testToggleBtn").addEventListener("click", () => void handleTestToggle());
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
/**
 * Issue #63 (Етап 5): 401 на будь-якому контентному запиті означає, що сесії
 * більше немає (перезапуск сервера, вихід, скасування старої cookie) — усі
 * попередні входи невалідні, тому користувач проходить вхід заново.
 */
let sessionExpiredHandled = false;

function handleSessionExpired() {
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  stopHeartbeat();
  stopPresencePolling();
  // Issue #75: без чинної сесії стан показу не опитується — повертаємо учня
  // до звичайного режиму (разом із виходом із fullscreen, якщо ввійшли нашою
  // кнопкою), щоб розгорнутий режим не залишився після перезапуску сервера
  setDemoFocus(false);
  role = "";
  pin = "";
  localStorage.setItem("portalRole", "");
  sessionStorage.removeItem("portalPin");
  updateRoleUI();
  openRoleModal();
  showToast("Сесію завершено (перезапуск сервера або вихід) — увійдіть заново.", "warning", 8000);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    handleSessionExpired();
    throw new Error("Сесію не знайдено — увійдіть заново");
  }
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
  // Issue #63 (доробка/Етап 5): PIN більше НЕ передається у URL медіа (?pin=
  // потрапляв в історію браузера при відкритті зображення в новій вкладці, у
  // журнали звернень і в адресний рядок). Замість цього сесія видається
  // HttpOnly cookie при вході (POST /api/auth/verify для вчителя,
  // POST /api/auth/session для учня), і браузер сам додає її до
  // <img>/<video>/слайдів — у мережевих запитах URL лишається чистим.
  // Без чинної сесії медіа недоступні (401), після перезапуску сервера сесія
  // відновлюється лише повторним входом.
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
    // Якщо цей <img> уже замінено іншим показом (дані зіткнення застаріли),
    // його відміна не має чіпати поточний вміст глядача
    if (img.parentNode !== viewer) return;
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
      try {
        const res = await api("/api/slides/prepare", {
          method: "POST",
          headers: applyAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ file: name })
        });
        pageCount = (await res.json()).pageCount;
      } catch (e) {
        // Issue #88 (рев'ю): для спільних/legacy-файлів (owner === null) сервер
        // відмовляє в prepare — викладач не змінює їх стан. Приватний перегляд
        // лишається можливим через той самий шлях, що й учень: перший запит PNG
        // сам запускає конвертацію (без запису в metadata конвертації), а потім
        // /api/slides/info повертає готовий маніфест. Чужий файл (іншого
        // викладача) цим шляхом недоступний — показуємо відмову сервера.
        const shared = e && e.message && e.message.includes("спільній бібліотеці");
        if (!shared) throw e;
        const probe = await fetch(slideUrl(name, page));
        if (!probe.ok) throw new Error(await probe.text());
        const infoRes = await fetch("/api/slides/info?file=" + encodeURIComponent(name));
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info.ready) pageCount = info.pageCount;
        }
      }
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

  // Formatted teacher name: Прізвище І.П.
  // Issue #88 (рев'ю): ініціали БЕЗ пробілу між ними — «Шевченко Т.М.».
  // Джерело — серверне ПІБ сесії (teacherFullName); адміністратор має власне
  // «🎓 Адміністратор» і цей підпис не отримує (див. нижче); неповне ПІБ без
  // помилки UI показується як є.
  function formatTeacherName(fullName) {
    if (!fullName) return "";
    const parts = fullName.trim().split(/\s+/);
    if (parts.length < 2) return fullName;
    const surname = parts[0];
    const initials = parts.slice(1).map(p => p.charAt(0).toUpperCase() + ".").join("");
    return surname + " " + initials;
  }

  // Role label shows name for students
  if ($("roleLabel")) {
    // Issue #85: адміністратор (вхід за PORTAL_PIN) відрізняється від
    // викладача з персональним PIN — у ролі ті самі права + розділ «Викладачі»
    if (isTeacher && isAdmin) $("roleLabel").textContent = "🎓 Адміністратор";
    else if (isTeacher && teacherFullName) {
      $("roleLabel").textContent = "🎓 " + formatTeacherName(teacherFullName);
    } else if (isTeacher) $("roleLabel").textContent = "🎓 Викладач";
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

  // Issue #85: розділ «Викладачі» (пункт меню та інші admin-only елементи)
  // бачить лише адміністратор. Приховування — зручність: реальний доступ
  // перевіряє сервер (GET /teachers і /api/teachers відхиляють усіх, крім
  // адміністративної сесії або запиту з PORTAL_PIN).
  document.querySelectorAll(".admin-only").forEach(el => {
    el.style.display = (isTeacher && isAdmin) ? "" : "none";
  });

  // Issue #63 (§3 + доробка §1): єдиний робочий простір вчителя — «Демонстрація»
  // (перегляд, додавання та учні об'єднані там). Пункти цих розділів у
  // навігації ховаються ЛИШЕ для вчителя, а сторінку «Перегляд матеріалів»
  // викладачу взагалі закрито: сервер перенаправляє прямий URL на
  // /demonstration, а клієнт робить те саме після входу на цій сторінці
  // (див. DECISIONS.md).
  if (isTeacher) {
    // Issue #75: після переходу в роль викладача учнівський розгорнутий режим
    // показу (якщо був активний) завершується — вчитель працює у звичайному
    // інтерфейсі, його системний fullscreen не чіпається
    setDemoFocus(false);
    if ($("navMaterialsLink")) $("navMaterialsLink").style.display = "none";
    if ($("navUploadLink")) $("navUploadLink").style.display = "none";
    if ($("navStudentsLink")) $("navStudentsLink").style.display = "none";
    // Issue #63 (доробка §1): викладач не працює зі сторінкою самостійного
    // перегляду — одразу переводимо на «Демонстрацію». Спрацьовує і після
    // входу прямо тут, і коли сесію викладача відновлено на вже відкритій
    // сторінці (bootstrapSession); циклів немає: /demonstration не перенаправляє
    if (isMaterialsPage) window.location.replace("/demonstration");
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
    // Issue #79: підблок «Сигнали учням» — тільки викладач, одразу під «Матеріали»
    if ($("teacherSignalsPanel")) $("teacherSignalsPanel").style.display = isTeacher ? "block" : "none";
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

/**
 * Issue #88 §4: вихід із ролі викладача. Спочатку ЧЕКАЄМО завершення logout
 * на сервері і лише після успішної відповіді — локальне очищення та редірект
 * на головну сторінку («/»). Під час очікування стан ролі не змінюється,
 * тому після помилки можна повторити натискання.
 *
 * Порядок:
 *  1) завершити спільну демонстрацію — поки є PIN і сесія ще чинна (якщо запит
 *     не дійде, показ лишиться активним: автозупинки за відсутності вчителя
 *     більше немає — рішення власника 2026-11-12);
 *  2) POST /api/auth/logout: сесію знищено на сервері, cookie очищено з тими
 *     самими атрибутами. ПОМИЛКА — не показуємо успішний вихід, ролі не
 *     скидаємо, редіректу немає — зрозуміле повідомлення і повторна спроба;
 *  3) локальне очищення (setRole("")) і window.location.replace("/") —
 *     старий cookie уже відхилений, back/reload не показує захищений вміст.
 */
async function logoutFlow() {
  // 1) Зупинка показу — до виходу, поки PIN ще дійсний (лише в із ролі викладача)
  const prevRole = role;
  if (prevRole === "teacher") {
    try {
      await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, teacherId, stop: true })
      });
    } catch { /* показ лишиться активним — не блокуємо вихід */ }
  }
  // 2) Серверний logout — обов'язково дочекуємося успіху
  try {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json().catch(() => null);
    if (!data || data.ok !== true) throw new Error("сервер не підтвердив вихід");
  } catch (error) {
    showToast("Не вдалося завершити сесію: " + error.message + ". Спробуйте ще раз.", "error", 8000);
    return false;
  }
  // 3) Успіх: локальне очищення та вихід на головну
  setRole("");
  window.location.replace("/");
  return true;
}

function setRole(newRole, newPin = "", newName = "") {
  const prevRole = role;
  // Issue #88 §4: завершення ролі (prevRole && !newRole) — ЛИШЕ локальне
  // очищення нижче. Скасування серверної сесії, зупинка показу та редірект
  // на головну виконуються logoutFlow() ДО цього виклику: він чекає успішної
  // відповіді сервера, тому стара cookie уже відхилена на момент редіректу.
  const isLogout = Boolean(prevRole && !newRole);
  role = newRole;
  sessionExpiredHandled = false;
  localStorage.setItem("portalRole", newRole);
  if (newRole === "teacher") {
    pin = newPin;
    sessionStorage.setItem("portalPin", newPin);
    studentDisplayName = "";
  } else if (newRole === "student") {
    pin = "";
    sessionStorage.removeItem("portalPin");
    // Issue #85: учень не має контексту облікового запису викладача/адміністратора
    clearLoginContext();
    if (newName) {
      studentDisplayName = newName;
      localStorage.setItem("portalStudentName", newName);
      ensureStudentId();
      // Send first heartbeat immediately
      sendHeartbeat();
    }
  } else {
    // logout (локально): серверну сесію вже скасував logoutFlow(), а зупинку
    // спільної демонстрації зробив там само — поки сесія ще була чинна
    pin = "";
    sessionStorage.removeItem("portalPin");
    // Issue #85: вихід прибирає ідентифікатор запису та адмін-прапорець —
    // наступний вхід (інший викладач або адміністратор) встановить свої заново
    clearLoginContext();
    studentDisplayName = "";
    localStorage.removeItem("portalStudentName");
    localStorage.removeItem("portalStudentId");
    studentId = "";
  }
  closeRoleModal();
  updateRoleUI();
  // Issue #88 §4: на виході каталог не перечитуємо — logoutFlow одразу веде
  // на головну сторінку (там все одно нова сесія та новий стан)
  if (isLogout) filesReady = Promise.resolve();
  else filesReady = refreshFiles();
  // Миттєвий старт опитування, якщо увійшли як викладач у поточній сесії
  // (раніше список оновлювався лише після перезавантаження сторінки)
  if (newRole === "teacher") {
    startPresencePolling();
  } else {
    stopPresencePolling();
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
  $("btnChooseStudent").onclick = async () => {
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
    // Issue #63 (Етап 5): спочатку серверна сесія, потім ролі — інакше перший
    // же запит стану демонстрації отримав би 401 і скинув би вхід
    try {
      await createStudentSession(parts.join(" "));
    } catch (error) {
      if ($("modalStudentError")) {
        $("modalStudentError").textContent = "Не вдалося увійти: " + error.message;
        $("modalStudentError").style.display = "block";
      }
      return;
    }
    setRole("student", "", parts.join(" "));
  };
}

/** Issue #63 (Етап 5): вхід учня — POST /api/auth/session (сесія на сервері) */
async function createStudentSession(name) {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || ("HTTP " + response.status));
  }
  return true;
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
      const response = await api("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: inputPin })
      });
      // Issue #85: сервер називає обліковий запис (teacherId/ПІБ) або
      // підтверджує адміністратора (admin) — це визначає подальші заголовки
      // запитів і видимість розділу «Викладачі»
      const data = await response.json().catch(() => ({}));
      applyLoginResponse(data);
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
    // Issue #88 §4: вихід — асинхронний потік: чекаємо відповіді сервера
    // перед очищенням і редіректом; при помилці лишаємось у ролі (повтор)
    if (role === "teacher") { void logoutFlow(); } else { openRoleModal(); }
  };
}

if ($("btnPromptTeacherLogin")) {
  $("btnPromptTeacherLogin").onclick = openRoleModal;
}

// ---------------------------------------------------------------------------
// Files list
// ---------------------------------------------------------------------------
async function refreshFiles() {
  // Issue #63 (доробка): самостійний перегляд опублікованих матеріалів
  // відновлено. Без входу каталогу немає (сервер → 403, а перший запит після
  // втрати сесії → 401); для учня сервер віддає ЛИШЕ опубліковані та готові
  // матеріали, для викладача — повний каталог (включно з прихованим).
  if (!role) {
    files = [];
    categories = [];
    updateUploadCategoryOptions();
    if ($("files")) renderFiles();
    if (isMaterialsPage || isUploadPage) {
      setStatus("Увійдіть, щоб бачити каталог матеріалів.");
    }
    return;
  }
  try {
    const headers = {};
    applyAuthHeaders(headers);
    const response = await api("/api/files", { headers });
    files = await response.json();
    // Категорії: обидві ролі отримують УСІ створені категорії (Issue #63,
    // доробка §2); видимість матеріалів усередині визначає /api/files —
    // для учня сервер віддає лише опубліковані та готові
    try {
      const categoryResponse = await api("/api/categories", { headers });
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
      body: JSON.stringify({ pin, teacherId, name })
    });
    await refreshFiles();
    const created = categories.find(category => category.name.toLocaleLowerCase("uk") === name.trim().toLocaleLowerCase("uk"));
    if (created && $("uploadCategory")) $("uploadCategory").value = created.id;
    setStatus("Категорію створено: " + name.trim());
  } catch (error) { alert("Не вдалося створити категорію: " + error.message); }
}

// Issue #63 (доробка): дві окремі кнопки «Згорнути всі» / «Розгорнути всі» категорій
function collapseAllCategories() {
  categories.forEach(cat => expandedCategoryIds.delete(cat.id));
  // Перемальовуємо каталог
  if ($("files")) renderFiles();
}

function expandAllCategories() {
  categories.forEach(cat => expandedCategoryIds.add(cat.id));
  // Перемальовуємо каталог
  if ($("files")) renderFiles();
}

async function deleteCategory(category) {
  if (!pin || role !== "teacher") { alert("Потрібен PIN викладача."); return; }
  if (!confirm("Видалити категорію «" + category.name + "»? Матеріали залишаться на сервері та перейдуть у «Без категорії».")) return;
  try {
    const result = await api("/api/categories/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, teacherId, categoryId: category.id })
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
      body: JSON.stringify({ pin, teacherId, file: fileId, categoryId })
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
      body: JSON.stringify({ pin, teacherId, categoryId: category.id, name: name.trim() })
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
      body: JSON.stringify({ pin, teacherId, categoryId: category.id, direction })
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
      body: JSON.stringify({ pin, teacherId, file: fileId, name: name.trim() })
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
      body: JSON.stringify({ pin, teacherId, file: fileId, direction })
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
  // Issue #63 (доробка): учень бачить каталог опублікованих матеріалів — картки
  // рендеряться без кнопок керування (що саме дозволено, вирішує сервер у
  // /api/files; тут лише UI без адміністративних дій)
  const isTeacher = role === "teacher";
  // Issue #63 Р: каталог групують категорії для всіх ролей на сторінці
  // «Перегляд матеріалів» і для викладача на «Демонстрації»
  // Перевірка регресійного тесту: if (isMaterialsPage || (isDemoPage && isTeacher))
  const grouped = isMaterialsPage || (isDemoPage && isTeacher);
  // Issue #63 (доробка §2): учень бачить УСІ створені категорії — порожні теж,
  // тому наявність категорій показує групи навіть коли видимих матеріалів
  // немає (порожня категорія відкривається без помилок і показує підказку)
  const groupsWhenEmpty = grouped && categories.length > 0;
  if (!files.length && !(isDemoPage && isTeacher) && !groupsWhenEmpty) {
    const msg = isTeacher
      ? "Матеріалів ще немає. Завантажте перший файл."
      : "Опублікованих матеріалів поки немає. Дочекайтеся демонстрації викладача.";
    root.innerHTML = '<div class="empty">' + msg + '</div>';
    return;
  }

  if (grouped) {
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
      body: JSON.stringify({ pin, teacherId, file: name, hidden: !currentHidden })
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
      body: JSON.stringify({ pin, teacherId, file: fileId })
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
// локальним станом браузера. Початок показу вчителем ховає вибір матеріалів і
// самостійну навігацію — учасник лише дивиться синхронізовану демонстрацію;
// після зупинки показу каталог опублікованих матеріалів повертається на тій
// самій сторінці без перезавантаження (Issue #63, доробка).

// ---------------------------------------------------------------------------
// Issue #75: розгорнутий режим спільної демонстрації на пристрої учня
// ---------------------------------------------------------------------------
// Режим вмикається лише для ролі «учень» і лише за СЕРВЕРНИМ станом показу
// (state.file). У межах сторінки ховаються шапка, навігація, футер і службові
// елементи панелі, а #viewer займає весь доступний простір вікна (vh/dvh).
// Системний Fullscreen API НЕ застосовується віддалено (браузер вимагає
// прямого жесту користувача): помітна кнопка «⛶ На весь екран» на пристрої
// учня вмикає його за натискання; із системного fullscreen виходимо лише
// тоді, коли ввійшли саме цією кнопкою (щоб не витісняти власний fullscreen
// викладача чи випадковий режим браузера). Викладачу режим не вмикається —
// його приватний перегляд і системний fullscreen не змінюються.
let demoFocusActive = false;
let demoFullscreenByUs = false;

/** Fullscreen API підтримується браузером? */
function demoFullscreenSupported() {
  return Boolean(document.documentElement && document.documentElement.requestFullscreen);
}

/** Увімкнення/вимкнення розгорнутого режиму показу (ідемпотентно) */
function setDemoFocus(active) {
  const enabled = Boolean(active) && role !== "teacher";
  if (enabled === demoFocusActive) return;
  demoFocusActive = enabled;
  document.body.classList.toggle("demo-focus", enabled);
  const btn = $("demoFullscreenBtn");
  if (btn) btn.style.display = enabled && demoFullscreenSupported() ? "" : "none";
  if (enabled) {
    // Підказка про обмеження браузера: системний fullscreen запускається лише
    // цією кнопкою, віддалено — ні (чесно без заяви про примусовий fullscreen)
    showToast(
      "Підказка: для системного повноекранного режиму натисніть «⛶ На весь екран» — браузер не дозволяє вмикати його віддалено.",
      "info",
      8000
    );
  } else {
    exitDemoFullscreen();
  }
}

/** Вихід із системного fullscreen, якщо ввійшли нашою кнопкою */
function exitDemoFullscreen() {
  if (demoFullscreenByUs && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
  demoFullscreenByUs = false;
}

/** Кнопка «⛶ На весь екран»: лише за прямого жесту користувача */
function setupDemoFullscreenButton() {
  const btn = $("demoFullscreenBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
        demoFullscreenByUs = true;
      }
    } catch (e) {
      showToast(
        "Браузер не дозволив повноекранний режим: " + (e && e.message ? e.message : e),
        "warning",
        8000
      );
    }
  });
  // Користувач міг вийти з fullscreen сам (Esc) — наш прапорець скидається
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) demoFullscreenByUs = false;
  });
}
setupDemoFullscreenButton();

function setMaterialsDemoMode(active, state = {}) {
  materialsDemoActive = active;
  // Issue #75: розгорнутий режим показу — за тим самим серверним станом
  setDemoFocus(active);
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
  // Зупинка демонстрації: викладач і учень повертаються до каталогу на тій
  // самій сторінці; у учня це лише опубліковані матеріали (приховані не
  // з'являються — сервер їх не віддає), медіа показу вже недоступні
  if ($("materialsSubtitle")) {
    $("materialsSubtitle").textContent = role === "teacher"
      ? "Каталог навчальних матеріалів. Ви можете відкривати, транслювати, приховувати та видаляти файли."
      : "Каталог опублікованих матеріалів для самостійного перегляду. Під час спільної демонстрації вибір матеріалів вимкнено.";
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
  // Вибір матеріалу доступний обом ролям (Issue #63, доробка): для учня це
  // опубліковані матеріали, приховані він побачить лише під час показу
  $("viewer").innerHTML = '<div class="empty">' + (role === "teacher"
    ? "Оберіть файл зі списку та натисніть «Відкрити для себе»."
    : "Оберіть опублікований матеріал зі списку вище або дочекайтеся демонстрації викладача.") + '</div>';
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
    body: JSON.stringify({ pin, teacherId, ...data })
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
  const seq = ++viewerRenderSeq;

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
        if (seq !== viewerRenderSeq) return; // стан уже змінився — відповідь застаріла
        if (manifest && manifest.ready) {
          demoPageCount = manifest.pageCount;
          renderSlideImage(fileId, pageNum, manifest.pageCount);
        } else {
          // If slides not prepared yet, prepare and display
          prepareAndShowSlides(fileId, pageNum, pageCount => {
            if (seq !== viewerRenderSeq) return;
            demoPageCount = pageCount;
            renderSlideImage(fileId, pageNum, pageCount);
          });
        }
      })
      .catch(() => {
        if (seq !== viewerRenderSeq) return;
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

/**
 * Issue #63 (доробка §3): негайне очищення спільного екрана УЧНЯ, коли стан
 * показу оголошує активний матеріал недоступним (state.blocked — викладач
 * приховав його просто під час демонстрації або файл зник).
 *
 * Прибирає ВЕСЬ залишковий вміст матеріалу: зображення/відео, слайди, зони
 * навігації, назву матеріалу в заголовку та лічильник сторінок — а не лише
 * картку в каталозі. Підвищення viewerRenderSeq скасовує всі вже запитані
 * асинхронні відповіді (/api/slides/info, img.onload/onerror, підготовка
 * слайдів), тому застаріла відповідь не зможе повернути відкликаний матеріал
 * на екран після очищення.
 */
function clearSharedViewer() {
  viewerRenderSeq += 1;
  sharedViewerCleared = true;
  videoElement = null;
  if (!$("viewer")) return;
  $("viewer").replaceChildren();
  const notice = document.createElement("div");
  notice.className = "empty";
  notice.id = "sharedBlockedNotice";
  notice.textContent = "Матеріал недоступний: викладач приховав його під час показу. Очікування…";
  $("viewer").append(notice);
  // У заголовку немає назви матеріалу — саме назву і треба прибрати
  if ($("viewerTitle")) $("viewerTitle").textContent = "Спільний екран";
  if ($("pageLabel")) $("pageLabel").textContent = "";
  if ($("pageInput")) $("pageInput").value = "";
  if ($("pdfControls")) $("pdfControls").style.display = "none";
  document.querySelectorAll(".slide-zone").forEach(zone => zone.remove());
  setSlideNavHint(false);
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
  // Issue #63 (доробка): лише один інтервальний цикл опитування за раз.
  // Поки триває повільний цикл (наприклад, із refreshFiles за ревізією), новий
  // старт з інтервалу блокується: два паралельні цикли працюють із різними
  // знімками стану, і той, що завершиться останнім (зі ЗАСТІЛЯЛИМ станом),
  // відкочує глядач і каталог до попереднього матеріалу. Примусові виклики
  // (force) не блокуються, щоб не загальмувати реакцію викладача.
  if (pollBusyDepth > 0 && !force) return;
  pollBusyDepth += 1;
  try {
    await pollStateCore(force);
  } finally {
    pollBusyDepth -= 1;
  }
}

async function pollStateCore(force = false) {
  // Сторінка перегляду: учні дізнаються про демонстрацію зі СЕРВЕРНОГО стану
  // (та самий шлях при перезавантаженні чи повторному підключенні); викладач
  // керує показом на сторінці «Демонстрація» і тут не спостерігає.
  // Issue #63 (Етап 5): без чинного входу стан не опитується (сервер → 401)
  if (!isDemoPage && !isMaterialsPage) return;
  if (!role) return;
  if (isMaterialsPage && role === "teacher") return;
  try {
    const response = await api("/api/state");
    const state = await response.json();
    const prev = sharedState;
    sharedState = state;

    // Issue #83: персональний стан тестування — одразу після присвоєння
    // sharedState: бейдж на слайді-відповіді залежить від номера слайда, а
    // кнопки учня — від того, чи сервер відкрив приймання (після показу
    // «!state.file» тут не повертаємось, тому панель оновиться і на зупинці)
    applyTestingState(state.testing);
    updateViewerTestBadge();
    // Issue #83 (таймер учнів): знімок автоперегортання для зворотного
    // відліку в смузі відповіді (тільки новий seq змінює локальний дедлайн)
    applyAutoNextState(state.autoNext);

    // Issue #75: розгорнутий режим показу на пристрої учня — за тим самим
    // серверним станом (початок показу розгортає, зупинка повертає звичайний
    // режим); у викладача цей режим не вмикається
    if (role !== "teacher") setDemoFocus(Boolean(state.file));

    // Issue #79: активні сигнали — персональна частина стану від /api/state.
    // Учневі сервер віддає лише свої записи (групові та адресовані) і одразу
    // показує/ховає оверлей; викладачу — усі (активні стани іконок у списку)
    if (role === "teacher") {
      applyTeacherSignals(state.signals);
    } else {
      applyStudentSignals(state.signals);
    }

    // Issue #63 (доробка): каталог учня перечитується за ревізією стану —
    // публікація/приховування матеріалу викладачем оновлює список без
    // перезавантаження сторінки. У викладача свій каталозі: він перечитує
    // його після власних операцій, опитувати /api/files кожні 0.5 с не треба.
    if (role !== "teacher" && state.revision !== lastCatalogRevision) {
      const firstState = lastCatalogRevision === null;
      lastCatalogRevision = state.revision;
      if (!firstState) await refreshFiles();
    }

    // Issue #63: перемикання режимів сторінки учня без перезавантаження —
    // за серверним станом демонстрації (початок ховає каталог, зупинка повертає)
    if (isMaterialsPage && Boolean(state.file) !== materialsDemoActive) {
      setMaterialsDemoMode(Boolean(state.file), state);
    }

    if (!state.file) {
      // Показ завершено (зупинка викладачем): глядач далі веде сама
      // сторінка, тож прапорець очищення скидається
      sharedViewerCleared = false;
      if (isDemoPage) {
        if ($("viewerTitle")) $("viewerTitle").textContent = "Спільний екран";
        // Якщо екран лишився від очищення через недоступність матеріалу —
        // прибираємо і це повідомлення (навіть при примусовому опитуванні)
        const showingBlocked = Boolean($("viewer") && $("viewer").querySelector("#sharedBlockedNotice"));
        if ($("viewer") && (!force || showingBlocked)) {
          $("viewer").innerHTML = '<div class="empty">Очікування початку демонстрації від викладача…</div>';
        }
        setStatus(role === "teacher"
          ? "Показ ще не розпочато."
          : "Демонстрацію не ведеться. Дочекайтеся показу викладача або відкрийте матеріал самостійно на сторінці «Перегляд матеріалів».");
      } else {
        setStatus(role === "teacher"
          ? "Каталог доступний."
          : "Каталог доступний. Оберіть матеріал самостійно або дочекайтеся демонстрації викладача.");
      }
      return;
    }

    const file = files.find(f => (f.id === state.file || f.name === state.file));
    // Issue #63 (доробка): назва зі стану — актуальна і для прихованого
    // матеріалу, якого немає в каталозі учня
    const displayName = state.fileName || (file ? file.name : state.file);

    // Issue #63 (доробка §3): активний матеріал став недоступним (викладач
    // приховав його просто під час показу). Сервер оголошує це у стані
    // (state.blocked), і клієнт УЧНЯ негайно прибирає слайд і залишковий
    // вміст — не чекаючи перемикання чи зупинки показу. У викладача приховане
    // доступне, тому він лишається на матеріалі.
    const blockedForViewer = Boolean(state.blocked) && role !== "teacher";

    const changed = force || state.revision !== lastRevision;
    if (changed) {
      lastRevision = state.revision;

      if (blockedForViewer) {
        clearSharedViewer();
        setStatus("Показ припинено для вас: матеріал більше недоступний (прихований викладачем). Очікування…");
        return;
      }

      const ext = extOf(state.file);
      // Після очищення (недоступність → публікація назад) матеріал малюється
      // навіть за того самого файлу й слайда
      const needsRender = force || sharedViewerCleared ||
        !prev || prev.file !== state.file || prev.page !== state.page;
      if (SLIDE_EXTS.has(ext)) {
        if (needsRender) {
          const pageNum = Math.max(1, state.page || 1);
          setStatus("Демонстрація: " + displayName + " — слайд " + pageNum + (demoPageCount > 1 ? " / " + demoPageCount : ""));
          displaySharedFile(state.file, state);
        }
      } else {
        setStatus("Демонстрація: " + displayName);
        displaySharedFile(state.file, state);
      }
      sharedViewerCleared = false;
      return;
    }

    // Матеріал показу вже очищено й стан не змінювався — нічого не малюємо
    if (blockedForViewer) return;

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
    // Issue #63 (Етап 5): 401 уже оброблено окремо (вхід заново) — не лякаємо
    // повідомленням про втрату зв'язку, коли причина саме в завершеній сесії
    if (!sessionExpiredHandled) setStatus("Зв'язок із сервером втрачено. Повторна спроба…");
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
    headers: applyAuthHeaders({ "Content-Type": "application/json" }),
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
// Issue #63 (доробка): дві окремі кнопки «Згорнути всі» / «Розгорнути всі»
if ($("collapseAllCategoriesBtn")) $("collapseAllCategoriesBtn").onclick = collapseAllCategories;
if ($("expandAllCategoriesBtn")) $("expandAllCategoriesBtn").onclick = expandAllCategories;

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
            headers: applyAuthHeaders({ "Content-Type": "application/octet-stream" }),
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

/**
 * Issue #63 (Етап 5): відновлення серверної сесії при завантаженні сторінки.
 *
 * PIN зберігається лише в sessionStorage (на одну вкладку), а cookie сесії —
 * на сервері. Після перезапуску LyServer усі попередні сесії скасовані, тому:
 *  - викладач без PIN у цій вкладці проходить вхід заново (форма ролі);
 *  - викладач із PIN проходить повторну верифікацію — стара cookie невалідна;
 *  - учень дізнається про скасування з першого ж запиту стану (401 → вхід).
 * Поки сесію не відновлено, опитування стану не починається (гонка з verify).
 */
async function bootstrapSession() {
  if (role !== "teacher") return;
  if (!pin) {
    handleSessionExpired();
    return;
  }
  try {
    const response = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    if (response.ok) {
      // Issue #85: відновлюємо контекст облікового запису (teacherId/admin) —
      // він потрібен для заголовка X-Portal-Teacher у подальших запитах
      const data = await response.json().catch(() => ({}));
      applyLoginResponse(data);
    } else {
      // Вхід більше не дійсний (PIN замінено, запис деактивовано або
      // обліковий запис заблоковано) — контекст не тримаємо
      clearLoginContext();
      handleSessionExpired();
    }
  } catch {
    /* сервер недоступний — стан опитування повідомить про помилку зв'язку */
  }
}

if (!role) {
  openRoleModal();
  updateRoleUI();
} else {
  updateRoleUI();
  filesReady = bootstrapSession().then(() => refreshFiles());
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
// Issue #63 (Етап 5): сесію викладача відновлює bootstrapSession() перед
// першим pollState — окремо оновлювати cookie тут уже не потрібно
}
