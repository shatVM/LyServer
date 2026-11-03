/**
 * signalService.js — універсальні візуальні сигнали учням (Issue #79).
 *
 * Свідомо розділені два рівні стану:
 *  1) КОНФІГУРАЦІЯ — сигнали, які створює викладач: напис, іконка з НАЯВНОГО
 *     набору public/icons.svg, колір, прозорість напису (за замовчуванням
 *     75%), тривалість показу (за замовчуванням 3 с), прапорці «Показувати до
 *     зняття» і «Застосувати для всіх», порядок. Персистентна у власному файлі
 *     materials/.signals.json — окремо від .metadata.json, щоб зміни сигналів
 *     не потрапляли в stable-порівняння метаданих матеріалів (тести) і не
 *     змінювали каталог. Один універсальний формат для ВСІХ написів: параметри,
 *     а не окремі реалізації на кожен текст.
 *  2) АКТИВНИЙ СТАН доставки — лише в пам'яті процесу: {id, signalId, target
 *     (studentId або "all"), text/icon/color/opacity (копія конфігу в момент
 *     надсилання), durationMs, untilDismiss, startedAt, expiresAt}. Очищується
 *     при завершенні демонстрації (stateService.stopShared) і при перезапуску
 *     сервера — після перепідключення учень отримує лише актуальний стан,
 *     скасовані/завершені сигнали не відновлюються.
 *
 * Межі цього сервісу: він не читає запитів і не вирішує питань прав. PIN,
 * валідація адресата в presenceService і нормалізація цілі — у
 * signalController; прив'язка studentId до сесії — в auth/sessionService.
 */
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");

/** Окремий файл конфігурації (поруч із матеріалами, не в metadata.json) */
const SIGNALS_FILE = path.join(config.dataDir, ".signals.json");
/** Спрайт іконок проєкту — джерело дозволених значень icon */
const ICONS_FILE = path.join(__dirname, "..", "..", "public", "icons.svg");

const TEXT_MAX = 60;
const OPACITY_MIN = 0;
const OPACITY_MAX = 100;
const OPACITY_DEFAULT = 75;
const DURATION_MIN = 1; // секунди
const DURATION_MAX = 60;
const DURATION_DEFAULT = 3;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TARGET_MAX = 64;

function errorWith(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

let iconsCache = null;

/**
 * Наявний набір іконок проєкту: id символів з public/icons.svg.
 * Кешується на час життя процесу; якщо спрайт недоступний — мінімальний
 * запасний варіант, щоб форма викладача не лишалася порожньою.
 */
function availableIcons() {
  if (Array.isArray(iconsCache)) return iconsCache;
  try {
    const raw = fs.readFileSync(ICONS_FILE, "utf-8");
    const ids = new Set();
    for (const match of raw.matchAll(/<symbol[^>]*\bid="([^"]+)"/g)) ids.add(match[1]);
    iconsCache = Array.from(ids);
  } catch (error) {
    console.error("Не вдалося прочитати спрайт іконок:", error.message);
    iconsCache = ["monitor-play"];
  }
  if (!iconsCache.length) iconsCache = ["monitor-play"];
  return iconsCache;
}

/** Нормалізація збереженого запису (захист від ручної правки файлу) */
function normalizeStored(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
  const text = String(item.text || "").trim().slice(0, TEXT_MAX);
  if (!text) return null;
  let icon = String(item.icon || "");
  if (!availableIcons().includes(icon)) icon = "monitor-play";
  let color = String(item.color || "");
  if (!COLOR_RE.test(color)) color = "#e03131";
  let opacity = Number(item.opacity);
  if (!Number.isFinite(opacity)) opacity = OPACITY_DEFAULT;
  opacity = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(opacity)));
  let duration = Number(item.duration);
  if (!Number.isFinite(duration)) duration = DURATION_DEFAULT;
  duration = Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(duration)));
  return {
    id: String(item.id),
    text,
    icon,
    color: color.toLowerCase(),
    opacity,
    duration,
    untilDismiss: Boolean(item.untilDismiss),
    forAll: Boolean(item.forAll),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now()
  };
}

function readStored() {
  try {
    if (!fs.existsSync(SIGNALS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf-8"));
    const list = Array.isArray(parsed) ? parsed
      : (Array.isArray(parsed && parsed.signals) ? parsed.signals : []);
    return list.map(normalizeStored).filter(Boolean)
      .sort((a, b) => a.order - b.order);
  } catch (error) {
    console.error("Error reading signals config:", error.message);
    return [];
  }
}

function writeStored(list) {
  try {
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify({ signals: list }, null, 2), "utf-8");
  } catch (error) {
    console.error("Error saving signals config:", error.message);
    throw errorWith(500, "Не вдалося зберегти конфігурацію сигналів");
  }
}

/**
 * Валідація полів із тіла запиту. partial=true — оновлення (змінюються лише
 * передані поля); інакше — створення (застосовуються значення за
 * замовчуванням, підставлені викликачем).
 */
function normalizeInput(data, { partial = false } = {}) {
  const out = {};
  if (!partial || data.text !== undefined) {
    const text = String(data.text == null ? "" : data.text).trim().slice(0, TEXT_MAX);
    if (!text) throw errorWith(400, "Напис сигналу не може бути порожнім");
    out.text = text;
  }
  if (!partial || data.icon !== undefined) {
    const icon = String(data.icon == null ? "" : data.icon);
    if (!availableIcons().includes(icon)) {
      throw errorWith(400, "Іконка поза набором проєкту: " + icon);
    }
    out.icon = icon;
  }
  if (!partial || data.color !== undefined) {
    const color = String(data.color == null ? "" : data.color);
    if (!COLOR_RE.test(color)) throw errorWith(400, "Колір має бути у форматі #RRGGBB");
    out.color = color.toLowerCase();
  }
  if (!partial || data.opacity !== undefined) {
    const opacity = Number(data.opacity);
    if (!Number.isFinite(opacity)) throw errorWith(400, "Некоректна прозорість");
    out.opacity = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(opacity)));
  }
  if (!partial || data.duration !== undefined) {
    const duration = Number(data.duration);
    if (!Number.isFinite(duration)) throw errorWith(400, "Некоректна тривалість");
    out.duration = Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(duration)));
  }
  if (!partial || data.untilDismiss !== undefined) out.untilDismiss = Boolean(data.untilDismiss);
  if (!partial || data.forAll !== undefined) out.forAll = Boolean(data.forAll);
  return out;
}

