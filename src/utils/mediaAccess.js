/**
 * mediaAccess.js — єдина серверна перевірка доступу до МЕДІАЗАПИТІВ
 * (/files/:name, /slides/:name/:page, /api/slides/info) — Issue #63.
 *
 * Правила (перевіряються на СЕРВЕРІ при кожному запиті, а не в інтерфейсі):
 *
 * 1. Викладач (PIN у заголовку/тілі або HttpOnly сесія викладача) —
 *    доступ до власних файлів та shared/legacy файлів (owner === null).
 *    Чужі особисті файли (owner !== null і owner !== teacherId) заборонені.
 * 2. Учасник із чинною сесією:
 *    - опублікований (не прихований) матеріал — відкритий для самостійного
 *      перегляду (Issue #63, доробка: відновлено самостійний перегляд);
 *    - прихований матеріал — ЛИШЕ якщо його саме зараз демонструється
 *      викладачем. Перевірка динамічна: після завершення показу або
 *      перемикання показу на інший матеріал доступ одразу припиняється.
 * 3. Без чинної сесії (вхід не зроблено або сервер перезапущено) — 401
 *    (див. auth.mediaIdentity): медіа не видається взагалі.
 *
 * Доступ під час демонстрації НЕ поширюється на каталог: приховані матеріали
 * не потрапляють ні у відповідь /api/files учня, ні в /api/categories, ні в їхні метадані —
 * самостійний перегляд прихованого через прямі посилання та API-обхід залишається закритим.
 */
const fileService = require("../services/fileService");
const stateService = require("../services/stateService");

/**
 * @param {string} name — id/ім'я файлу з URL запиту
 * @param {boolean} isTeacher — медіа-ідентичність запиту (auth.mediaIdentity)
 * @param {string|null} teacherId — teacherId автентифікованого викладача (з сесії)
 * @param {boolean} [isAdmin] — адміністратор (сесія access "admin" або PORTAL_PIN)
 * @returns {boolean} чи дозволити віддати медіа
 */
function canViewMedia(name, isTeacher = false, teacherId = null, isAdmin = false) {
  // Issue #88 (уточнення Tech-lead): адміністратор бачить медіа ВСІХ
  // викладачів — оригінали, PNG-слайди й стан конвертації, включно з
  // прихованими (підтвердження — регресійні тести в test.js). Нижче —
  // правила для всіх інших ролей, вони не змінюються.
  if (isAdmin) return true;
  if (isTeacher) {
    // Викладач бачить власні файли та shared/legacy файли (owner === null).
    // Чужі особисті файли (owner !== null і owner !== teacherId) заборонені.
    const record = fileService.getFileRecord(name);
    if (record && record.owner && record.owner !== teacherId) return false;
    return true;
  }
  // Опублікований матеріал — для самостійного перегляду; прихований —
  // лише на час його активної спільної demonst rarityції
  if (fileService.canAccess(name, false)) return true;

  // Issue #63 (доробка): перевірити, чи матеріал треба відкликати.
  // Якщо вчитель приховав матеріал ПІД ЧАС активної demonst rarityції
  // (був опублікований на старті, став прихованим) — доступ закривається
  // негайно (404), навіть якщо стан показу ще не скинуто.
  if (stateService.isDemonstratedButHiddenDuringDemo(name)) {
    return false; // відкликано під час показу
  }

  // Матеріал був прихованим УЖЕ на момент старту demonst rarityції —
  // доступ дозволено лише в межах активного показу (стара вимога)
  return stateService.isCurrentlyDemonstrated(name);
}

module.exports = { canViewMedia };
