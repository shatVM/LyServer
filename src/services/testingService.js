/**
 * testingService.js — MVP системи тестування під час демонстрації (Issue #83).
 *
 * Свідомо три рівні стану:
 *  1) СЕСІЯ ТЕСТУВАННЯ — status: "idle" (не запущено) | "active" (приймаємо
 *     відповіді) | "finished" (завершено вручну), плюс options (3 або 4).
 *     "active" → "finished" лише явною дією вчителя («Завершити тестування»);
 *     нове тестування — лише після «Тестування», старт очищує попередні
 *     відповіді (інакше застарілий вибір потрапив би в нову статистику).
 *  2) ВКАЗІВНИК ПОТОЧНОГО ЗАПИТАННЯ — lastQuestion = {file, page}. Оновлюється
 *     лише при зміні слайда показу (stateService.updateState → syncSlide) і
 *     «заморожується» при завершенні показу/виході вчителя, щоб результати
 *     лишалися доступними вчителю після завершення (Issue #83, п. 5 і 9).
 *     Парний слайд = запитання; непарний (>1) = слайд-відповідь, тому що
 *     відповідь на запитання N стоїть на слайді N+1 (структура з Issue #83 §1).
 *  3) ВІДПОВІДІ — answers[`${file}:${page}`][studentId] = variant. ЛИШЕ пам'ять
 *     процесу (як сесії входу, присутність і активні сигнали): перезапуск
 *     сервера скидає їх, матеріали й каталог при цьому не страждають.
 *     Один учень — одна актуальна відповідь на запитання: повторне натискання
 *     ЗАМІНЮЄ попередній вибір, у статистиці враховується лише останній.
 *
 * Правила приймання (Issue #83 §5, §6, §8):
 *  - відповідь приймається лише коли сесія "active" І показ активний (є файл)
 *    І поточний слайд ПАРНИЙ (запитання);
 *  - перехід на непарний слайд закриває приймання цього запитання, але
 *    відповіді зберігаються; повернення на парний слайд відкриває його знову,
 *    якщо тестування не завершено вручну;
 *  - після ручного завершення приймання заблоковано до нового старту.
 *
 * Межі сервісу: він не читає запитів і не вирішує питань прав. PIN, серверні
 * сесії та прив'язка studentId — у auth/sessionService; поточний стан показу
 * передається викликачем як параметр (усередині НЕМАЄ require(stateService) —
 * інакше циклічний імпорт: stateService викликає syncSlide).
 */

/** Написи варіантів у порядку індексів (0 → А … 3 → Г) */
const VARIANT_LETTERS = ["А", "Б", "В", "Г"];
/** Дозволена кількість варіантів (Issue #83 §2: 3 або 4) */
const OPTIONS_ALLOWED = [3, 4];

/** "idle" | "active" | "finished" */
let status = "idle";
/** Кількість варіантів у поточному тестуванні */
let options = 3;
/** {file, page} | null — останнє показане запитання (див. шапку файлу) */
let lastQuestion = null;
/** @type {Record<string, Record<string, number>>} answers["file:page"][studentId] = variant */
let answers = {};

function errorWith(code, message) {
  const error = new Error(message);
  error.status = code;
  return error;
}

/** Номер слайда зі стану показу (захист від некоректних значень) */
function pageOf(value) {
  const page = Number(value);
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
}

function questionKey(question) {
  return question.file + ":" + question.page;
}

/**
 * Запитання для слайда: парний слайд сам є запитанням; непарний більше за 1 —
 * це слайд-відповідь на ПОПЕРЕДНЄ парне запитання; слайд 1 (вступний) —
 * запитання немає (Issue #83 §1: перший слайд без тестових кнопок).
 */
function questionForSlide(file, page) {
  if (page % 2 === 0) return { file, page };
  if (page > 1) return { file, page: page - 1 };
  return null;
}

/**
 * Оновлення вказівника поточного запитання при зміні слайда показу.
 * Викликається з stateService.updateState (файл/номер слайда вже оновлені).
 * Порожній файл (показ завершено) — вказівник НЕ чіпається: результати
 * останнього запитання мають лишитися доступними вчителю.
 */
function syncSlide(file, page) {
  if (!file) return;
  const next = String(file);
  const current = pageOf(page);
  if (!lastQuestion || lastQuestion.file !== next) {
    lastQuestion = questionForSlide(next, current);
    return;
  }
  if (current % 2 === 0) lastQuestion = { file: next, page: current };
  else if (current > 1) lastQuestion = { file: next, page: current - 1 };
  // слайд 1 того самого файлу: лишаємо попереднє запитання (результати не зникають)
}

