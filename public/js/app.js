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
let sharedState = null;
let lastVideoUpdate = 0;
let videoElement = null;
let applyingRemote = false;

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

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

function fileUrl(name) {
  return "/files/" + encodeURIComponent(name);
}

function slideUrl(name, page) {
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
function renderSlideImage(name, page, totalPages) {
  const viewer = $("viewer");
  if (!viewer) return;

  // Update page label
  if ($("pageLabel")) {
    const ext = extOf(name).toUpperCase();
    $("pageLabel").textContent = ext.slice(1) + ": слайд " + page + " / " + totalPages;
  }
  // Issue #9: поле номера слайду синхронізується з поточним сторінкою
  if ($("pageInput")) $("pageInput").value = page;

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
  img.src = slideUrl(name, page) + "?t=" + Date.now(); // cache-bust during prepare

  // Show loading overlay only when first loaded
  img.onload = () => {};
  img.onerror = () => {
    viewer.innerHTML = '<div class="empty">⚠️ Помилка завантаження зображення слайду ' + page + '</div>';
  };

  // Issue #61: активні зони лівої/правої половини зображення (ліва — назад, права — уперед)
  if (slideNavAllowed()) ensureSlideZones(viewer);
}

/**
 * Prepare slides on the server (conversion) and then display the first slide.
 * Shows a progress indicator while converting.
 */
async function prepareAndShowSlides(name, page, onReady) {
  const viewer = $("viewer");
  if (viewer) {
    viewer.innerHTML = '<div class="empty slide-loading">🔄 Конвертація слайдів… Зачекайте, будь ласка.</div>';
  }

  try {
    let pageCount = null;
    if (role === "teacher") {
      // Викладач може явно запустити конвертацію (Issue #2: prepare — тільки для викладача)
      const res = await api("/api/slides/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
function ensureSlideZones(viewer) {
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
      if (!slideNavAllowed()) return;            // учень на демонстрації не змінює спільний слайд
      if (viewer.classList.contains("nav-hint")) setSlideNavHint(false);
      navigateSlide(side === "prev" ? -1 : 1);   // на межах перемикання не відбувається (кламп)
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
    if ($("materialsSubtitle")) {
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
  role = newRole;
  localStorage.setItem("portalRole", newRole);
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
    // logout
    pin = "";
    sessionStorage.removeItem("portalPin");
    studentDisplayName = "";
    localStorage.removeItem("portalStudentName");
    localStorage.removeItem("portalStudentId");
    studentId = "";
  }
  closeRoleModal();
  updateRoleUI();
  refreshFiles();
  // Миттєвий старт опитування, якщо увійшли як викладач у поточній сесії
  // (раніше список оновлювався лише після перезавантаження сторінки)
  if (newRole === "teacher") startPresencePolling();
  else stopPresencePolling();
  // Симетрично: учень, який увійшов у поточній сесії, шле heartbeat одразу
  if (newRole === "student" && studentDisplayName) startHeartbeat();
  else stopHeartbeat();
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
    if (role === "teacher" && pin) {
      const categoryResponse = await api("/api/categories", { headers });
      categories = await categoryResponse.json();
    } else {
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
  const hiddenBadge = (isTeacher && file.hidden) ? '<span class="badge-hidden">🚫 Приховано</span>' : "";
  const typeTag = SLIDE_EXTS.has(file.ext) ? "🖼️" : "🎬";
  info.innerHTML = '<div class="file-name">' + typeTag + " " + esc(file.name) + hiddenBadge +
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
    const local = document.createElement("button");
    local.className = "secondary btn-sm"; local.textContent = "👁️ Відкрити";
    local.onclick = () => displayLocalFile(fileId); actions.append(local);
    if (isTeacher) {
      const broadcast = document.createElement("button");
      broadcast.className = "btn-sm"; broadcast.textContent = "📺 Транслювати";
      broadcast.onclick = () => broadcastFile(fileId, true); actions.append(broadcast);
      const hideBtn = document.createElement("button");
      hideBtn.className = "btn-sm " + (file.hidden ? "btn-success" : "btn-warning");
      hideBtn.textContent = file.hidden ? "👁️ Показати" : "🚫 Приховати";
      hideBtn.onclick = () => toggleHideFile(fileId, file.hidden); actions.append(hideBtn);
      const delBtn = document.createElement("button");
      delBtn.className = "btn-sm btn-danger"; delBtn.textContent = "🗑️ Видалити";
      delBtn.onclick = () => deleteFile(fileId, file.name); actions.append(delBtn);
    }
  } else if (isDemoPage && isTeacher) {
    const broadcast = document.createElement("button");
    broadcast.className = "btn-sm"; broadcast.textContent = "📺 Показувати всім";
    broadcast.setAttribute("aria-label", "Показувати всім: " + file.name);
    broadcast.onclick = () => broadcastFile(fileId, false); actions.append(broadcast);
    if (showCategoryActions) {
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
      const retry = document.createElement("button");
      retry.type = "button"; retry.className = "secondary btn-sm";
      retry.textContent = "Повторити конвертацію"; retry.onclick = () => retrySlideConversion(fileId);
      actions.append(retry);
    }
    return item;
  } else if (isUploadPage && isTeacher) {
    const hideBtn = document.createElement("button");
    hideBtn.className = "btn-sm " + (file.hidden ? "btn-success" : "btn-warning");
    hideBtn.textContent = file.hidden ? "👁️ Показати" : "🚫 Приховати";
    hideBtn.onclick = () => toggleHideFile(fileId, file.hidden); actions.append(hideBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "btn-sm btn-danger"; delBtn.textContent = "🗑️ Видалити";
    delBtn.onclick = () => deleteFile(fileId, file.name); actions.append(delBtn);
  }
  item.append(info, actions);
  return item;
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
  if (isDemoPage && isTeacher) {
    const orderedCategories = [...categories].sort((a, b) => (a.order || 0) - (b.order || 0));
    const groups = [...orderedCategories.map(category => ({ id: category.id, name: category.name, category })),
      { id: "", name: "Без категорії", category: null }];
    for (const group of groups) {
      const groupFiles = files.filter(file => (file.categoryId || "") === group.id);
      const section = document.createElement("section"); section.className = "category-section";
      const header = document.createElement("div"); header.className = "category-heading";
      const title = document.createElement("h4"); title.append(iconSvg("folder"), document.createTextNode(" " + group.name)); header.append(title);
      if (group.category) {
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "secondary btn-sm"; remove.textContent = "Видалити категорію";
        remove.setAttribute("aria-label", "Видалити категорію " + group.name);
        remove.onclick = () => deleteCategory(group.category); header.append(remove);
      }
      section.append(header);
      if (!groupFiles.length) {
        const empty = document.createElement("p"); empty.className = "hint category-empty";
        empty.textContent = "У цій категорії поки немає матеріалів."; section.append(empty);
      } else {
        for (const file of groupFiles) section.append(createFileCard(file, true, true));
      }
      root.append(section);
    }
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
function displayLocalFile(fileId) {
  const file = files.find(f => (f.id === fileId || f.name === fileId));
  if (!file || !$("viewer")) return;

  const actualId = file.id || fileId;
  localCurrentFile = actualId;
  localPageNum = 1;
  videoElement = null;

  if ($("viewerTitle")) $("viewerTitle").textContent = "Особистий перегляд: " + (file.name || actualId);
  $("viewer").replaceChildren();

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
  if (!localCurrentFile || !SLIDE_EXTS.has(extOf(localCurrentFile))) return;
  localPageNum = Math.max(1, Math.min(localPageCount || 1, page));
  renderSlideImage(localCurrentFile, localPageNum, localPageCount || 1);
}

function stepLocalPage(delta) {
  setLocalPage(localPageNum + delta);
}

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
    }
  } catch (error) {
    alert("Не вдалося розпочати показ: " + error.message);
  }
}

function displaySharedFile(fileId, state = {}) {
  if (!$("viewer")) return;
  videoElement = null;

  const file = files.find(f => (f.id === fileId || f.name === fileId));
  const displayName = file ? file.name : fileId;

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
  if (!isDemoPage) return;
  try {
    const response = await api("/api/state");
    const state = await response.json();
    const prev = sharedState;
    sharedState = state;

    if (!state.file) {
      if ($("viewerTitle")) $("viewerTitle").textContent = "Спільний екран";
      if (!force && $("viewer")) {
        $("viewer").innerHTML = '<div class="empty">Очікування початку демонстрації від викладача…</div>';
      }
      setStatus("Показ ще не розпочато.");
      return;
    }

    const file = files.find(f => (f.id === state.file || f.name === state.file));
    const displayName = file ? file.name : state.file;

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

// Issue #7: учень повідомляє сервер про активність свого сеансу.
// Обробники реєструються завжди (усередині — перевірка ролі), щоб вхід учня
// в поточній сесії також працював, а не лише при перезавантаженні сторінки.
document.addEventListener("visibilitychange", () => {
  reportActivityChange(document.visibilityState !== "hidden");
});
window.addEventListener("pagehide", () => reportActivityChange(false));
if (role === "student" && studentDisplayName) startHeartbeat();

// Issue #7: викладач опитує список присутності та отримує тости
if (role === "teacher") {
  startPresencePolling();
}
