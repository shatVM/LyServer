/**
 * pinLimiter.js — обмеження кількості спроб введення PIN.
 *
 * Захист від перебору 4-значного PIN пристроями в локальній мережі.
 * Лічильник in-memory, ключ — IP-адреса клієнта (див. auth.clientKey).
 * Після maxAttempts невдалих спроб за windowMs — блокування на blockMs.
 *
 * Issue #85: механізм узагальнили на фабрику createLimiter, бо додали
 * ДРУГИЙ лімітатор — за обліковим записом викладача (accountLimiter,
 * ключ — teacherId): 4-значний PIN має низьку ентропію, тому одного
 * IP-ліміту недостатньо (власник погоджував у Issue #85, коментар
 * 6653554595). Атрибуція спроб за обліковим записом можлива лише тоді,
 * коли запит містить ідентифікатор викладача (X-Portal-Teacher) — тоді
 * невірний PIN зараховується саме цьому запису.
 */

const config = require("../config");

/**
 * Фабрика лімітатора спроб.
 * @param {number} maxAttempts — невдалих спроб до блокування
 * @param {number} windowMs — вікно, за яке рахуються спроби
 * @param {number} blockMs — тривалість блокування
 */
function createLimiter(maxAttempts, windowMs, blockMs) {
  // key -> { count, windowStart, blockedUntil }
  const attempts = new Map();

  function freshState(now) {
    return { count: 0, windowStart: now, blockedUntil: 0 };
  }

  function stateFor(key) {
    const now = Date.now();
    let state = attempts.get(key);

    if (!state) {
      state = freshState(now);
      attempts.set(key, state);
      return state;
    }

    // Блокування минуло — починаємо спочатку
    if (state.blockedUntil && now >= state.blockedUntil) {
      state = freshState(now);
      attempts.set(key, state);
      return state;
    }

    // Вікно спроб минуло (без блокування) — скидаємо лічильник
    if (!state.blockedUntil && now - state.windowStart > windowMs) {
      state.count = 0;
      state.windowStart = now;
    }

    return state;
  }

  function isBlocked(key) {
    const state = attempts.get(key);
    return Boolean(state && state.blockedUntil && Date.now() < state.blockedUntil);
  }

  function registerFailure(key) {
    const state = stateFor(key);
    state.count += 1;
    if (state.count >= maxAttempts) {
      state.blockedUntil = Date.now() + blockMs;
    }
  }

  function reset(key) {
    attempts.delete(key);
  }

  // Періодичне очищення застарілих записів
  setInterval(() => {
    const now = Date.now();
    for (const [key, state] of attempts) {
      if (state.blockedUntil && now >= state.blockedUntil) {
        attempts.delete(key);
      } else if (!state.blockedUntil && now - state.windowStart > windowMs) {
        attempts.delete(key);
      }
    }
  }, 5 * 60 * 1000).unref();

  return { isBlocked, registerFailure, reset };
}

// Основний лімітатор — за IP-адресою клієнта (як і раніше)
const ipLimiter = createLimiter(config.pinMaxAttempts, config.pinWindowMs, config.pinBlockMs);

// Issue #85: ліміт спроб за ОБЛІКОВИМ ЗАПИСОМ викладача (ключ — teacherId).
// Суворіший за IP-ліміт (3 замість 5): невірний PIN із заголовком
// X-Portal-Teacher блокує саме цей обліковий запис, навіть якщо змінюється IP.
const accountLimiter = createLimiter(
  config.teacherPinMaxAttempts,
  config.pinWindowMs,
  config.pinBlockMs
);

module.exports = { ...ipLimiter, createLimiter, accountLimiter };
