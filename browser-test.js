/**
 * browser-test.js — автоматизовані браузерні регресійні тести (Issue #63).
 *
 * Запуск:  npm run test:browser      (або: node browser-test.js)
 *
 * Що перевіряє (9 обов'язкових сценаріїв + перевірка передачі PIN), Issue #63
 * (Етап 5 і доробка — доступ учнів, PIN і кеш медіа):
 *   Сценарій 0 — самостійний перегляд: у ролі «учень» каталог відкритий, але
 *     ЛИШЕ опублікованими матеріалами (картки в розмітці та /api/files 200;
 *     прихованих немає ні в одному з них), опублікований матеріал відкривається
 *     без показу викладача, медіа прихованого — 404, без входу — 401/403,
 *     медіа й стан віддаються з Cache-Control: no-store, а ?pin= у URL не
 *     авторизує нічого;
 *   Сценарій 1 — викладач демонструє ОПУБЛІКОВАНИЙ матеріал → обидва учні
 *     бачать його медіа (відео) без перезавантаження;
 *   Сценарій 2 — викладач демонструє ПРИХОВАНИЙ матеріал → обидва учні бачать
 *     медіа активного показу, але самого матеріалу немає в їхньому каталозі
 *     (ні в API, ні в розмітці), сирий файл недоступний (лише PNG-слайди);
 *   Сценарій 3 — після завершення показу доступ учня до прихованого медіа
 *     припиняється (/files, /slides, /api/slides/info → 404), а каталог
 *     опублікованих матеріалів повертається на тій самій сторінці;
 *   Сценарій 4 — довільні прямі URL прихованого матеріалу недоступні учневі
 *     без активного показу; каталог при цьому лишається відкритим (без
 *     прихованого);
 *   Сценарій 5 — ДВА незалежні клієнти учнів одночасно отримують медіа показу;
 *   Сценарій 6 — приховування/публікація оновлюють каталог учня БЕЗ
 *     перезавантаження; після перемикання показу медіа прихованого матеріалу
 *     закривається, активна демонстрація для учнів не переривається;
 *   Сценарій 7 — тестування під час демонстрації (Issue #83): старт приймання,
 *     відповіді обох учнів, гістограма, автозачинення, ручне завершення;
 *   Сценарій 8 — автоперегортання «Вперед» (Issue #83, уточнення Tech-lead):
 *     окремий блок «Тестування» поза блоком «Учні», панель із СТАРТ/СТОП,
 *     реальний цикл 30/15 с (миттєвий перший перехід, чергування інтервалів,
 *     таймер), короткі інтервали 1/2 с із редагуванням «на льоту», незалежність
 *     від блоку «Учні», зупинка при приховуванні блока/відсутній кнопці/переході
 *     на іншу сторінку;
 *   PIN/URL  — медіа-запити викладача не містять ?pin= (HttpOnly cookie),
 *     cookie не авторизує API керування, скасовується при виході викладача,
 *     підроблена cookie не дає доступу.
 *
 * Як Chrome/Chromium не знайдено (або Node без глобального WebSocket) —
 * тести пропускаються з чітким повідомленням про причину (exit code 0);
 * `npm test` (test.js) залишається основним автоматичним шлюзом.
 *
 * Сервер піднімається окремим екземпляром на своєму порту, тестові файли
 * створюються і повністю видаляються (net-zero), метадані порівнюються
 * stable-рядком до/після — дані власника не змінюються.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = __dirname;
const PORT = 4600 + (process.pid % 50);
const BASE = `http://127.0.0.1:${PORT}`;
const PIN = process.env.PORTAL_PIN || "2468";
const META_PATH = path.join(REPO, "materials", ".metadata.json");
const TMP = path.join(os.tmpdir(), "lyserver-browser-test-" + process.pid);

const TEST_MEDIA = "BT тест опубліковане.wav"; // опублікований матеріал
const TEST_HIDDEN = "BT тест приховане.pdf"; // прихований матеріал
const TEST_SLIDES = "BT тест слайди.pdf"; // 4-сторінковий PDF для автоперегортання

// --------------------------- пошук Chrome/Chromium --------------------------
function findChrome() {
  const local = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : "";
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    local,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || "";
}

function skip(reason) {
  console.error("");
  console.error("BROWSER TESTS SKIPPED");
  console.error("Причина пропуску: " + reason);
  console.error("Підказка: встановіть Chrome/Chromium або задайте змінну оточення CHROME_PATH=<шлях до браузера>.");
  console.error("Базові HTTP/статичні перевірки при цьому виконуються окремо: npm test");
  process.exit(0);
}

if (typeof WebSocket === "undefined") {
  skip("потрібен Node.js 22+ (у цій версії немає глобального WebSocket для CDP)");
}
const CHROME = findChrome();
if (!CHROME) skip("Chrome/Chromium не знайдено у типових розташуваннях і CHROME_PATH не задано");

// --------------------------- мінімальні тестофайли --------------------------
// Валідний WAV (PCM моно 8 кГц, 0.25 с тиші): <video> мусить успішно
// завантажити метадані (фейковий файл дає MEDIA_ERR_SRC_NOT_SUPPORTED)
function tinyWav() {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * 0.25);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf; // решта — нулі (тиша)
}

// Мінімальний валідний PDF (1 сторінка) — для перевірки слайдів показу
const TINY_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n" +
    "4 0 obj << /Length 44 >> stream\n" +
    "BT /F1 24 Tf 72 720 Td (Hello) Tj ET\n" +
    "endstream endobj\n" +
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n" +
    "trailer << /Root 1 0 R >>\n" +
    "%%EOF\n",
  "ascii"
);
const TINY_PDF_BODY = new ArrayBuffer(TINY_PDF.length);
new Uint8Array(TINY_PDF_BODY).set(TINY_PDF);

// Мінімальний валідний PDF на 4 сторінки — фікстура для тесту автоперегортання
// (Issue #83): потрібні щонайменше три переходи «Вперед» (1→2→3→4), тож реальний
// цикл 30/15 с встигає прогнатися без підпирання кінця документа
function fourPagePdf() {
  const kids = [3, 5, 7, 9].map((n) => n + " 0 R").join(" ");
  let body = "%PDF-1.4\n";
  body += "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
  body += "2 0 obj << /Type /Pages /Kids [" + kids + "] /Count 4 >> endobj\n";
  for (let i = 0; i < 4; i++) {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    const stream = "BT /F1 24 Tf 72 720 Td (Page " + (i + 1) + ") Tj ET";
    body += pageNum + " 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents " + contentNum + " 0 R /Resources << /Font << /F1 11 0 R >> >> >> endobj\n";
    body += contentNum + " 0 obj << /Length " + stream.length + " >> stream\n" +
      stream + "\nendstream endobj\n";
  }
  body += "11 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n";
  body += "trailer << /Root 1 0 R >>\n%%EOF\n";
  return Buffer.from(body, "ascii");
}

// --------------------------- утиліти перевірок -----------------------------
const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (info ? "   [" + info + "]" : ""));
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

let server = null;
const chromes = [];

// --------------------------- CDP-сесії -------------------------------------
function connectSession(url, name) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(url);
    const sess = {
      name,
      ws: w,
      id: 0,
      pending: new Map(),
      requests: [],
      // Статуси HTTP-відповідей /api/auth/logout — перевірка успішного
      // завершення запиту logout (Issue #88: Tech-lead просив окремо)
      logoutStatuses: [],
      errors: { consoleErrors: [], exceptions: [], logErrors: [], loadingFailed: [] },
      // URL, для якого CDP-перехоплення Fetch відповідає 500 (тест помилки logout)
      fetchFail: null
    };
    w.onopen = () => resolve(sess);
    w.onerror = () => reject(new Error("CDP WebSocket error: " + name));
    w.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && sess.pending.has(msg.id)) {
        const { res, rej } = sess.pending.get(msg.id);
        sess.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method === "Network.requestWillBeSent") {
        // Журнал URL медіазапитів — для перевірки відсутності ?pin= (Issue #63)
        sess.requests.push(msg.params.request.url);
      } else if (msg.method === "Network.responseReceived") {
        const resp = msg.params.response;
        if (resp && String(resp.url || "").includes("/api/auth/logout")) {
          sess.logoutStatuses.push(resp.status);
        }
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        sess.errors.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        sess.errors.exceptions.push((d.text || "") + " " + (d.exception?.description || ""));
      } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        sess.errors.logErrors.push(msg.params.entry.text + " " + (msg.params.entry.url || ""));
      } else if (msg.method === "Network.loadingFailed") {
        sess.errors.loadingFailed.push(msg.params.errorText + " " + (msg.params.type || ""));
      } else if (msg.method === "Fetch.requestPaused") {
        // Перехоплення запиту logout: коли увімкнено правило sess.fetchFail —
        // відповідаємо СПРАВЖНІМ HTTP 500 (тест помилки logout на клієнті),
        // усі інші запити пропускаємо без змін
        const rule = sess.fetchFail;
        if (rule && String(msg.params.request.url || "").includes(rule)) {
          cdp(sess, "Fetch.fulfillRequest", {
            requestId: msg.params.requestId,
            responseCode: 500,
            responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
            body: Buffer.from("симульована помилка сервера logout").toString("base64")
          }).catch(() => {});
        } else {
          cdp(sess, "Fetch.continueRequest", { requestId: msg.params.requestId }).catch(() => {});
        }
      }
    };
  });
}

function cdp(sess, method, params = {}) {
  const id = ++sess.id;
  sess.ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => sess.pending.set(id, { res, rej }));
}

async function evaluate(sess, expression) {
  const r = await cdp(sess, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(sess.name + " evaluate: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function waitFor(sess, expression, timeoutMs = 15000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evaluate(sess, expression)) return true; } catch { /* retry */ }
    await delay(step);
  }
  return false;
}

async function gotoS(sess, p) {
  await cdp(sess, "Page.navigate", { url: BASE + p });
  await waitFor(sess, "document.readyState === 'complete'", 20000);
  await delay(400);
  // маркер відсутності перезавантаження (має пережити оновлення каталогу)
  await evaluate(sess, "window.__mark = 42; true;");
}

/** Попередня сторінка в історії браузера (БЕЗ переходу) — для тестів Back */
async function historyPrevPath(sess) {
  const h = await cdp(sess, "Page.getNavigationHistory");
  const entries = h.entries || [];
  const prev = entries[h.currentIndex - 1];
  if (!prev || !prev.url) return "";
  try { return new URL(prev.url).pathname; } catch { return ""; }
}

/** Справжній Back (history.back()) із очікуванням переходу й готовності документа */
async function goBack(sess, expectedPath) {
  try {
    await evaluate(sess, "history.back(); true;");
  } catch { /* навігація може знищити JS-контекст раніше за відповідь */ }
  const ok = await waitFor(sess, `location.pathname === ${JSON.stringify(expectedPath)}`, 15000);
  await waitFor(sess, "document.readyState === 'complete'", 20000);
  await delay(500);
  return ok;
}

async function waitRoleModal(sess, timeoutMs = 12000) {
  return waitFor(
    sess,
    "document.getElementById('roleModal') && document.getElementById('roleModal').style.display === 'flex'",
    timeoutMs
  );
}

async function loginStudent(sess, name) {
  if (!(await waitRoleModal(sess))) return false;
  await evaluate(
    sess,
    "document.getElementById('modalStudentName').value = " + JSON.stringify(name) + ";" +
    "document.getElementById('btnChooseStudent').click(); true;"
  );
  return waitFor(sess, "document.getElementById('roleModal').style.display === 'none'", 10000);
}

async function loginTeacher(sess) {
  if (!(await waitRoleModal(sess))) return false;
  await evaluate(
    sess,
    "document.getElementById('modalTeacherPin').value = " + JSON.stringify(PIN) + ";" +
    "document.getElementById('btnChooseTeacher').click(); true;"
  );
  return waitFor(sess, "document.getElementById('roleModal').style.display === 'none'", 10000);
}