/**
 * Старт тестування (POST /api/testing/start, лише PIN).
 * @param {object|null} state — поточний стан показу (stateService.getState())
 * @param {*} requestedOptions — 3 або 4 з перемикача вчителя
 */
function start(state, requestedOptions) {
  const selected = Number(requestedOptions);
  if (!OPTIONS_ALLOWED.includes(selected)) {
    throw errorWith(400, "Кількість варіантів відповіді: 3 або 4");
  }
  if (status === "active") {
    throw errorWith(409, "Тестування вже активне — спершу завершіть його");
  }
  status = "active";
  options = selected;
  answers = {};
  // Вказівник запитання — від слайда, на якому стоїть вчитель прямо зараз
  // (без активного показу запитання немає: попередні результати не показуємо)
  const file = state && state.file ? String(state.file) : "";
  lastQuestion = file ? questionForSlide(file, pageOf(state.page)) : null;
  return true;
}

/** Ручне завершення приймання (POST /api/testing/finish, лише PIN) */
function finish() {
  if (status === "idle") throw errorWith(409, "Тестування не запущено");
  status = "finished";
  return true;
}

/**
 * Запис відповіді учня (POST /api/testing/answer).
 * Приймається лише під час активного тестування на парному слайді; повторне
 * натискання замінює попередній вибір того самого учня на це запитання.
 * @param {string} studentId — studentId, прив'язаний до СЕРВЕРНОЇ сесії учня
 * @param {*} variant — індекс варіанта (0 … options-1)
 * @param {object|null} state — поточний стан показу
 */
function answer(studentId, variant, state) {
  if (status !== "active") throw errorWith(409, "Приймання відповідей завершено");
  const file = state && state.file ? String(state.file) : "";
  if (!file) throw errorWith(409, "Демонстрація не активна");
  const page = pageOf(state.page);
  if (page % 2 !== 0) throw errorWith(409, "На цьому слайді запитання немає");
  const value = Number(variant);
  if (!Number.isFinite(value) || Math.floor(value) !== value || value < 0 || value >= options) {
    throw errorWith(400, "Невідомий варіант відповіді");
  }
  const key = file + ":" + page;
  if (!Object.prototype.hasOwnProperty.call(answers, key)) answers[key] = {};
  answers[key][String(studentId)] = value;
  return true;
}

/**
 * Стан тестування для конкретного запитувача (GET /api/state → state.testing).
 *
 * Викладач (PIN або його сесія) отримує вказівник запитання, гістограму та
 * відповіді учнів — для рядків списку й гістограми. Учень отримує ЛИШЕ свій
 * поточний вибір (yourAnswer): чужі відповіді в його стан не потрапляють,
 * studentId береться з прив'язки сесії, а не з запиту.
 *
 * @param {object} identity — {pin:true} | сесія викладача | сесія учня
 * @param {object|null} state — поточний стан показу (файл і номер слайда)
 */
function getView(identity, state) {
  const isTeacher = Boolean(identity) &&
    (identity.pin === true || identity.role === "teacher");
  const file = state && state.file ? String(state.file) : "";
  const page = pageOf(state && state.page);

  // Під час активного тестування вказівник чинний; коли не запущено —
  // вчителю не показуємо застарілі результати попереднього тестування
  const question = status === "idle" ? null : lastQuestion;
  const accepting = status === "active" && Boolean(file) && page % 2 === 0 &&
    Boolean(lastQuestion) && lastQuestion.file === file && lastQuestion.page === page;

  const key = question ? questionKey(question) : "";
  const map = key && Object.prototype.hasOwnProperty.call(answers, key)
    ? answers[key]
    : null;

  let histogram = null;
  if (question) {
    histogram = new Array(options).fill(0);
    if (map) {
      for (const id of Object.keys(map)) {
        const value = map[id];
        if (Number.isInteger(value) && value >= 0 && value < options) histogram[value] += 1;
      }
    }
  }

  if (isTeacher) {
    return {
      status,
      options,
      question,
      accepting,
      histogram,
      answers: map ? Object.assign({}, map) : (question ? {} : null)
    };
  }

  const studentId = identity && identity.studentId ? String(identity.studentId) : "";
  const yourAnswer = map && studentId && Number.isInteger(map[studentId])
    ? map[studentId]
    : null;
  return { status, options, accepting, yourAnswer };
}

/** Повний перелік варіантів (для клієнта й тестів) */
function variantLetters() {
  return VARIANT_LETTERS.slice();
}

module.exports = {
  syncSlide,
  start,
  finish,
  answer,
  getView,
  variantLetters,
  VARIANT_LETTERS,
  OPTIONS_ALLOWED
};
