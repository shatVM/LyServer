const $ = id => document.getElementById(id);

// Role & Session PIN management
let role = localStorage.getItem("portalRole") || "";
let pin = sessionStorage.getItem("portalPin") || "";
let files = [];

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

// Determine current page type
const isDemoPage = Boolean(window.location.pathname.includes("demonstration"));
const isUploadPage = Boolean(window.location.pathname.includes("upload"));
const isStudentsPage = Boolean(window.location.pathname.includes("students"));
const isMaterialsPage = Boolean(!isDemoPage && !isUploadPage && !isStudentsPage);

// Extensions treated as slides (PNG images, not iframes or video)
const SLIDE_EXTS = new Set([".pdf", ".pptx"]);

function setStatus(text) {
  if ($("status")) $("status").textContent = text;
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
async function sendHeartbeat() {
  if (role !== "student" || !studentDisplayName) return;
  try {
    await fetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: ensureStudentId(), name: studentDisplayName })
    });
  } catch { /* silent */ }
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
    const res = await api("/api/slides/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: name })
    });
    const manifest = await res.json();
    onReady(manifest.pageCount);
  } catch (e) {
    if (viewer) {
      viewer.innerHTML = '<div class="empty">❌ Помилка конвертації: ' + esc(e.message) + '</div>';
    }
  }
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
    // Pre-fill student name if already set
    if ($("modalStudentSurname")) $("modalStudentSurname").value = "";
    if ($("modalStudentName")) $("modalStudentName").value = "";
    if (studentDisplayName) {
      const parts = studentDisplayName.split(" ");
      if ($("modalStudentSurname")) $("modalStudentSurname").value = parts[0] || "";
      if ($("modalStudentName")) $("modalStudentName").value = parts.slice(1).join(" ") || "";
    }
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
}

// Student login button
if ($("btnChooseStudent")) {
  $("btnChooseStudent").onclick = () => {
    const surname = ($("modalStudentSurname") ? $("modalStudentSurname").value.trim() : "");
    const firstName = ($("modalStudentName") ? $("modalStudentName").value.trim() : "");
    if (!surname || !firstName) {
      if ($("modalStudentError")) {
        $("modalStudentError").textContent = "Будь ласка, введіть Прізвище та Ім'я.";
        $("modalStudentError").style.display = "block";
      }
      return;
    }
    const fullName = surname + " " + firstName;
    setRole("student", "", fullName);
  };
}

// Enter key in student name fields
["modalStudentSurname", "modalStudentName"].forEach(id => {
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
    if ($("files")) {
      renderFiles();
    }
    if (isMaterialsPage) setStatus("Каталог доступний. Матеріалів: " + files.length + ".");
    else if (isUploadPage) setStatus("Файлів на сервері: " + files.length + ".");
  } catch (error) {
    if ($("files")) setStatus("Помилка завантаження файлів: " + error.message);
  }
}