/** Вхід конкретним персональним PIN викладача (для тесту ПІБ і виходу) */
async function loginTeacherWithPin(sess, pinValue) {
  if (!(await waitRoleModal(sess))) return false;
  await evaluate(
    sess,
    "document.getElementById('modalTeacherPin').value = " + JSON.stringify(pinValue) + ";" +
    "document.getElementById('btnChooseTeacher').click(); true;"
  );
  return waitFor(sess, "document.getElementById('roleModal').style.display === 'none'", 10000);
}

/** Справжня HttpOnly-сесійна cookie сторінки (CDP, не видна JS) */
async function getSessionCookie(sess) {
  const r = await cdp(sess, "Network.getCookies", { urls: [BASE + "/"] });
  const found = (r.cookies || []).find((c) => c.name === "ly_session");
  return found ? found.value : "";
}

/** Увімкнути мережеве перехоплення: запити, що містять urlPart, → HTTP 500 */
async function setFetchFail(sess, urlPart) {
  sess.fetchFail = urlPart;
  await cdp(sess, "Fetch.enable", {
    patterns: [{ urlPattern: "*" + urlPart + "*", requestStage: "Request" }]
  });
}

/** Вимкнути перехоплення — подальші запити йдуть на сервер без змін */
async function clearFetchFail(sess) {
  sess.fetchFail = null;
  await cdp(sess, "Fetch.disable");
}

let chromeSeq = 0;
async function launchChrome(name) {
  fs.mkdirSync(TMP, { recursive: true });
  const cdpPort = 9600 + chromeSeq * 7;
  const proc = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=" + cdpPort,
    "--user-data-dir=" + path.join(TMP, "profile-" + name),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    "--window-size=1400,1100",
    "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  chromeSeq++;
  chromes.push(proc);
  const cdpBase = `http://127.0.0.1:${cdpPort}`;
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(cdpBase + "/json/version"); up = r.ok; } catch { /* not yet */ }
    if (!up) await delay(500);
  }
  if (!up) throw new Error("Chrome CDP не піднявся: " + name);
  let target;
  try {
    target = await (await fetch(cdpBase + "/json/new?" + encodeURIComponent("about:blank"), { method: "PUT" })).json();
  } catch {
    target = await (await fetch(cdpBase + "/json/new?" + encodeURIComponent("about:blank"))).json();
  }
  const sess = await connectSession(target.webSocketDebuggerUrl, name);
  await cdp(sess, "Page.enable");
  await cdp(sess, "Runtime.enable");
  await cdp(sess, "Log.enable");
  await cdp(sess, "Network.enable");
  return sess;
}

// ---------------------- вирази на сторінці ---------------------------------
const cardExpr = (name) =>
  `[...document.querySelectorAll('#files .file')].find(c => c.textContent.includes(${JSON.stringify(name)}))`;

async function clickFileButton(sess, namePart, btnText) {
  return evaluate(
    sess,
    `(() => { const card = (${cardExpr(namePart)});` +
    ` if (!card) return false;` +
    ` const btn = [...card.querySelectorAll('.file-actions button')].find(b => b.textContent.includes(${JSON.stringify(btnText)}));` +
    ` if (!btn) return false; btn.click(); return true; })()`
  );
}

async function expandAllCategories(sess) {
  await evaluate(
    sess,
    `[...document.querySelectorAll('.category-toggle')].forEach(t => { if (t.getAttribute('aria-expanded') === 'false') t.click(); }); true;`
  );
}

/** Натиснути кнопку картки викладача (каталог має бути розгорнуто) */
async function teacherAction(sess, namePart, btnText) {
  await expandAllCategories(sess);
  await waitFor(sess, `!!(${cardExpr(namePart)})`, 8000);
  return clickFileButton(sess, namePart, btnText);
}

// HTTP-запити ВСЕРЕДИНІ сторінки (без заголовків і параметрів авторизації):
// саме так працюють <img>/<video> та «прямі посилання» з адресного рядка.
// Авторизація — лише HttpOnly cookie сесії (Issue #63, Етап 5).
// cache: "no-store" — обов'язково: саме політику кешування СЕРВЕРА ми й
// перевіряємо (Cache-Control приватних медіа), а локальний кеш браузера міг би
// відповісти замість сервера
const httpStatus = (sess, url) =>
  evaluate(sess, `fetch(${JSON.stringify(url)}, { cache: "no-store" }).then(r => r.status)`);
// Заголовок відповіді сервера (перевірка Cache-Control приватних медіа)
const httpHeader = (sess, url, header) =>
  evaluate(sess, `fetch(${JSON.stringify(url)}, { cache: "no-store" })` +
    `.then(r => r.headers.get(${JSON.stringify(header)}))`);
// Той самий запит, але БЕЗ cookie (credentials: "omit") — перевірка вимоги
// повторного входу для медіа та стану демонстрації
const httpStatusNoCreds = (sess, url) =>
  evaluate(sess, `fetch(${JSON.stringify(url)}, { cache: "no-store", credentials: "omit" }).then(r => r.status)`);
// JSON-відповідь; для текстових відповідей (403 без JSON) повертає { __status }
const httpJson = (sess, url) =>
  evaluate(sess, `fetch(${JSON.stringify(url)}, { cache: "no-store" }).then(async r => {
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { __status: r.status }; }
  })`);

const apiState = async () =>
  (await fetch(BASE + "/api/state", { headers: { "X-Portal-Pin": PIN } })).json();