// ---------------------------------------------------------------------------
// Конфігурація (персистентна)
// ---------------------------------------------------------------------------

function listConfig() {
  return readStored();
}

function getConfigItem(id) {
  if (typeof id !== "string" || !id) return null;
  return readStored().find((item) => item.id === id) || null;
}

function create(data) {
  const body = data || {};
  const fields = normalizeInput(Object.assign({
    color: "#e03131",
    icon: "monitor-play",
    opacity: OPACITY_DEFAULT,
    duration: DURATION_DEFAULT,
    untilDismiss: false,
    forAll: false
  }, body));
  const list = readStored();
  const item = Object.assign({
    id: "sig_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    order: list.length,
    createdAt: Date.now()
  }, fields);
  list.push(item);
  writeStored(list);
  return item;
}

function update(id, data) {
  const list = readStored();
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) throw errorWith(404, "Сигнал не знайдено");
  const fields = normalizeInput(data || {}, { partial: true });
  list[index] = Object.assign({}, list[index], fields);
  writeStored(list);
  return list[index];
}

function remove(id) {
  const list = readStored();
  if (!list.some((item) => item.id === id)) throw errorWith(404, "Сигнал не знайдено");
  const rest = list.filter((item) => item.id !== id)
    .map((item, position) => Object.assign({}, item, { order: position }));
  writeStored(rest);
  return { ok: true, removed: id };
}

function reorder(id, direction) {
  const list = readStored();
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) throw errorWith(404, "Сигнал не знайдено");
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= list.length) return list; // межа списку — без змін
  const swapped = list.slice();
  const tmp = swapped[index];
  swapped[index] = swapped[swapWith];
  swapped[swapWith] = tmp;
  const ordered = swapped.map((item, position) => Object.assign({}, item, { order: position }));
  writeStored(ordered);
  return ordered;
}

// ---------------------------------------------------------------------------
// Активний стан доставки (лише пам'ять; params — копія конфігу на момент
// надсилання, тому пізніша правка конфігурації не змінює вже надісланий сигнал)
// ---------------------------------------------------------------------------

/** @type {Array<object>} */
let activeSignals = [];

function pruneExpired() {
  const now = Date.now();
  activeSignals = activeSignals.filter(
    (entry) => entry.expiresAt === null || entry.expiresAt > now
  );
}

/** Технічний вигляд для викладача (з полем target) */
function teacherView() {
  pruneExpired();
  return activeSignals.map((entry) => Object.assign({}, entry));
}

/**
 * Надіслати сигнал: один запис на пару (сигнал, ціль) — повторне надсилання
 * ЗАМІНЮЄ попередній запис новим id і перезапускає таймер; дублікатів
 * (наприклад, груповий запис на кожного учня) не виникає.
 */
function send(configItem, target) {
  pruneExpired();
  const now = Date.now();
  const untilDismiss = Boolean(configItem.untilDismiss);
  const durationMs = configItem.duration * 1000;
  const entry = {
    id: "sigact_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    signalId: configItem.id,
    target,
    text: configItem.text,
    icon: configItem.icon,
    color: configItem.color,
    opacity: configItem.opacity,
    durationMs,
    untilDismiss,
    startedAt: now,
    expiresAt: untilDismiss ? null : now + durationMs
  };
  activeSignals = activeSignals.filter(
    (item) => !(item.signalId === entry.signalId && item.target === entry.target)
  );
  activeSignals.push(entry);
  return teacherView();
}

/** Ручне зняття (параметр «Показувати до зняття»); ідемпотентне */
function dismiss(signalId, target) {
  pruneExpired();
  const before = activeSignals.length;
  activeSignals = activeSignals.filter(
    (item) => !(item.signalId === signalId && item.target === target)
  );
  return { removed: before - activeSignals.length, active: teacherView() };
}

/**
 * Стан для конкретного запитувача: викладач (PIN або його сесія) бачить усі
 * записи (для активних станів іконок у списку учнів); учень — ЛИШЕ групові та
 * адресовані йому (індивідуальний сигнал не потрапляє в стан інших учнів).
 * Ідентифікатор учня береться з прив'язки сесії, а не з запиту.
 */
function getVisibleTo(identity) {
  pruneExpired();
  const isTeacher = Boolean(identity) &&
    (identity.pin === true || identity.role === "teacher");
  if (isTeacher) return teacherView();
  const studentId = identity && identity.studentId ? String(identity.studentId) : "";
  return activeSignals
    .filter((entry) => entry.target === "all" || entry.target === studentId)
    .map((entry) => Object.assign({}, entry));
}

/** Очищення активних сигналів (завершення демонстрації, перезапуск) */
function clearActive() {
  activeSignals = [];
}

module.exports = {
  availableIcons,
  listConfig,
  getConfigItem,
  create,
  update,
  remove,
  reorder,
  send,
  dismiss,
  getVisibleTo,
  clearActive
};
