/**
 * mediaAccess.js — єдина серверна перевірка доступу до МЕДІАфайлів
 * (/files/:name, /slides/:name/:page, /api/slides/info) — Issue #63, доробка.
 *
 * Правила (перевіряються на СЕРВЕРІ при кожному запиті, а не в інтерфейсі):
 *
 * 1. Викладач (PIN у заголовку/тілі/query або HttpOnly медіа-cookie) —
 *    без обмежень (приватне прев'ю та демонстрація прихованих матеріалів).
 * 2. Опублікований (не прихований) матеріал — відкритий усім.
 * 3. Прихований матеріал для учня — ЛИШЕ якщо його саме зараз демонструється
 *    в поточному сеансі. Перевірка динамічна: після завершення показу,
 *    автозупинки (вихід викладача) або перемикання показу на інший матеріал
 *    доступ до прихованого медіа одразу припиняється.
 *
 * Доступ під час демонстрації НЕ поширюється на каталог: /api/files для учня
 * і надалі не віддає прихований матеріал, отже самостійний перегляд,
 * прямі посилання «з каталогу» та API-обхід залишаються закритими.
 */
const fileService = require("../services/fileService");
const stateService = require("../services/stateService");

/**
 * @param {string} name — id/ім'я файлу з URL запиту
 * @param {boolean} isTeacher — auth.isTeacherMedia(req) для цього запиту
 * @returns {boolean} чи дозволити віддати медіа
 */
function canViewMedia(name, isTeacher = false) {
  if (isTeacher) return true;
  if (fileService.canAccess(name, false)) return true;
  return stateService.isCurrentlyDemonstrated(name);
}

module.exports = { canViewMedia };
