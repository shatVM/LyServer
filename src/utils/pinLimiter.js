/**
 * pinLimiter.js — обмеження кількості спроб введення PIN.
 *
 * Захист від перебору 4-значного PIN пристроями в локальній мережі.
 * Лічильник in-memory, ключ — IP-адреса клієнта.
 * Після pinMaxAttempts невдалих спроб за pinWindowMs — блокування на pinBlockMs.
 */

const config = require("../config");

// key (IP) -> { count, windowStart, blockedUntil }
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
  if (!state.blockedUntil && now - state.windowStart > config.pinWindowMs) {
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
  if (state.count >= config.pinMaxAttempts) {
    state.blockedUntil = Date.now() + config.pinBlockMs;
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
    } else if (!state.blockedUntil && now - state.windowStart > config.pinWindowMs) {
      attempts.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = { isBlocked, registerFailure, reset };