const apiTeacherFiles = async () =>
  (await fetch(BASE + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();

async function waitDemoFile(fileId, wantActive) {
  for (let i = 0; i < 30; i++) {
    const s = await apiState();
    if (wantActive ? s.file === fileId : !s.file) return true;
    await delay(300);
  }
  return false;
}

// вирази стану медіа у глядачі учня/викладача
const mediaExpr = (kind) =>
  kind === "video"
    ? `(() => { const v = document.querySelector('#viewer video'); return !!v && v.readyState >= 1 && !v.error; })()`
    : `(() => { const i = document.querySelector('#viewer img.slide-img'); return !!i && i.naturalWidth > 0; })()`;

// --------------------------- основний сценарій -----------------------------
async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  // 1) ВЛАСНИЙ екземпляр сервера (не чіпає робочий порт власника)
  server = spawn(process.execPath, ["server.js"], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), PORTAL_PIN: PIN, HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  server.stdout.on("data", (c) => { serverLog += c; });
  server.stderr.on("data", (c) => { serverLog += c; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(BASE + "/health"); up = r.ok; } catch { /* not yet */ }
    if (!up) await delay(500);
  }
  if (!up) throw new Error("Сервер не піднявся. LOG:\n" + serverLog);
  check(`Локальний екземпляр сервера піднявся (порт ${PORT})`, true);

  // 1а) Попереднє прибирання (net-zero): якщо ПОПЕРЕДНІЙ прогін було
  // перервано, його тестові файли лишаються у спільному сховищі. Дублікати
  // з однаковою назвою збивають сценарії: карток дві, клік іде по чужій
  // (старій) картці, а перевірка стану чекає id нового файлу — показ
  // «не стартує». Прибираємо залишки ДО фіксації базового стану метаданих.
  const staleLeftovers = (await apiTeacherFiles())
    .filter((f) => f.name === TEST_MEDIA || f.name === TEST_HIDDEN || f.name === TEST_SLIDES);
  for (const f of staleLeftovers) {
    await fetch(BASE + "/api/files/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: PIN, file: f.id })
    });
  }
  const staleAfter = (await apiTeacherFiles())
    .filter((f) => f.name === TEST_MEDIA || f.name === TEST_HIDDEN || f.name === TEST_SLIDES);
  check("Залишки тестових файлів попередніх прогонів прибрано (net-zero)",
    staleAfter.length === 0,
    JSON.stringify(staleLeftovers.map((f) => f.id)));

  const metaBeforeStable = stable(JSON.parse(fs.readFileSync(META_PATH, "utf-8")));

  // 2) Тестові дані (net-zero): WAV — опублікований, PDF — прихований
  const upWav = await fetch(BASE + "/api/upload?name=" + encodeURIComponent(TEST_MEDIA), {
    method: "POST",
    headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
    body: tinyWav()
  });
  const wavData = upWav.status === 201 ? await upWav.json() : {};
  const wavId = wavData.id || "";

  const upPdf = await fetch(BASE + "/api/upload?name=" + encodeURIComponent(TEST_HIDDEN), {
    method: "POST",
    headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
    body: TINY_PDF_BODY
  });
  const pdfData = upPdf.status === 201 ? await upPdf.json() : {};
  const pdfId = pdfData.id || "";
  check("Тестові файли завантажено (net-zero)", upWav.status === 201 && upPdf.status === 201 && Boolean(wavId) && Boolean(pdfId),
    JSON.stringify({ wav: wavId, pdf: pdfId }));
  if (!wavId || !pdfId) throw new Error("Не вдалося створити тестові файли");

  const hideResp = await fetch(BASE + "/api/files/toggle-hide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN, file: pdfId, hidden: true })
  });
  check("Прихований матеріал приховано від учнів (початковий стан)", hideResp.status === 200,
    "status=" + hideResp.status);

  let pdfReady = false;
  for (let i = 0; i < 40 && !pdfReady; i++) {
    const info = await (await fetch(BASE + "/api/slides/info?file=" + encodeURIComponent(pdfId),
      { headers: { "X-Portal-Pin": PIN } })).json();
    if (info && info.ready) pdfReady = true;
    else if (info && info.failed) break;
    else await delay(500);
  }
  check("Конвертація тестового PDF у PNG-слайди завершилася", pdfReady);

  // 3) Три незалежні клієнти
  const T = await launchChrome("teacher");
  const S1 = await launchChrome("stu1");
  const S2 = await launchChrome("stu2");
  check("Три незалежні клієнти Chrome (викладач + 2 учні) підключилися до CDP", true);

  await gotoS(T, "/demonstration");
  const tIn = await loginTeacher(T);
  // Робоче місце учня — сторінка «Перегляд матеріалів»: тут він бачить каталог
  // опублікованих матеріалів і самостійно відкриває їх, а під час показу
  // викладача — синхронізовану демонстрацію
  await gotoS(S1, "/materials");
  const s1In = await loginStudent(S1, "Браузер Учень А");
  await gotoS(S2, "/materials");
  const s2In = await loginStudent(S2, "Браузер Учень Б");
  check("Входи викладача та двох учнів виконано", tIn && s1In && s2In,
    JSON.stringify({ tIn, s1In, s2In }));

  await waitFor(T, "document.querySelectorAll('#files .file').length > 0", 20000);
  for (const sess of [S1, S2]) {
    // каталог учня завантажується після входу без перезавантаження сторінки
    await waitFor(sess,
      "document.querySelectorAll('#files .file').length > 0 && window.__mark === 42", 15000);
  }

  // ---------------- Сценарій 0: самостійний перегляд опублікованого --------
  const s0 = {};
  s0.cardsS1 = await evaluate(S1, "document.querySelectorAll('#files .file').length");
  s0.cardsS2 = await evaluate(S2, "document.querySelectorAll('#files .file').length");
  s0.hiddenCardS1 = await evaluate(S1, `!!(${cardExpr(TEST_HIDDEN)})`);
  s0.files = await httpStatus(S1, "/api/files");
  s0.cats = await httpStatus(S1, "/api/categories");
  s0.state = await httpStatus(S1, "/api/state");
  const s0List = await httpJson(S1, "/api/files");
  s0.listHasWav = Array.isArray(s0List) && s0List.some((f) => f.id === wavId);
  s0.listHasPdf = Array.isArray(s0List) && s0List.some((f) => f.id === pdfId);
  s0.pubMedia = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  s0.hiddenMedia = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  s0.stateNoCreds = await httpStatusNoCreds(S1, "/api/state");
  s0.mediaNoCreds = await httpStatusNoCreds(S1, "/files/" + encodeURIComponent(wavId));
  // ?pin= у URL не авторизує нічого: без cookie такий запит має відхилятися
  s0.statePinInQuery = await httpStatusNoCreds(S1, "/api/state?pin=" + PIN);
  s0.mediaPinInQuery = await httpStatusNoCreds(S1, "/files/" + encodeURIComponent(wavId) + "?pin=" + PIN);
  // Політика кешування приватних відповідей
  s0.mediaCache = await httpHeader(S1, "/files/" + encodeURIComponent(wavId), "cache-control");
  s0.stateCache = await httpHeader(S1, "/api/state", "cache-control");
  s0.filesCache = await httpHeader(S1, "/api/files", "cache-control");
  check("Сценарій 0: каталог учня відкритий лише опублікованим (картки й API 200), прихованих немає",
    s0.cardsS1 > 0 && s0.cardsS2 > 0 && !s0.hiddenCardS1 &&
      s0.files === 200 && s0.cats === 200 && s0.state === 200 &&
      s0.listHasWav && !s0.listHasPdf,
    JSON.stringify(s0));
  check("Сценарій 0: медіа опублікованого відкриті, прихованого — 404, без входу — 401",
    s0.pubMedia === 200 && s0.hiddenMedia === 404 &&
      s0.stateNoCreds === 401 && s0.mediaNoCreds === 401,
    JSON.stringify(s0));
  check("Сценарій 0: приватні відповіді не кешуються (Cache-Control: no-store)",
    /no-store/i.test(s0.mediaCache || "") && /no-store/i.test(s0.stateCache || "") &&
      /no-store/i.test(s0.filesCache || ""),
    JSON.stringify({ media: s0.mediaCache, state: s0.stateCache, files: s0.filesCache }));
  check("Сценарій 0: ?pin= у URL не авторизує ні стан, ні медіа (401)",
    s0.statePinInQuery === 401 && s0.mediaPinInQuery === 401,
    JSON.stringify({ state: s0.statePinInQuery, media: s0.mediaPinInQuery }));

  // ---------------- Сценарій 1: показ опублікованого ------------------------
  const demo1Clicked = await teacherAction(T, TEST_MEDIA, "Показувати всім");
  const demo1Started = await waitDemoFile(wavId, true);
  check("Сценарій 1: демонстрація опублікованого матеріалу запущена",
    demo1Clicked && demo1Started, JSON.stringify({ demo1Clicked, demo1Started }));

  const tVideo1 = await waitFor(T, mediaExpr("video"), 15000);
  check("Сценарій 1: медіа опублікованого матеріалу відкривається у викладача", tVideo1);
  const s1Video1 = await waitFor(S1, mediaExpr("video") + " && window.__mark === 42", 15000);
  const s2Video1 = await waitFor(S2, mediaExpr("video") + " && window.__mark === 42", 15000);
  check("Сценарій 1: обидва учні бачать медіа опублікованого матеріалу без перезавантаження",
    s1Video1 && s2Video1, JSON.stringify({ s1Video1, s2Video1 }));

  // --- Issue #75: IP у списку учнів та розгорнутий режим показу -------------
  // Викладач бачить під ім'ям кожного учня серверну IP-адресу (дрібний сірий
  // рядок), надану полем /api/presence/students
  const tIpShown = await waitFor(T,
    `(() => { const el = document.querySelector('.student-row .student-ip');` +
    ` return !!el && (/^([0-9]{1,3}\\.){3}[0-9]{1,3}$|^[0-9a-f:]+$/i).test(el.textContent.trim()); })()`,
    15000);
  check("Сценарій 1: IP-адреса учня у тому самому рядку, що й ім'я, у списку викладача", tIpShown);

  // Issue #75 (доробка): статус — лише крапка відповідного кольору, без слів
  const tDotOnly = await waitFor(T,
    `(() => { const rows = [...document.querySelectorAll('.student-row')];` +
    ` return rows.some(r => r.querySelector('.status-dot-online')) &&` +
    ` rows.every(r => !r.textContent.includes('Онлайн')); })()`, 15000);
  check("Сценарій 1: статус учня — лише крапка, слова «Онлайн» у рядку немає", tDotOnly);

  // Під час показу матеріал у учнів займає весь доступний простір вікна
  // (body.demo-focus), є кнопка системного fullscreen; у викладача — ні
  const s1Focus = await waitFor(S1,
    `document.body.classList.contains('demo-focus') && window.__mark === 42`, 15000);
  const s2Focus = await waitFor(S2,
    `document.body.classList.contains('demo-focus') && window.__mark === 42`, 15000);
  const tNoFocus = await evaluate(T, `!document.body.classList.contains('demo-focus')`);
  const s1FsBtn = await evaluate(S1,
    `(() => { const b = document.getElementById('demoFullscreenBtn');` +
    ` return !!b && b.style.display !== 'none'; })()`);
  const s1ViewerBig = await evaluate(S1,
    `(() => { const v = document.getElementById('viewer');` +
    ` return !!v && v.getBoundingClientRect().height >= window.innerHeight * 0.85; })()`);
  check("Сценарій 1: під час показу в учнів розгорнутий режим і кнопка «На весь екран», #viewer майже на весь екран, у викладача режиму немає",
    s1Focus && s2Focus && tNoFocus && s1FsBtn && s1ViewerBig,
    JSON.stringify({ s1Focus, s2Focus, tNoFocus, s1FsBtn, s1ViewerBig }));

  // ---------------- Сценарій 5 (частина 1): два клієнти одночасно ----------
  // (перевіряється окремо нижче під час показу прихованого матеріалу)

  // ---------------- Сценарій 2: показ прихованого матеріалу -----------------
  const demo2Clicked = await teacherAction(T, TEST_HIDDEN, "Показувати всім");
  const demo2Started = await waitDemoFile(pdfId, true);
  check("Сценарій 2: демонстрація ПРИХОВАНОГО матеріалу запущена",
    demo2Clicked && demo2Started, JSON.stringify({ demo2Clicked, demo2Started }));

  const s1Slide2 = await waitFor(S1, mediaExpr("slide"), 20000);
  const s2Slide2 = await waitFor(S2, mediaExpr("slide"), 20000);
  check("Сценарій 5: ДВА клієнти учнів одночасно бачать медіа прихованого показу",
    s1Slide2 && s2Slide2, JSON.stringify({ s1Slide2, s2Slide2 }));

  const s1HiddenCardGone = await evaluate(S1, `!(${cardExpr(TEST_HIDDEN)}) && window.__mark === 42`);
  const s2HiddenCardGone = await evaluate(S2, `!(${cardExpr(TEST_HIDDEN)}) && window.__mark === 42`);
  check("Сценарій 2: у каталозі обох учнів прихованого матеріалу немає (самостійний перегляд недоступний)",
    s1HiddenCardGone && s2HiddenCardGone, JSON.stringify({ s1HiddenCardGone, s2HiddenCardGone }));

  const listDuring = await httpStatus(S1, "/api/files");
  const listDuringJson = await httpJson(S1, "/api/files");
  const slideDuring = await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1");
  const slideDuringCache = await httpHeader(S1, "/slides/" + encodeURIComponent(pdfId) + "/1", "cache-control");
  const infoDuring = await httpJson(S1, "/api/slides/info?file=" + encodeURIComponent(pdfId));
  const rawDuring = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  const listDuringLeak = Array.isArray(listDuringJson) && listDuringJson.some((f) => f.id === pdfId);
  check("Сценарій 2: медіа активної демонстрації відкриті учневі (слайди 200, info ready), а в каталозі матеріалу немає (200)",
    slideDuring === 200 && infoDuring && infoDuring.ready === true &&
      listDuring === 200 && !listDuringLeak,
    JSON.stringify({ slideDuring, ready: infoDuring && infoDuring.ready, catalog: listDuring, leak: listDuringLeak }));
  check("Сценарій 2: слайди приватного показу не кешуються (Cache-Control: no-store)",
    /no-store/i.test(slideDuringCache || ""), "cache-control=" + slideDuringCache);
  check("Сценарій 2: сирий файл прихованого PDF недоступний учневі (лише PNG-слайди)",
    rawDuring === 403, "status=" + rawDuring);

  // сесія викладача: доступ без ?pin= у URL і без заголовків
  const tRawHidden = await httpStatus(T, "/files/" + encodeURIComponent(pdfId));
  const tSlidesHidden = await httpStatus(T, "/slides/" + encodeURIComponent(pdfId) + "/1");
  const tHasCookieVisible = await evaluate(T, "document.cookie.includes('ly_session')");
  check("PIN/URL: викладач відкриває приховані медіа без pin у URL (HttpOnly cookie)",
    tRawHidden === 200 && tSlidesHidden === 200 && !tHasCookieVisible,
    JSON.stringify({ files: tRawHidden, slides: tSlidesHidden, cookieInJs: tHasCookieVisible }));

  const mediaRequests = T.requests.filter((u) => /\/(files|slides)\//.test(u));
  const withPin = mediaRequests.filter((u) => u.includes("pin="));
  check("PIN/URL: жоден медіа-запит викладача не містить ?pin= (мережевий запис)",
    mediaRequests.length > 0 && withPin.length === 0,
    JSON.stringify({ total: mediaRequests.length, withPin: withPin.slice(0, 3) }));

  // ---------------- Сценарій 3: завершення показу ---------------------------
  await evaluate(T, "document.getElementById('stopDemo').click(); true;");
  const demoStopped = await waitDemoFile(pdfId, false);
  const s1BackToCatalog = await waitFor(S1,
    `!document.getElementById('viewerTitle').textContent.startsWith('Спільна демонстрація') && window.__mark === 42`, 15000);
  const s2BackToCatalog = await waitFor(S2,
    `!document.getElementById('viewerTitle').textContent.startsWith('Спільна демонстрація') && window.__mark === 42`, 15000);
  // Каталог опублікованих матеріалів повертається на тій самій сторінці
  const s1CatalogVisible = await waitFor(S1,
    `document.getElementById('materialsCatalogPanel').style.display !== 'none' && ` +
    `document.querySelectorAll('#files .file').length > 0 && window.__mark === 42`, 15000);
  const s2CatalogVisible = await waitFor(S2,
    `document.getElementById('materialsCatalogPanel').style.display !== 'none' && ` +
    `document.querySelectorAll('#files .file').length > 0 && window.__mark === 42`, 15000);
  check("Сценарій 3: показ завершено, обидва учні вийшли з режиму показу, каталог повернувся без перезавантаження",
    demoStopped && s1BackToCatalog && s2BackToCatalog && s1CatalogVisible && s2CatalogVisible,
    JSON.stringify({ demoStopped, s1BackToCatalog, s2BackToCatalog, s1CatalogVisible, s2CatalogVisible }));

  // --- Issue #75: завершення показу повертає учня до звичайного режиму ------
  const s1FocusOff = await waitFor(S1,
    `!document.body.classList.contains('demo-focus') && window.__mark === 42`, 15000);
  const s2FocusOff = await waitFor(S2,
    `!document.body.classList.contains('demo-focus') && window.__mark === 42`, 15000);
  const s1FsBtnHidden = await waitFor(S1,
    `(() => { const b = document.getElementById('demoFullscreenBtn');` +
    ` return !!b && b.style.display === 'none'; })() && window.__mark === 42`, 15000);
  check("Сценарій 3: після завершення показу розгорнутий режим знято і кнопка системного fullscreen прихована",
    s1FocusOff && s2FocusOff && s1FsBtnHidden,
    JSON.stringify({ s1FocusOff, s2FocusOff, s1FsBtnHidden }));

  const slideAfter = await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1");
  const filesAfter = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  const infoAfter = await httpStatus(S1, "/api/slides/info?file=" + encodeURIComponent(pdfId));
  check("Сценарій 3: після завершення показу доступ учня до прихованого медіа припинено",
    slideAfter === 404 && filesAfter === 404 && infoAfter === 404,
    JSON.stringify({ slideAfter, filesAfter, infoAfter }));

  // ---------------- Сценарій 4: довільні прямі URL --------------------------
  const s4 = {
    files: await httpStatus(S1, "/files/" + encodeURIComponent(pdfId)),
    slides: await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1"),
    info: await httpStatus(S1, "/api/slides/info?file=" + encodeURIComponent(pdfId))
  };
  check("Сценарій 4: прямі URL прихованого матеріалу недоступні учневі без активного показу",
    s4.files === 404 && s4.slides === 404 && s4.info === 404, JSON.stringify(s4));

  const listNoDemo = await httpStatus(S1, "/api/files");
  const listNoDemoJson = await httpJson(S1, "/api/files");
  const listNoDemoLeak = Array.isArray(listNoDemoJson) && listNoDemoJson.some((f) => f.id === pdfId);
  const listNoDemoHasWav = Array.isArray(listNoDemoJson) && listNoDemoJson.some((f) => f.id === wavId);
  check("Сценарій 4: каталог учня без активного показу відкритий (200), прихованого матеріалу в ньому немає",
    listNoDemo === 200 && listNoDemoHasWav && !listNoDemoLeak,
    JSON.stringify({ status: listNoDemo, hasWav: listNoDemoHasWav, leak: listNoDemoLeak }));

  // Самостійний перегляд: опублікований матеріал відкривається учнем БЕЗ
  // показу викладача, каталог на той самий момент лишається видимим
  await expandAllCategories(S1);
  const s1SelfOpened = await clickFileButton(S1, TEST_MEDIA, "Відкрити");
  const s1SelfMedia = await waitFor(S1,
    `document.getElementById('viewerTitle').textContent.startsWith('Особистий перегляд') && ` +
    mediaExpr("video") + ` && window.__mark === 42`, 15000);
  const s1SelfCatalog = await evaluate(S1,
    `document.getElementById('materialsCatalogPanel').style.display !== 'none' && ` +
    `document.querySelectorAll('#files .file').length > 0 && window.__mark === 42`);
  check("Сценарій 4: учень відкриває опублікований матеріал самостійно, каталог лишається видимим",
    s1SelfOpened && s1SelfMedia && s1SelfCatalog,
    JSON.stringify({ s1SelfOpened, s1SelfMedia, s1SelfCatalog }));

  // ---------------- Сценарій 6: приховати / показати / перемкнути ----------
  // Каталог учня — повноцінний канал перевірки: публікація/приховування
  // оновлюють його БЕЗ перезавантаження, а медіа активного показу лишаються
  // відкритими рівно до моменту перемикання чи зупинки.

  // 6.1 показ опублікованого WAV, потім приховування його ПІД ЧАС показу
  // Нова поведінка (Issue #63 доробка): медіа відкликається негайно (404),
  // екран учнів очищується (state.blocked), картка зникає з каталогу.
  const demoWavClicked = await teacherAction(T, TEST_MEDIA, "Показувати всім");
  const demoWavStarted = await waitDemoFile(wavId, true);
  const wavDuringDemo = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  const s1VideoDuring = await waitFor(S1,
    mediaExpr("video") +
    " && document.getElementById('viewerTitle').textContent.startsWith('Спільна демонстрація')" +
    " && window.__mark === 42", 15000);
  const hideClicked = await teacherAction(T, TEST_MEDIA, "Приховати");
  const teacherStillSees = await waitFor(T,
    `!!(${cardExpr(TEST_MEDIA)}) && (${cardExpr(TEST_MEDIA)}).className.includes('file-is-hidden')`, 8000);
  const wavHiddenDuringDemo = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  // Екран учнів очищується: перевіряємо, що з'явилося повідомлення про недоступність
  const s1ViewerCleared = await waitFor(S1,
    "document.getElementById('sharedBlockedNotice') !== null && window.__mark === 42", 12000);
  // Прихований матеріал зникає з каталогу ОБОХ учнів без перезавантаження
  const s1CardGoneAfterHide = await waitFor(S1, `!(${cardExpr(TEST_MEDIA)}) && window.__mark === 42`, 12000);
  const s2CardGoneAfterHide = await waitFor(S2, `!(${cardExpr(TEST_MEDIA)}) && window.__mark === 42`, 12000);
  check("Сценарій 6: приховування активного матеріалу — медіа відкликано (404), екран очищено, картка з каталогу прибрана",
    demoWavClicked && demoWavStarted && wavDuringDemo === 200 && s1VideoDuring &&
      hideClicked && teacherStillSees && wavHiddenDuringDemo === 404 && s1ViewerCleared &&
      s1CardGoneAfterHide && s2CardGoneAfterHide,
    JSON.stringify({ demoWavStarted, wavDuringDemo, hideClicked, teacherStillSees, wavHiddenDuringDemo, s1ViewerCleared, s1CardGoneAfterHide, s2CardGoneAfterHide }));

  // 6.2 публікація повертає матеріал у КАТАЛОГИ викладача й обох учнів
  //     (без перезавантаження); медіа того самого показу для учня лишаються
  //     відкритими (200): доступ визначає активна демонстрація
  const showClicked = await teacherAction(T, TEST_MEDIA, "Показати");
  const teacherCardBack = await waitFor(T,
    `!!(${cardExpr(TEST_MEDIA)}) && !(${cardExpr(TEST_MEDIA)}).className.includes('file-is-hidden')`, 8000);
  const s1CardBack = await waitFor(S1, `!!(${cardExpr(TEST_MEDIA)}) && window.__mark === 42`, 12000);
  const s2CardBack = await waitFor(S2, `!!(${cardExpr(TEST_MEDIA)}) && window.__mark === 42`, 12000);
  const filesAfterShow = await httpStatus(S1, "/api/files");
  const wavShownToStudent = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  check("Сценарій 6: публікація повертає картку в каталоги обох учнів без перезавантаження, медіа показу лишається (200)",
    showClicked && teacherCardBack && s1CardBack && s2CardBack &&
      filesAfterShow === 200 && wavShownToStudent === 200,
    JSON.stringify({ showClicked, teacherCardBack, s1CardBack, s2CardBack, filesAfterShow, wavShownToStudent }));

  // 6.3 перемикання показу: активний WAV → прихований PDF
  // (сирий /files для PDF учню — 403: лише PNG-слайди, бо саме слайди і є
  // контентом показу для учня; опублікований WAV лишається доступним для
  // самостійного перегляду)
  await teacherAction(T, TEST_HIDDEN, "Показувати всім");
  const demoPdfAgain = await waitDemoFile(pdfId, true);
  const s1FollowedSwitch = await waitFor(S1, mediaExpr("slide") + " && window.__mark === 42", 20000);
  const s2FollowedSwitch = await waitFor(S2, mediaExpr("slide") + " && window.__mark === 42", 20000);
  const pdfSlidesDuringSwitch = await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1");
  const pdfRawDuringSwitch = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  const wavDuringSwitch = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  check("Сценарій 6: перемикання показу — обидва учні на новому матеріалі, його слайди відкриті, сирий файл закритий (403)",
    demoPdfAgain && s1FollowedSwitch && s2FollowedSwitch &&
      pdfSlidesDuringSwitch === 200 && pdfRawDuringSwitch === 403 && wavDuringSwitch === 200,
    JSON.stringify({ demoPdfAgain, s1FollowedSwitch, s2FollowedSwitch, pdfSlidesDuringSwitch, pdfRawDuringSwitch, wavDuringSwitch }));

  // 6.3b друге перемикання (PDF прихований → WAV): доступ до ПРИХОВАНОГО
  //     матеріалу припиняється в момент перемикання, хоча ще мить тому він був
  //     активним показом
  await teacherAction(T, TEST_MEDIA, "Показувати всім");
  const demoWavAgain = await waitDemoFile(wavId, true);
  const pdfSlidesAfterSwitchAway = await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1");
  const pdfInfoAfterSwitchAway = await httpStatus(S1, "/api/slides/info?file=" + encodeURIComponent(pdfId));
  const s1FollowedBack = await waitFor(S1,
    mediaExpr("video") +
    " && document.getElementById('viewerTitle').textContent.startsWith('Спільна демонстрація')" +
    " && window.__mark === 42", 20000);
  check("Сценарій 6: після перемикання показу медіа прихованого матеріалу закриті (404), нового — відкриті",
    demoWavAgain && pdfSlidesAfterSwitchAway === 404 && pdfInfoAfterSwitchAway === 404 && s1FollowedBack,
    JSON.stringify({ demoWavAgain, pdfSlidesAfterSwitchAway, pdfInfoAfterSwitchAway, s1FollowedBack }));

  // 6.4 зупинка показу: медіа прихованого показу недоступні, стан порожній
  await evaluate(T, "document.getElementById('stopDemo').click(); true;");
  const finalStop = await waitDemoFile(wavId, false);
  const pdfAfterStop = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  const slidesAfterStop = await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1");
  check("Сценарій 6: показ зупинено, стан сервера порожній, медіа прихованого закриті",
    finalStop && pdfAfterStop === 404 && slidesAfterStop === 404,
    JSON.stringify({ finalStop, pdfAfterStop, slidesAfterStop }));

  // ---------------- Сценарій 7: тестування під час демонстрації (Issue #83) --
  // Відео-показ: номер сторінки керує ЛИШЕ логікою запитання (парний слайд =
  // питання), сам медіа-контент від номера не залежить — глядачі не бачать
  // хибних 404. Повний цикл: старт → відповіді → автозачинення → повернення →
  // перезавантаження сторінки учня → ручне завершення → збереження результатів.
  const t83HistExpr =
    `[...document.querySelectorAll('#testHistogram .test-hist-row')]` +
    `.map(r => r.querySelector('.test-hist-count').textContent.trim()).join(',')`;
  const t83BarExpr = (visible, count) =>
    `(() => { const b = document.getElementById('testAnswerBar');` +
    ` return !!b && b.style.display ${visible ? "!== 'none'" : "=== 'none'"}` +
    (count ? ` && b.querySelectorAll('.test-answer-btn').length === ${count}` : "") +
    `; })()`;
  const t83SetPage = (page) =>
    fetch(BASE + "/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: PIN, file: wavId, kind: "video", page })
    });

  await t83SetPage(2);
  const t83DemoStarted = await waitDemoFile(wavId, true);

  // 7.1 Панель вчителя: вибір 4 варіантів і старт одним натисканням
  const t83Panel = await waitFor(T,
    `(() => { const p = document.getElementById('testPanel');` +
    ` return !!p && p.offsetParent !== null && !!document.getElementById('testToggleBtn'); })()`, 10000);
  await evaluate(T, `document.getElementById('testOpt4').click(); true;`);
  const t83Opt4 = await waitFor(T,
    `document.getElementById('testOpt4').getAttribute('aria-pressed') === 'true' &&
      document.getElementById('testOpt3').getAttribute('aria-pressed') === 'false'`, 5000);
  await evaluate(T, `document.getElementById('testToggleBtn').click(); true;`);
  const t83Active = await waitFor(T,
    `(() => { const b = document.getElementById('testToggleBtn');` +
    ` return !!b && /Завершити тестування/.test(b.textContent); })()`, 10000);
  const t83Status = await waitFor(T,
    `(() => { const s = document.getElementById('testStatus');` +
    ` return !!s && /Приймання відкрито/.test(s.textContent) && /слайд 2/.test(s.textContent); })()`, 10000);
  check("Сценарій 7: панель вчителя — 4 варіанти вибрано, старт «Тестування» відкриває приймання на слайді 2",
    t83DemoStarted && t83Panel && t83Opt4 && t83Active && t83Status,
    JSON.stringify({ t83DemoStarted, t83Panel, t83Opt4, t83Active, t83Status }));

  // 7.2 Обидва учні бачать 4 кнопки варіантів ПІД глядачем (без перезавантаження)
  const s1Bar = await waitFor(S1, t83BarExpr(true, 4) + " && window.__mark === 42", 10000);
  const s2Bar = await waitFor(S2, t83BarExpr(true, 4) + " && window.__mark === 42", 10000);
  check("Сценарій 7: обидва учні бачать чотири кнопки відповіді під глядачем",
    s1Bar && s2Bar, JSON.stringify({ s1Bar, s2Bar }));

  // 7.3 Перший слайд (вступний) без запитання: кнопки в учнів зникають,
  //     а повернення на парний слайд відкриває приймання знову (без завершення)
  await t83SetPage(1);
  const s1BarFirst = await waitFor(S1,
    t83BarExpr(false) + " && window.__mark === 42", 10000);
  await t83SetPage(2);
  const s1BarReopen = await waitFor(S1,
    t83BarExpr(true, 4) + " && window.__mark === 42", 10000);
  const s2BarReopen = await waitFor(S2,
    t83BarExpr(true, 4) + " && window.__mark === 42", 10000);
  check("Сценарій 7: перший слайд без кнопок, повернення на запитання відкриває приймання знову",
    s1BarFirst && s1BarReopen && s2BarReopen,
    JSON.stringify({ s1BarFirst, s1BarReopen, s2BarReopen }));

  // 7.4 Відповіді з UI: S1 обирає «Б», S2 обирає «В»
  const s1Clicked = await evaluate(S1,
    `(() => { const b = [...document.querySelectorAll('#testAnswerBar .test-answer-btn')]` +
    `.find(x => x.textContent.trim() === 'Б'); if (b) b.click(); return !!b; })()`);
  const s2Clicked = await evaluate(S2,
    `(() => { const b = [...document.querySelectorAll('#testAnswerBar .test-answer-btn')]` +
    `.find(x => x.textContent.trim() === 'В'); if (b) b.click(); return !!b; })()`);
  const s1Selected = await waitFor(S1,
    `(() => { const b = [...document.querySelectorAll('#testAnswerBar .test-answer-btn')]` +
    `.find(x => x.textContent.trim() === 'Б');` +
    ` return !!b && b.classList.contains('is-selected') && b.getAttribute('aria-pressed') === 'true'; })()`,
    10000);
  const s2Selected = await waitFor(S2,
    `(() => { const b = [...document.querySelectorAll('#testAnswerBar .test-answer-btn')]` +
    `.find(x => x.textContent.trim() === 'В');` +
    ` return !!b && b.classList.contains('is-selected'); })()`, 10000);
  check("Сценарій 7: обидва учні відповіли, інтерфейс позначає їхній вибір",
    s1Clicked && s2Clicked && s1Selected && s2Selected,
    JSON.stringify({ s1Clicked, s2Clicked, s1Selected, s2Selected }));

  // 7.5 У викладача в реальному часі (без перезавантаження): гістограма
  //     і обраний варіант біля імені кожного учня
  const t83Hist = await waitFor(T,
    `(() => { const c = ${t83HistExpr};` +
    ` return c === '0,1,1,0'; })()`, 10000);
  const t83Labels = await waitFor(T,
    `(() => { const letters = [...document.querySelectorAll('.student-row')]` +
    `.map(r => (r.querySelector('.student-test-answer') || {}).textContent || '')` +
    `.map(t => t.trim()).filter(Boolean);` +
    ` return letters.includes('Б') && letters.includes('В'); })()`, 10000);
  check("Сценарій 7: вчитель бачить гістограму (0,1,1,0) і вибір кожного учня поруч з ім'ям",
    t83Hist && t83Labels, JSON.stringify({ t83Hist, t83Labels }));
  // Кольорове заповнення смуги: у Б count=1 → ширина > 0 і фон #185ba5
  // (спан inline ігнорував width/height — фікс display:block, доповідь власника)
  const t83Fill = await waitFor(T,
    `(() => { const row = [...document.querySelectorAll('#testHistogram .test-hist-row')]` +
    `.find(r => (r.querySelector('.test-hist-label') || {}).textContent.trim() === 'Б');` +
    ` if (!row) return false; const bar = row.querySelector('.test-hist-bar');` +
    ` if (!bar) return false;` +
    ` return bar.getBoundingClientRect().width > 4 &&` +
    ` getComputedStyle(bar).backgroundColor === 'rgb(24, 91, 165)'; })()`, 10000);
  check("Сценарій 7: гістограма — кольорове заповнення смуги видиме (width>0, фон #185ba5)",
    t83Fill, "t83Fill=" + t83Fill);

  // 7.6 Слайд-відповідь (непарний): приймання зачиняється, у учня на глядачі
  //     видно його вибір (бейдж), гістограма вчителя не змінюється
  await t83SetPage(3);
  const s1BarOdd = await waitFor(S1,
    t83BarExpr(false) + " && window.__mark === 42", 10000);
  const s1Badge = await waitFor(S1,
    `(() => { const v = document.getElementById('viewer');` +
    ` return !!v && v.getAttribute('data-test-answer') === 'Б'; })() && window.__mark === 42`, 10000);
  const t83HistOdd = await waitFor(T, `${t83HistExpr} === '0,1,1,0'`, 10000);
  check("Сценарій 7: на слайді-відповіді кнопки зачинені, вибір видно бейджем, результати збережені",
    s1BarOdd && s1Badge && t83HistOdd,
    JSON.stringify({ s1BarOdd, s1Badge, t83HistOdd }));

  // 7.7 Перезавантаження сторінки учня: вибір відновлюється зі стану сервера
  await t83SetPage(2);
  await gotoS(S2, "/materials");
  const s2Restored = await waitFor(S2,
    `(() => { const b = [...document.querySelectorAll('#testAnswerBar .test-answer-btn')]` +
    `.find(x => x.classList.contains('is-selected'));` +
    ` return !!b && b.textContent.trim() === 'В'; })() && window.__mark === 42`, 20000);
  check("Сценарій 7: після перезавантаження сторінки учень бачить свій збережений вибір",
    s2Restored, "s2Restored=" + s2Restored);

  // 7.8 Ручне завершення вчителем: кнопки в учнів зникають, а в викладача
  //     результати та напис про завершення лишаються
  await evaluate(T, `document.getElementById('testToggleBtn').click(); true;`);
  const t83Finished = await waitFor(T,
    `(() => { const b = document.getElementById('testToggleBtn');` +
    ` return !!b && /Нове тестування/.test(b.textContent); })()`, 10000);
  const t83FinishedStatus = await waitFor(T,
    `/завершено вручну/i.test(document.getElementById('testStatus').textContent) &&
      ${t83HistExpr} === '0,1,1,0'`, 10000);
  const s1BarFinished = await waitFor(S1,
    t83BarExpr(false) + " && window.__mark === 42", 10000);
  check("Сценарій 7: ручне завершення — у викладача статус і результати, в учнів кнопок немає",
    t83Finished && t83FinishedStatus && s1BarFinished,
    JSON.stringify({ t83Finished, t83FinishedStatus, s1BarFinished }));

  // 7.9 Зупинка показу НЕ знищує результати: вказівник запитання «заморожено»
  await evaluate(T, "document.getElementById('stopDemo').click(); true;");
  const t83Stopped = await waitDemoFile(wavId, false);
  const t83AfterStop = await waitFor(T,
    `${t83HistExpr} === '0,1,1,0' &&
      /слайд 2/.test(document.getElementById('testStatus').textContent)`, 10000);
  check("Сценарій 7: після зупинки показу вчитель бачить результати останнього запитання",
    t83Stopped && t83AfterStop, JSON.stringify({ t83Stopped, t83AfterStop }));

  // ---------------- Сценарій 8: автоперегортання «Вперед» (Issue #83) -------
  // Уточнення Tech-lead (коментар 6767853101): блок «Тестування» — окремий
  // самостійний розділ поза блоком «Учні»; панель СТАРТ/СТОП/інтервали/таймер —
  // усередині нього. Реальний цикл 30/15 с (перший перехід миттєвий) + короткі
  // інтервали 1/2 с для чергування, редагування «на льоту» та зупинок.

  // 8.1 Фікстура: 4-сторінковий PDF → PNG-слайди (потрібні 3 переходи «Вперед»)
  const upSlides = await fetch(BASE + "/api/upload?name=" + encodeURIComponent(TEST_SLIDES), {
    method: "POST",
    headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
    body: fourPagePdf()
  });
  const slidesData = upSlides.status === 201 ? await upSlides.json() : {};
  const slideId = slidesData.id || "";
  let slidesReady = false;
  for (let i = 0; i < 60 && !slidesReady; i++) {
    const info = await (await fetch(BASE + "/api/slides/info?file=" + encodeURIComponent(slideId),
      { headers: { "X-Portal-Pin": PIN } })).json();
    if (info && info.ready && info.pageCount >= 4) slidesReady = true;
    else if (info && info.failed) break;
    else await delay(500);
  }
  check("Сценарій 8: 4-сторінковий PDF завантажено й сконвертовано у слайди",
    upSlides.status === 201 && Boolean(slideId) && slidesReady,
    JSON.stringify({ status: upSlides.status, slideId, slidesReady }));

  // 8.2 Показ і структура: блок «Тестування» окремий, панель один раз і на місці.
  // Фікстуру завантажено HTTP-запитом ПОЗА браузером — сторінка викладача про
  // це не знає, тому каталог оновлюємо кнопкою «🔄 Оновити» і чекаємо картку
  const an8Refreshed = await evaluate(T,
    `(() => { const b = document.getElementById('refresh'); if (b) b.click(); return !!b; })()`);
  const an8CardShown = await waitFor(T, `!!(${cardExpr(TEST_SLIDES)})`, 10000);
  const an8DemoClicked = await teacherAction(T, TEST_SLIDES, "Показувати всім");
  const an8DemoStarted = await waitDemoFile(slideId, true);
  const an8SlideShown = await waitFor(T, mediaExpr("slide"), 20000);
  const an8Struct = await evaluate(T, `(() => ({
    testing: !!document.getElementById('testingBlock'),
    standalone: !document.querySelector('#studentsSideBlock #testingBlock') &&
      !document.querySelector('#studentsSideBlock #testPanel'),
    single: document.querySelectorAll('#testingBlock').length === 1 &&
      document.querySelectorAll('#autoNextPanel').length === 1,
    panelVisible: (() => { const el = document.getElementById('testingBlock');
      return !!el && el.getClientRects().length > 0; })(),
    defaults: document.getElementById('autoNextInterval1').value === '30' &&
      document.getElementById('autoNextInterval2').value === '15',
    stopped: document.getElementById('autoNextStatus').textContent.trim() === 'ЗУПИНЕНО' &&
      document.getElementById('autoNextTimer').textContent.trim() === '00:00' &&
      document.getElementById('autoNextStartBtn').disabled === false &&
      document.getElementById('autoNextStopBtn').disabled === true,
    nextAttr: document.getElementById('nextPage').hasAttribute('data-auto-next')
  }))()`);
  const an8StudentHidden = await waitFor(S1,
    `(() => { const el = document.getElementById('testingBlock');` +
    ` return !!el && el.getClientRects().length === 0; })() && window.__mark === 42`, 10000);
  // Клієнт має знати кількість сторінок (demoPageCount = 4) до першого переходу:
  // інакше navigateSlide підіб'є номер сторінки до 1 і «Вперед» нічого не змінить
  const an8PageCount4 = await waitFor(T,
    `typeof demoPageCount !== 'undefined' && demoPageCount >= 4`, 10000);
  check("Сценарій 8: блок «Тестування» окремий від «Учнів», панель один раз, 30/15, ЗУПИНЕНО, data-auto-next, учневі не видно",
    an8Refreshed && an8CardShown && an8DemoClicked && an8DemoStarted && an8SlideShown &&
      an8PageCount4 &&
      an8Struct.testing && an8Struct.standalone && an8Struct.single &&
      an8Struct.panelVisible && an8Struct.defaults && an8Struct.stopped && an8Struct.nextAttr &&
      an8StudentHidden,
    JSON.stringify({ an8Refreshed, an8CardShown, an8DemoClicked, an8DemoStarted, an8SlideShown, an8PageCount4, an8Struct, an8StudentHidden }));

  // 8.3 Лічильник реальних натискань кнопки «Вперед»: обгортка методу click —
  // саме так autoNext.js і викликає кнопку (без координат і емуляції курсора)
  const an8Instrumented = await evaluate(T,
    `(() => { window.__an8Clicks = [];` +
    ` const b = document.getElementById('nextPage');` +
    ` if (!b || b.__an8Wrapped) return false;` +
    ` const orig = b.click;` +
    ` b.click = function () { window.__an8Clicks.push(Date.now()); return orig.apply(this, arguments); };` +
    ` b.__an8Wrapped = true; return true; })()`);
  const an8ClickCount = () => evaluate(T, `(window.__an8Clicks || []).length`);
  const an8ClickTimes = () => evaluate(T, `window.__an8Clicks || []`);
  const waitStatePage = async (page, timeoutMs = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = await apiState();
      if (s.page === page) return true;
      await delay(150);
    }
    return false;
  };

  // 8.4 Реальний цикл 30/15 с: миттєвий перший перехід, потім ~30 с і ~15 с
  await evaluate(T, `document.getElementById('autoNextStartBtn').click(); true;`);
  const an8Immediate = await waitStatePage(2, 6000);
  const an8CountAfterStart = await an8ClickCount();
  // Подвійне натискання СТАРТ під час роботи — без ефекту (захист + disabled)
  await evaluate(T,
    `document.getElementById('autoNextStartBtn').click();` +
    ` document.getElementById('autoNextStartBtn').click(); true;`);
  await delay(1500);
  const an8CountNoDouble = await an8ClickCount();
  const an8StatusRun = await evaluate(T,
    `document.getElementById('autoNextStatus').textContent.trim() === 'ПРАЦЮЄ' &&
     document.getElementById('autoNextStartBtn').disabled === true &&
     document.getElementById('autoNextStopBtn').disabled === false &&
     /^\\d\\d:\\d\\d$/.test(document.getElementById('autoNextTimer').textContent.trim())`);
  check("Сценарій 8: СТАРТ → миттєвий перехід 1→2, ПРАЦЮЄ/таймер, подвійний СТАРТ без ефекту, до 30 с — один перехід",
    an8Instrumented && an8Immediate && an8CountAfterStart === 1 &&
      an8CountNoDouble === 1 && an8StatusRun,
    JSON.stringify({ an8Instrumented, an8Immediate, an8CountAfterStart, an8CountNoDouble, an8StatusRun }));

  const an8Got2 = await waitFor(T, `(window.__an8Clicks || []).length >= 2`, 36000);
  const an8Got3 = await waitFor(T, `(window.__an8Clicks || []).length >= 3`, 22000);
  const an8Times = await an8ClickTimes();
  const an8Gap1 = an8Times.length >= 2 ? an8Times[1] - an8Times[0] : -1;
  const an8Gap2 = an8Times.length >= 3 ? an8Times[2] - an8Times[1] : -1;
  const an8Page4 = await waitStatePage(4, 5000);
  check("Сценарій 8: реальний цикл — другий перехід через ~30 с, третій через ~15 с, сторінки 1→2→3→4",
    an8Got2 && an8Got3 && an8Gap1 >= 29000 && an8Gap1 <= 34000 &&
      an8Gap2 >= 14000 && an8Gap2 <= 19000 && an8Page4,
    JSON.stringify({ an8Got2, an8Got3, an8Gap1, an8Gap2, an8Page4 }));

  // СТОП: 00:00, ЗУПИНЕНО, СТАРТ знову доступний, жодного додаткового переходу
  await evaluate(T, `document.getElementById('autoNextStopBtn').click(); true;`);
  await delay(500);
  const an8CountAtStop = await an8ClickCount();
  await delay(3500);
  const an8CountAfterStop = await an8ClickCount();
  const an8StoppedUi = await evaluate(T,
    `document.getElementById('autoNextStatus').textContent.trim() === 'ЗУПИНЕНО' &&
     document.getElementById('autoNextTimer').textContent.trim() === '00:00' &&
     document.getElementById('autoNextStartBtn').disabled === false &&
     document.getElementById('autoNextStopBtn').disabled === true`);
  check("Сценарій 8: СТОП — 00:00, ЗУПИНЕНО, СТАРТ доступний, додаткових натискань немає",
    an8CountAfterStop === an8CountAtStop && an8StoppedUi,
    JSON.stringify({ an8CountAtStop, an8CountAfterStop, an8StoppedUi }));

  // 8.5 Короткі інтервали: 1/2 с чергуються; зміна інтервалу 1 (1→4 с) під
  // час роботи застосовується до НАСТУПНОГО інтервалу 1, цикл не перезапускається
  await evaluate(T,
    `document.getElementById('autoNextInterval1').value = '1';` +
    ` document.getElementById('autoNextInterval2').value = '2';` +
    ` window.__an8Clicks = []; true;`);
  await evaluate(T, `document.getElementById('autoNextStartBtn').click(); true;`);
  const an8Sgot4 = await waitFor(T, `(window.__an8Clicks || []).length >= 4`, 15000);
  await evaluate(T, `document.getElementById('autoNextInterval1').value = '4'; true;`);
  const an8Sgot6 = await waitFor(T, `(window.__an8Clicks || []).length >= 6`, 14000);
  const an8Stimes = await an8ClickTimes();
  const an8Sg = [];
  for (let i = 1; i < an8Stimes.length && an8Sg.length < 5; i++) an8Sg.push(an8Stimes[i] - an8Stimes[i - 1]);
  check("Сценарій 8: інтервали 1/2 с чергуються; зміна 1→4 с застосовується до наступного інтервалу",
    an8Sgot4 && an8Sgot6 && an8Sg.length >= 5 &&
      an8Sg[0] >= 800 && an8Sg[0] <= 1600 &&
      an8Sg[1] >= 1800 && an8Sg[1] <= 2600 &&
      an8Sg[2] >= 800 && an8Sg[2] <= 1600 &&
      an8Sg[3] >= 1800 && an8Sg[3] <= 2600 &&
      an8Sg[4] >= 3500 && an8Sg[4] <= 5000,
    JSON.stringify({ an8Sgot4, an8Sgot6, an8Sg }));

  // 8.6 Незалежність від блоку «Учні»: ховаємо/повертаємо його під час роботи
  const an8CountBeforeHide = await an8ClickCount();
  await evaluate(T, `document.getElementById('studentsSideBlock').style.display = 'none'; true;`);
  await delay(4000);
  const an8CountAfterHide = await an8ClickCount();
  const an8StillRun = await evaluate(T,
    `document.getElementById('autoNextStatus').textContent.trim() === 'ПРАЦЮЄ' &&
     document.getElementById('testingBlock').getClientRects().length > 0`);
  await evaluate(T, `document.getElementById('studentsSideBlock').style.display = ''; true;`);
  check("Сценарій 8: приховування блоку «Учні» не впливає на автоперегортання",
    an8CountAfterHide > an8CountBeforeHide && an8StillRun,
    JSON.stringify({ an8CountBeforeHide, an8CountAfterHide, an8StillRun }));

  // 8.7 Приховування блоку «Тестування» — негайна безпечна зупинка
  await evaluate(T, `document.getElementById('testingBlock').style.display = 'none'; true;`);
  const an8CloseStopped = await waitFor(T,
    `document.getElementById('autoNextStatus').textContent.trim() === 'ЗУПИНЕНО' &&
     document.getElementById('autoNextTimer').textContent.trim() === '00:00' &&
     /закрито/i.test(document.getElementById('autoNextMessage').textContent)`, 5000);
  const an8CountAtClose = await an8ClickCount();
  await delay(3000);
  const an8CountAfterClose = await an8ClickCount();
  await evaluate(T, `document.getElementById('testingBlock').style.display = ''; true;`);
  check("Сценарій 8: приховування блоку «Тестування» — миттєва зупинка з повідомленням, переходів більше немає",
    an8CloseStopped && an8CountAfterClose === an8CountAtClose,
    JSON.stringify({ an8CloseStopped, an8CountAtClose, an8CountAfterClose }));

  // 8.8 Кнопка «Вперед» недоступна — без натискань, зрозуміле повідомлення
  await evaluate(T,
    `document.getElementById('nextPage').style.display = 'none';` +
    ` window.__an8Clicks = []; true;`);
  await evaluate(T, `document.getElementById('autoNextStartBtn').click(); true;`);
  await delay(2000);
  const an8NoBtn = await evaluate(T,
    `document.getElementById('autoNextStatus').textContent.trim() === 'ЗУПИНЕНО' &&
     /не знайдено або вона недоступна/.test(document.getElementById('autoNextMessage').textContent) &&
     (window.__an8Clicks || []).length === 0 &&
     document.getElementById('autoNextTimer').textContent.trim() === '00:00'`);
  await evaluate(T, `document.getElementById('nextPage').style.display = ''; true;`);
  check("Сценарій 8: без доступної кнопки «Вперед» — жодного натискання, повідомлення й ЗУПИНЕНО",
    an8NoBtn, "an8NoBtn=" + an8NoBtn);

  // 8.9 Перехід на іншу сторінку зупиняє режим; після повернення — свіжий
  // ЗУПИНЕНО. Сторінка за час відсутності вчителя може змінитися ЛИШЕ через
  // наявний механізм Issue #63: pagehide → beacon stop: true → сервер зупиняє
  // показ (file порожній); саме автоперегортання збільшує сторінку і без дії
  // вчителя вже не працює (документ знищено) — підтвердження: воно не росло
  await evaluate(T,
    `document.getElementById('autoNextInterval1').value = '1';` +
    ` document.getElementById('autoNextInterval2').value = '2';` +
    ` window.__an8Clicks = []; true;`);
  await evaluate(T, `document.getElementById('autoNextStartBtn').click(); true;`);
  const an8NavGot2 = await waitFor(T, `(window.__an8Clicks || []).length >= 2`, 8000);
  const an8PageBeforeNav = (await apiState()).page;
  await gotoS(T, "/students");
  await delay(3000);
  const an8AwayState = await apiState();
  await gotoS(T, "/demonstration");
  await waitFor(T, `!!document.getElementById('autoNextPanel')`, 15000);
  const an8AfterNav = await evaluate(T,
    `document.getElementById('autoNextStatus').textContent.trim() === 'ЗУПИНЕНО' &&
     document.getElementById('autoNextTimer').textContent.trim() === '00:00'`);
  // Сторінка не зростала (автоперегортання мовчить): або не змінилася, або
  // показ зупинено beacon'ом виходу вчителя (сторінка при зупинці скидається)
  const an8PageNotAdvanced = an8AwayState.page === an8PageBeforeNav || !an8AwayState.file;
  check("Сценарій 8: перехід на іншу сторінку зупиняє режим, після повернення — ЗУПИНЕНО, сторінка не зростала від автоперегортання",
    an8NavGot2 && an8PageNotAdvanced && an8AfterNav,
    JSON.stringify({ an8NavGot2, an8PageBeforeNav, an8AwayPage: an8AwayState.page, an8AwayFile: an8AwayState.file, an8PageNotAdvanced, an8AfterNav }));

  // 8.10 Ранній клік «Вперед» (уточнення власника 11-11-2026): коли всі
  // ОНЛАЙН-учні відповіли на поточне запитання — перехід не чекає інтервалу;
  // поки відповів лише один — переходу немає. Інтервали 60/60: у вікні тесту
  // інтервал фізично не встигає, тож будь-який перехід раніше за 60 с — лише
  // від раннього кліку. Після 8.9 показ може бути зупинено beacon'ом виходу
  // вчителя — відновлюємо й ставимо на слайд 1; тестування нове (попереднє
  // завершено в 7.8), 4 варіанти вибираємо явно: після перезавантаження
  // сторінки в 8.9 клієнт починає з перемикача за замовчуванням (3).
  const an810SetPage = async (page) => {
    const r = await fetch(BASE + "/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: PIN, file: slideId, kind: "slides", page })
    });
    return r.status;
  };
  const an810Ctl = await an810SetPage(1);
  const an810Demo = await waitDemoFile(slideId, true);
  const an810Page1 = await waitStatePage(1, 5000);
  // Клієнт вчителя має синхронізуватися ДО стартового кліку: sharedState —
  // джерело поточної сторінки для navigateSlide, demoPageCount ≥ 4 — щоб не
  // підібрати номер до 1 (див. коментар про an8PageCount4 вище)
  const an810Synced = await waitFor(T,
    `typeof sharedState !== 'undefined' && sharedState &&
     sharedState.file === ${JSON.stringify(slideId)} && sharedState.page === 1 &&
     typeof demoPageCount !== 'undefined' && demoPageCount >= 4`, 10000);
  await evaluate(T, `document.getElementById('testOpt4').click(); true;`);
  const an810Opt4 = await waitFor(T,
    `document.getElementById('testOpt4').getAttribute('aria-pressed') === 'true'`, 5000);
  await evaluate(T, `document.getElementById('testToggleBtn').click(); true;`);
  const an810Active = await waitFor(T,
    `/Завершити тестування/.test(document.getElementById('testToggleBtn').textContent)`, 10000);
  // Обидва учні онлайн — умова раннього кліку рахує саме онлайн-учнів
  const an810Online = await waitFor(T,
    `typeof lastStudentsList !== 'undefined' &&
     lastStudentsList.filter(s => s && s.online).length >= 2`, 10000);
  await evaluate(T,
    `document.getElementById('autoNextInterval1').value = '60';` +
    ` document.getElementById('autoNextInterval2').value = '60'; true;`);
  await evaluate(T, `document.getElementById('autoNextStartBtn').click(); true;`);
  const an810Start = await waitStatePage(2, 6000); // миттєвий стартовий перехід 1→2
  // Негатив: відповів лише S1 (1 із 2) — хоча б 3 с без переходу
  const an810S1Bar = await waitFor(S1,
    t83BarExpr(true, 4) + " && window.__mark === 42", 10000);
  await evaluate(S1,
    `(() => { const b = [...document.querySelectorAll('#testAnswerBar .test-answer-btn')]` +
    `.find(x => x.textContent.trim() === 'Б'); if (b) b.click(); return !!b; })()`);
  const an810One = await waitFor(T, `${t83HistExpr} === '0,1,0,0'`, 10000);
  await delay(3000);
  const an810Still = (await apiState()).page === 2;
  check("Сценарій 8: ранній клік — відповів один із двох: переходу немає (інтервал 60 с)",
    an810Ctl === 200 && an810Demo && an810Page1 && an810Synced && an810Opt4 &&
      an810Active && an810Online && an810Start && an810S1Bar && an810One && an810Still,
    JSON.stringify({ an810Ctl, an810Demo, an810Page1, an810Synced, an810Opt4,
      an810Active, an810Online, an810Start, an810S1Bar, an810One, an810Still }));
  // Позитив: відповів і S2 — перехід раніше інтервалу 60 с, режим «ПРАЦЮЄ»
  const an810S2Bar = await waitFor(S2,
    t83BarExpr(true, 4) + " && window.__mark === 42", 10000);
  const an810T0 = Date.now();
  await evaluate(S2,
    `(() => { const b = [...document.querySelectorAll('#testAnswerBar .test-answer-btn')]` +
    `.find(x => x.textContent.trim() === 'В'); if (b) b.click(); return !!b; })()`);
  // Прява умова власника: кількість відповідей === кількість онлайн-учнів
  // (hist 0,1,1,0 = Б+В = 2 відповіді, online = 2) — саме в цей момент і спрацьовує клік
  const an810Eq = await waitFor(T,
    `${t83HistExpr} === '0,1,1,0' &&
     (() => { const on = lastStudentsList.filter(s => s && s.online).length;
       const ans = testingState && testingState.answers
         ? Object.keys(testingState.answers).length : -1;
       return on > 0 && on === ans; })()`, 10000);
  const an810Early = await waitStatePage(3, 15000);
  const an810Ms = Date.now() - an810T0;
  const an810Run = await evaluate(T,
    `document.getElementById('autoNextStatus').textContent.trim() === 'ПРАЦЮЄ'`);
  check("Сценарій 8: ранній клік — усі онлайн-учні відповіли (відповідей = онлайн) → перехід раніше інтервалу 60 с",
    an810S2Bar && an810Eq && an810Early && an810Ms < 15000 && an810Run,
    JSON.stringify({ an810S2Bar, an810Eq, an810Early, an810Ms, an810Run }));
  // Прибирання: СТОП і ручне завершення — автоперегортання не лишається
  // «ПРАЦЮЄ», тестування — у статусі finished для подальших сценаріїв
  await evaluate(T, `document.getElementById('autoNextStopBtn').click(); true;`);
  await evaluate(T, `document.getElementById('testToggleBtn').click(); true;`);
  const an810Finished = await waitFor(T,
    `/Нове тестування/.test(document.getElementById('testToggleBtn').textContent)`, 10000);
  check("Сценарій 8: після раннього кліку — СТОП і ручне завершення тестування",
    an810Finished, "an810Finished=" + an810Finished);

  // Прибирання сценарію 8: показ зупинено (файл видаляється у net-zero нижче)
  await evaluate(T, "document.getElementById('stopDemo').click(); true;");
  await waitDemoFile(slideId, false);

  // ============ Issue #88 §4 (браузер): вихід адміністратора ================
  // Підпис біля «Вийти» на всіх сторінках, де є кнопка: адмін лишається
  // «🎓 Адміністратор» (не отримує підпис викладача); HTML-сторінки — без
  // кешування (no-store), щоб після виходу back/reload не показував із кешу
  // захищений вміст
  const ad88Pages = [];
  for (const p of ["/demonstration", "/upload", "/students", "/teachers"]) {
    await gotoS(T, p);
    const labelOk = await waitFor(T,
      `((document.getElementById("roleLabel") || {}).textContent || "").trim() === "🎓 Адміністратор"`, 8000);
    const btnOk = await waitFor(T,
      `((document.getElementById("btnSwitchRole") || {}).textContent || "").includes("Вийти")`, 3000);
    const cc = await httpHeader(T, p, "cache-control");
    ad88Pages.push({ p, labelOk, btnOk, cc });
  }
  check(
    "Issue #88 §4: адмін — «🎓 Адміністратор» і «Вийти» на всіх сторінках із кнопкою; no-store",
    ad88Pages.every((x) => x.labelOk && x.btnOk && String(x.cc || "").includes("no-store")),
    JSON.stringify(ad88Pages)
  );

  // Реальний клік «Вийти»: чекаємо успішного завершення запиту logout (HTTP 200)
  // і переходу САМЕ на головну сторінку `/`. Поспішний редірект не чекає
  // відповіді сервера (раніше робився одразу) — саме це фіксує очікування нижче
  const ad88OldCookie = await getSessionCookie(T);
  // Попередня сторінка історії запам'ятовується ДО виходу: клік «Вийти»
  // робить location.replace("/") (поточний запис стає `/`), тому справжній
  // Back має повернути саме цю сторінку, а не `/`
  const ad88PrevPath = await historyPrevPath(T);
  const ad88StateBefore = await httpStatus(T, "/api/state");
  const ad88TeachersBefore = await httpStatus(T, "/teachers");
  await evaluate(T, "document.getElementById('btnSwitchRole').click(); true;");
  const ad88Redirected = await waitFor(T,
    `location.pathname === "/" &&
      ((document.getElementById("roleLabel") || {}).textContent || "").includes("Учень")`, 15000);
  const ad88LogoutOk = T.logoutStatuses.includes(200);
  check(
    "Issue #88 §4: клік «Вийти» (адмін) → logout HTTP 200, точний URL /, гість",
    ad88Redirected && ad88LogoutOk,
    JSON.stringify({
      path: await evaluate(T, "location.pathname"),
      logoutStatuses: T.logoutStatuses
    })
  );

  // Старий cookie після виходу відхиляється (session видалено на сервері)
  const ad88OldState = await fetch(BASE + "/api/state", {
    headers: { Cookie: "ly_session=" + ad88OldCookie }
  });
  const ad88OldTeachers = await fetch(BASE + "/api/teachers", {
    headers: { Cookie: "ly_session=" + ad88OldCookie }
  });
  const ad88OldTeachersHtml = await fetch(BASE + "/teachers", {
    headers: { Cookie: "ly_session=" + ad88OldCookie }
  });
  check(
    "Issue #88 §4: старий cookie адміністратора відхилено (state/teachers API 401, /teachers 403)",
    ad88OldCookie !== "" && ad88OldState.status === 401 &&
      ad88OldTeachers.status === 401 && ad88OldTeachersHtml.status === 403,
    JSON.stringify({
      state: ad88OldState.status,
      api: ad88OldTeachers.status,
      html: ad88OldTeachersHtml.status
    })
  );

  // Медіа й стан недоступні без входу (без cookie у запиті)
  const afterLogout = await httpStatus(T, "/files/" + encodeURIComponent(pdfId));
  const afterLogoutNoCreds = await httpStatusNoCreds(T, "/api/state");
  check("PIN/URL: після виходу викладача сесію скасовано — медіа й стан недоступні без входу (401)",
    afterLogout === 401 && afterLogoutNoCreds === 401,
    JSON.stringify({ media: afterLogout, state: afterLogoutNoCreds }));

  // підроблена cookie сесії (у викладача після виходу справжньої вже немає):
  // підроблений ідентифікатор не відповідає жодній сесії на сервері
  const forged = await evaluate(T,
    `(() => { document.cookie = "ly_session=" + "ab".repeat(24) + "; path=/";` +
    ` return fetch("/files/" + ${JSON.stringify(encodeURIComponent(pdfId))}, { cache: "no-store" }).then(r => r.status); })()`);
  check("Сценарій 4: підроблена cookie сесії не дає доступу (401)",
    forged === 401, "status=" + forged);

  // СПРАВЖНІЙ Back (history.back()) після виходу — не пряме заходження
  // goto(). Повертаємось на ПОПЕРЄДНЮ сторінку історії (не `/`); оскільки
  // HTML віддається з Cache-Control: no-store, браузер не може відновити
  // «заморожений» знімок із часів адмін-сесії — відбувається реальне
  // перезавантаження, і доступ не відновлюється.
  const ad88BackOk = await goBack(T, ad88PrevPath);
  const ad88BackSafe = ad88PrevPath !== "/" && await waitFor(T,
    `(() => {
      const teacherVisible = [...document.querySelectorAll(".teacher-only")]
        .some((el) => el.style.display !== "none");
      const label = ((document.getElementById("roleLabel") || {}).textContent || "").trim();
      return !teacherVisible && label.includes("Учень");
    })()`, 10000);
  const ad88BackPath = await evaluate(T, "location.pathname");
  const ad88BackState = await httpStatus(T, "/api/state");
  const ad88BackTeachers = await httpStatus(T, "/teachers");
  const ad88BackCache = await httpHeader(T, ad88PrevPath, "cache-control");
  check(
    "Issue #88 §4: справжній Back після виходу адміністратора → попередня URL (не /), лише гість, state 401, /teachers 403, no-store",
    ad88BackOk && ad88BackPath === ad88PrevPath && ad88BackPath !== "/" &&
      ad88BackSafe && ad88StateBefore === 200 && ad88TeachersBefore === 200 &&
      ad88BackState === 401 && ad88BackTeachers === 403 &&
      String(ad88BackCache || "").includes("no-store"),
    JSON.stringify({
      ad88PrevPath, ad88BackOk, ad88BackPath, ad88BackSafe,
      ad88StateBefore, ad88TeachersBefore, ad88BackState, ad88BackTeachers, ad88BackCache
    })
  );
  await cdp(T, "Page.reload", { ignoreCache: true });
  await waitFor(T, "document.readyState === 'complete'", 20000);
  await delay(400);
  const ad88ReloadState = await httpStatus(T, "/api/state");
  const ad88ReloadTeachers = await httpStatus(T, "/teachers");
  const ad88ReloadLabel = await evaluate(T,
    `((document.getElementById("roleLabel") || {}).textContent || "").trim()`);
  check(
    "Issue #88 §4: reload після виходу адміністратора — сесії немає (state 401, /teachers 403), захищений вміст не показується",
    ad88ReloadState === 401 && ad88ReloadTeachers === 403 && ad88ReloadLabel.includes("Учень"),
    JSON.stringify({ ad88ReloadState, ad88ReloadTeachers, ad88ReloadLabel })
  );

  // ============ Issue #88 §4 (браузер): персональний викладач ==============
  // ПІБ «Коваль Олена Петрівна» має відображатися «Коваль О.П.» (без пробілу
  // між ініціалами, join("")), і це має бути реальний текст усіх сторінок із
  // «Вийти»; джерело — серверна сесія/профіль, а не localStorage
  let t2Pin = String(1000 + Math.floor(Math.random() * 9000));
  while (t2Pin === PIN) t2Pin = String(1000 + Math.floor(Math.random() * 9000));
  const t2Create = await (await fetch(BASE + "/api/teachers/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Portal-Pin": PIN },
    body: JSON.stringify({
      fullName: "Коваль Олена Петрівна",
      pin: t2Pin,
      permissions: ["demo", "materials"]
    })
  })).json();
  const t2Id = t2Create && t2Create.teacher ? t2Create.teacher.id : "";
  check("Issue #88 §4: створено викладача «Коваль Олена Петрівна» для браузерного тесту",
    Boolean(t2Id), "id=" + t2Id);

  const T2 = await launchChrome("teacher2");
  await gotoS(T2, "/demonstration");
  const t2In = await loginTeacherWithPin(T2, t2Pin);
  const t2LabelFirst = await waitFor(T2,
    `((document.getElementById("roleLabel") || {}).textContent || "").trim() === "🎓 Коваль О.П."`, 8000);
  check("Issue #88 §4: ПІБ викладача — «🎓 Коваль О.П.» (без пробілу між ініціалами)",
    t2In && t2LabelFirst, "label=" + await evaluate(T2,
      `((document.getElementById("roleLabel") || {}).textContent || "").trim()`));

  const t2Pages = [];
  for (const p of ["/demonstration", "/upload", "/students"]) {
    await gotoS(T2, p);
    const ok = await waitFor(T2,
      `((document.getElementById("roleLabel") || {}).textContent || "").trim() === "🎓 Коваль О.П."`, 8000);
    const btn = await evaluate(T2,
      `((document.getElementById("btnSwitchRole") || {}).textContent || "").trim()`);
    t2Pages.push({ p, ok, btn });
  }
  check(
    "Issue #88 §4: «🎓 Коваль О.П.» і «Вийти» на всіх сторінках викладача",
    t2Pages.every((x) => x.ok && x.btn.includes("Вийти")),
    JSON.stringify(t2Pages)
  );

  // Помилка logout (HTTP 500, CDP-перехоплення): клієнт не «виходить» —
  // без успіху, без редіректу, роль і сторінка лишаються, показується toast;
  // після відновлення зв'язку повтор виходу успішний
  const t2OldCookie = await getSessionCookie(T2);
  await setFetchFail(T2, "api/auth/logout");
  await evaluate(T2, "document.getElementById('btnSwitchRole').click(); true;");
  const t2FailToast = await waitFor(T2,
    `[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Не вдалося завершити сесію"))`, 12000);
  const t2FailState = await evaluate(T2, `(() => ({
    path: location.pathname,
    label: ((document.getElementById("roleLabel") || {}).textContent || "").trim()
  }))()`);
  check(
    "Issue #88 §4: помилка logout (HTTP 500) → без успіху: toast, роль лишається, редіректу немає",
    t2FailToast && t2FailState.path === "/students" && t2FailState.label === "🎓 Коваль О.П.",
    JSON.stringify({ toast: t2FailToast, ...t2FailState })
  );

  await clearFetchFail(T2);
  // Попередня сторінка історії — ДО повторного кліку «Вийти» (помилка logout
  // вище не робила навігації, тож історія лишилася: /students — поточна)
  const t2PrevPath = await historyPrevPath(T2);
  const t2StateBefore = await httpStatus(T2, "/api/state");
  await evaluate(T2, "document.getElementById('btnSwitchRole').click(); true;");
  const t2Redirected = await waitFor(T2,
    `location.pathname === "/" &&
      ((document.getElementById("roleLabel") || {}).textContent || "").includes("Учень")`, 15000);
  const t2LogoutOk = T2.logoutStatuses.includes(200);
  check(
    "Issue #88 §4: повтор виходу після помилки — logout HTTP 200, точний URL /",
    t2Redirected && t2LogoutOk,
    JSON.stringify({
      path: await evaluate(T2, "location.pathname"),
      logoutStatuses: T2.logoutStatuses
    })
  );
  const t2OldState = await fetch(BASE + "/api/state", {
    headers: { Cookie: "ly_session=" + t2OldCookie }
  });
  check("Issue #88 §4: старий cookie викладача після виходу — 401",
    t2OldCookie !== "" && t2OldState.status === 401, "status=" + t2OldState.status);

  // СПРАВЖНІЙ Back (history.back()) після виходу викладача — не пряме
  // заходження goto(): попередня сторінка історії (не `/`), і доступ до
  // захищених ресурсів не відновлюється — ні в самому документі, ні в
  // запитах із cookie браузера
  const t2BackOk = await goBack(T2, t2PrevPath);
  const t2BackSafe = t2PrevPath !== "/" && await waitFor(T2,
    `(() => {
      const teacherVisible = [...document.querySelectorAll(".teacher-only")]
        .some((el) => el.style.display !== "none");
      const label = ((document.getElementById("roleLabel") || {}).textContent || "").trim();
      return !teacherVisible && label.includes("Учень") && !label.includes("Коваль");
    })()`, 10000);
  const t2BackPath = await evaluate(T2, "location.pathname");
  const t2BackState = await httpStatus(T2, "/api/state");
  const t2BackMedia = await httpStatus(T2, "/files/" + encodeURIComponent(pdfId));
  const t2BackCache = await httpHeader(T2, t2PrevPath, "cache-control");
  check(
    "Issue #88 §4: справжній Back після виходу викладача → попередня URL (не /), лише гість, state/медіа 401, no-store",
    t2BackOk && t2BackPath === t2PrevPath && t2BackPath !== "/" &&
      t2BackSafe && t2StateBefore === 200 &&
      t2BackState === 401 && t2BackMedia === 401 &&
      String(t2BackCache || "").includes("no-store"),
    JSON.stringify({
      t2PrevPath, t2BackOk, t2BackPath, t2BackSafe,
      t2StateBefore, t2BackState, t2BackMedia, t2BackCache
    })
  );
  await cdp(T2, "Page.reload", { ignoreCache: true });
  await waitFor(T2, "document.readyState === 'complete'", 20000);
  await delay(400);
  const t2ReloadState = await httpStatus(T2, "/api/state");
  const t2ReloadLabel = await evaluate(T2,
    `((document.getElementById("roleLabel") || {}).textContent || "").trim()`);
  check(
    "Issue #88 §4: reload після виходу викладача — сесії немає (state 401), гість",
    t2ReloadState === 401 && t2ReloadLabel.includes("Учень") && !t2ReloadLabel.includes("Коваль"),
    JSON.stringify({ t2ReloadState, t2ReloadLabel })
  );

  // Прибирання: обліковий запис тестового викладача (net-zero)
  await fetch(BASE + "/api/teachers/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Portal-Pin": PIN },
    body: JSON.stringify({ id: t2Id, confirm: true })
  });

  // ---------------- Помилки консолі ----------------------------------------
  const expectedBlocked = [TEST_MEDIA, TEST_HIDDEN, TEST_SLIDES, wavId, pdfId, slideId].filter(Boolean);
  const errReport = {};
  let errorsOk = true;
  for (const sess of [T, S1, S2, T2]) {
    const unexpectedLog = sess.errors.logErrors.filter((t) =>
      !/favicon/i.test(t) &&
      !expectedBlocked.some((n) => t.includes(encodeURIComponent(n)) || t.includes(n)) &&
      !/ERR_ABORTED/i.test(t) &&
      // Очікувана політика доступу Етап 5 (самі ці відповіді й перевіряємо):
      // 403 для каталогу/категорій поза роллю викладача та 401 для стану після
      // скасування сесії — відповіді сервера, а не помилка клієнта
      !/(401|403)\s*\([^)]*\)\s*https?:\/\/\S+\/api\/(state|files|categories)/.test(t) &&
      // Очікуваний 403 HTML-сторінки /teachers гостю після виходу адміністратора —
      // саме цей статус і перевіряють тести справжнього Back/reload (401/403)
      !/(401|403)\s*\([^)]*\)\s*https?:\/\/\S+\/teachers(?:[/?#\s]|$)/.test(t) &&
      // Очікувана симульована помилка logout (HTTP 500 від CDP-перехоплення
      // в тесті «помилка виходу») — саме цю відповідь тест і перевіряє
      !/\/api\/auth\/logout/.test(t));
    errReport[sess.name] = {
      exceptions: sess.errors.exceptions.length,
      consoleErrors: sess.errors.consoleErrors.length,
      logErrors: unexpectedLog.length,
      sample: unexpectedLog.slice(0, 3)
    };
    if (sess.errors.exceptions.length || sess.errors.consoleErrors.length || unexpectedLog.length) errorsOk = false;
  }
  check("Помилки консолі: JS-винятків і неочікуваних помилок немає у всіх клієнтів", errorsOk,
    JSON.stringify(errReport));

  // ---------------- Прибирання (net-zero) ----------------------------------
  const delWav = await fetch(BASE + "/api/files/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN, file: wavId })
  });
  const delPdf = await fetch(BASE + "/api/files/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN, file: pdfId })
  });
  const delSlides = await fetch(BASE + "/api/files/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN, file: slideId })
  });
  const filesLeft = await apiTeacherFiles();
  check("Тестові файли видалено (net-zero)",
    delWav.status === 200 && delPdf.status === 200 && delSlides.status === 200 &&
      !filesLeft.some((f) => f.id === wavId || f.id === pdfId || f.id === slideId),
    JSON.stringify({ wav: delWav.status, pdf: delPdf.status, slides: delSlides.status }));

  const metaAfterStable = stable(JSON.parse(fs.readFileSync(META_PATH, "utf-8")));
  check("Метадані власника без змін (stable-порівняння до/після)", metaAfterStable === metaBeforeStable);
}

async function cleanupAndReport(exitCode) {
  for (const p of chromes) { try { p.kill(); } catch { /* уже завершився */ } }
  if (server) { try { server.kill(); } catch { /* уже завершився */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* прибираємо профілі */ }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log("");
  console.log(`BROWSER TEST SUMMARY: ${passed} PASS / ${failed} FAIL`);
  for (const r of results.filter((x) => !x.ok)) console.log("  FAILED: " + r.name);
  process.exit(failed > 0 ? 1 : exitCode);
}

process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT: " + ((e && e.stack) || e));
  cleanupAndReport(2);
});
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED: " + ((e && e.stack) || e));
  cleanupAndReport(2);
});

main()
  .then(() => cleanupAndReport(0))
  .catch((e) => {
    console.error("ERROR: " + ((e && e.stack) || e));
    cleanupAndReport(2);
  });