function renderFiles() {
  const root = $("files");
  if (!root) return;
  root.replaceChildren();

  if (!files.length) {
    const msg = role === "teacher"
      ? "Матеріалів ще немає. Завантажте перший файл."
      : "Матеріали наразі відсутні. Очікуйте відкриття матеріалів викладачем.";
    root.innerHTML = '<div class="empty">' + msg + '</div>';
    return;
  }

  const isTeacher = role === "teacher";

  for (const file of files) {
    const item = document.createElement("div");
    item.className = "file" + (file.hidden ? " file-is-hidden" : "");

    const info = document.createElement("div");
    info.className = "file-info";
    const hiddenBadge = (isTeacher && file.hidden) ? '<span class="badge-hidden">🚫 Приховано</span>' : "";
    const typeTag = SLIDE_EXTS.has(file.ext) ? "🖼️" : "🎬";
    info.innerHTML = '<div class="file-name">' + typeTag + " " + esc(file.name) + hiddenBadge +
      '</div><div class="hint">' + esc(file.ext.toUpperCase()) + " • " + formatSize(file.size) + "</div>";

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const fileId = file.id || file.name;

    if (isMaterialsPage) {
      const local = document.createElement("button");
      local.className = "secondary btn-sm";
      local.textContent = "👁️ Відкрити";
      local.onclick = () => displayLocalFile(fileId);
      actions.append(local);

      if (isTeacher) {
        const broadcast = document.createElement("button");
        broadcast.className = "btn-sm";
        broadcast.textContent = "📺 Транслювати";
        broadcast.onclick = () => broadcastFile(fileId, true);
        actions.append(broadcast);

        const hideBtn = document.createElement("button");
        hideBtn.className = "btn-sm " + (file.hidden ? "btn-success" : "btn-warning");
        hideBtn.textContent = file.hidden ? "👁️ Показати" : "🚫 Приховати";
        hideBtn.onclick = () => toggleHideFile(fileId, file.hidden);
        actions.append(hideBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "btn-sm btn-danger";
        delBtn.textContent = "🗑️ Видалити";
        delBtn.onclick = () => deleteFile(fileId, file.name);
        actions.append(delBtn);
      }
    } else if (isDemoPage) {
      if (isTeacher) {
        const broadcast = document.createElement("button");
        broadcast.className = "btn-sm";
        broadcast.textContent = "📺 Показувати всім";
        broadcast.onclick = () => broadcastFile(fileId, false);
        actions.append(broadcast);
      }
    } else if (isUploadPage) {
      if (isTeacher) {
        const hideBtn = document.createElement("button");
        hideBtn.className = "btn-sm " + (file.hidden ? "btn-success" : "btn-warning");
        hideBtn.textContent = file.hidden ? "👁️ Показати" : "🚫 Приховати";
        hideBtn.onclick = () => toggleHideFile(fileId, file.hidden);
        actions.append(hideBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "btn-sm btn-danger";
        delBtn.textContent = "🗑️ Видалити";
        delBtn.onclick = () => deleteFile(fileId, file.name);
        actions.append(delBtn);
      }
    }

    item.append(info, actions);
    root.append(item);
  }
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

function stepLocalPage(delta) {
  if (!localCurrentFile || !SLIDE_EXTS.has(extOf(localCurrentFile))) return;
  const next = Math.max(1, Math.min(localPageCount, localPageNum + delta));
  if (next === localPageNum) return;
  localPageNum = next;
  renderSlideImage(localCurrentFile, localPageNum, localPageCount);
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

async function changeSharedPage(delta) {
  if (role !== "teacher" || !sharedState || !sharedState.file) return;
  const page = Math.max(1, Math.min(demoPageCount || 9999, (sharedState.page || 1) + delta));
  try {
    await postControl({ file: sharedState.file, kind: "slides", page });
    await pollState(true);
  } catch (e) { alert("Не вдалося змінити слайд: " + e.message); }
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
// Teacher: convert slides on broadcast
// ---------------------------------------------------------------------------
async function prepareSlidesBg(fileId) {
  try {
    await api("/api/slides/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: fileId })
    });
  } catch (e) {
    console.error("Background slide prepare error:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
if ($("prevPage")) {
  $("prevPage").onclick = () => {
    if (isDemoPage) changeSharedPage(-1);
    else stepLocalPage(-1);
  };
}

if ($("nextPage")) {
  $("nextPage").onclick = () => {
    if (isDemoPage) changeSharedPage(1);
    else stepLocalPage(1);
  };
}

if ($("refresh")) $("refresh").onclick = refreshFiles;
if ($("showShared")) $("showShared").onclick = () => pollState(true);

// Upload handler
if ($("upload") && $("uploadFile")) {
  $("upload").onclick = async () => {
    const file = $("uploadFile").files[0];
    if (!file) { setStatus("Оберіть файл для завантаження."); return; }
    if (!pin || role !== "teacher") { setStatus("Необхідно увійти як викладач."); openRoleModal(); return; }

    const button = $("upload");
    button.disabled = true;
    setStatus("Завантаження: " + file.name + "…");
    try {
      const res = await api("/api/upload?name=" + encodeURIComponent(file.name), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Portal-Pin": pin },
        body: file
      });
      const uploadResult = await res.json();
      $("uploadFile").value = "";
      setStatus("Файл завантажено: " + file.name);

      const uploadedId = uploadResult.id || file.name;

      // Auto-convert slide files in the background after upload
      if (SLIDE_EXTS.has(extOf(uploadedId))) {
        setStatus("Файл завантажено: " + file.name + " — генерація слайдів у фоні…");
        prepareSlidesBg(uploadedId).then(() => {
          setStatus("Файл готовий до демонстрації: " + file.name);
        });
      }

      await refreshFiles();
    } catch (error) {
      setStatus("Помилка завантаження: " + error.message);
    } finally {
      button.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
if (!role) {
  openRoleModal();
  updateRoleUI();
} else {
  updateRoleUI();
  refreshFiles();
}

if (isDemoPage) {
  pollState(true);
  setInterval(() => pollState(false), 1000);
}
