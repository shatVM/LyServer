/**
 * mediaAccess.js — єдина серверна перевірка доступу до МЕДІАфайлів
 * (/files/:name, /slides/:name/:page, /api/slides/info) — Issue #63, Етап 5.
 *
 * Правила (перевіряються на СЕРВЕРІ при кожному запиті, а не в інтерфейсі):
 *
 * 1. Викладач (PIN у заголовку/тілі/query або HttpOnly сесія викладача) —
 *    без обмежень (приватне прев'ю та демонстрація прихованих матеріалів).
 * 2. Учень/учасник — ЛИШЕ медіа матеріалу, який демонструється зараз.
 *    Перевірка динамічна: після завершення показу, автозупинки (вихід
 *    викладача) або перемикання показу на інший матеріал доступ одразу
 *    припиняється; поза показом медіафайли недоступні навіть опубліковані.
 *
 * Доступ під час демонстрації НЕ поширюється на каталог: /api/files і
 * /api/categories закриті для учня взагалі (403), отже самостійний перегляд,
 * прямі посилання «з каталогу» та API-обхід залишаються закритими.
 */
const stateService = require("../services/stateService");

/**
 * @param {string} name — id/ім'я файлу з URL запиту
 * @param {boolean} isTeacher — медіа-ідентичність запиту (auth.mediaIdentity)
 * @returns {boolean} чи дозволити віддати медіа
 */
function canViewMedia(name, isTeacher = false) {
  if (isTeacher) return true;
  return stateService.isCurrentlyDemonstrated(name);
}

module.exports = { canViewMedia };
