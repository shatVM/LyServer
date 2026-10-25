/**
 * browser-test.js — автоматизовані браузерні регресійні тести (Issue #63).
 *
 * Запуск:  npm run test:browser      (або: node browser-test.js)
 *
 * Що перевіряє (6 обов'язкових сценаріїв + перевірка передачі PIN), Issue #63,
 * Етап 5 — серверні сесії та обмежений доступ ролей:
 *   Сценарій 0 — у ролі «учень» немає загального каталогу: ні карток у
 *     розмітці, ні /api/files та /api/categories (403 сервером), медіа поза
 *     показом — 404, а без входу взагалі — 401;
 *   Сценарій 1 — викладач демонструє ОПУБЛІКОВАНИЙ матеріал → обидва учні
 *     бачать його медіа (відео) без перезавантаження;
 *   Сценарій 2 — викладач демонструє ПРИХОВАНИЙ матеріал → обидва учні бачать
 *     медіа, але каталог для них і надалі закритий (403), самостійний
 *     перегляд і сирий файл недоступні;
 *   Сценарій 3 — після завершення показу доступ учня до прихованого медіа
 *     припиняється (/files, /slides, /api/slides/info → 404);
 *   Сценарій 4 — довільні прямі URL прихованого матеріалу недоступні учневі
 *     без активного показу;
 *   Сценарій 5 — ДВА незалежні клієнти учнів одночасно отримують медіа показу;
 *   Сценарій 6 — приховування/публікація/перемикання показу: активна
 *     демонстрація для учнів не переривається, медіа попереднього матеріалу
 *     після перемикання закривається;
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
      errors: { consoleErrors: [], exceptions: [], logErrors: [], loadingFailed: [] }
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
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        sess.errors.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        sess.errors.exceptions.push((d.text || "") + " " + (d.exception?.description || ""));
      } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        sess.errors.logErrors.push(msg.params.entry.text + " " + (msg.params.entry.url || ""));
      } else if (msg.method === "Network.loadingFailed") {
        sess.errors.loadingFailed.push(msg.params.errorText + " " + (msg.params.type || ""));
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
// cache: "no-store" — обов'язково: слайди віддаються з Cache-Control: max-age=3600,
// і без вимкнення кешу браузер відповів би 200 з кешу замість нового запиту на
// сервер (перевіряємо саме СЕРВЕРНУ політику доступу, а не локальний кеш)
const httpStatus = (sess, url) =>
  evaluate(sess, `fetch(${JSON.stringify(url)}, { cache: "no-store" }).then(r => r.status)`);
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
  const metaBeforeStable = stable(JSON.parse(fs.readFileSync(META_PATH, "utf-8")));

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
  // Етап 5: робоче місце учня — сторінка демонстрації; загального каталогу
  // в ролі «учень» більше немає ні в API, ні в розмітці
  await gotoS(S1, "/demonstration");
  const s1In = await loginStudent(S1, "Браузер Учень А");
  await gotoS(S2, "/demonstration");
  const s2In = await loginStudent(S2, "Браузер Учень Б");
  check("Входи викладача та двох учнів виконано", tIn && s1In && s2In,
    JSON.stringify({ tIn, s1In, s2In }));

  await waitFor(T, "document.querySelectorAll('#files .file').length > 0", 20000);
  for (const sess of [S1, S2]) {
    // у учнів немає каталогу — чекаємо лише глядач демонстрації
    await waitFor(sess, "!!document.getElementById('viewer') && window.__mark === 42", 15000);
  }

  // ---------------- Сценарій 0: у учнів немає загального каталогу ----------
  const s0 = {};
  s0.cardsS1 = await evaluate(S1, "document.querySelectorAll('#files .file').length");
  s0.cardsS2 = await evaluate(S2, "document.querySelectorAll('#files .file').length");
  s0.files = await httpStatus(S1, "/api/files");
  s0.cats = await httpStatus(S1, "/api/categories");
  s0.state = await httpStatus(S1, "/api/state");
  s0.pubMedia = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  s0.hiddenMedia = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  s0.stateNoCreds = await httpStatusNoCreds(S1, "/api/state");
  s0.mediaNoCreds = await httpStatusNoCreds(S1, "/files/" + encodeURIComponent(wavId));
  check("Сценарій 0: у каталозі учнів порожньо, а API каталогу закритий сервером (403), стан показу — 200",
    s0.cardsS1 === 0 && s0.cardsS2 === 0 && s0.files === 403 && s0.cats === 403 && s0.state === 200,
    JSON.stringify(s0));
  check("Сценарій 0: медіа поза активним показом недоступні (404), без входу — 401",
    s0.pubMedia === 404 && s0.hiddenMedia === 404 && s0.stateNoCreds === 401 && s0.mediaNoCreds === 401,
    JSON.stringify(s0));

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
  const slideDuring = await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1");
  const infoDuring = await httpJson(S1, "/api/slides/info?file=" + encodeURIComponent(pdfId));
  const rawDuring = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  check("Сценарій 2: медіа активної демонстрації відкриті учневі (слайди 200, info ready), каталог закритий (403)",
    slideDuring === 200 && infoDuring && infoDuring.ready === true && listDuring === 403,
    JSON.stringify({ slideDuring, ready: infoDuring && infoDuring.ready, catalog: listDuring }));
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
  check("Сценарій 3: показ завершено, обидва учні вийшли з режиму показу без перезавантаження",
    demoStopped && s1BackToCatalog && s2BackToCatalog,
    JSON.stringify({ demoStopped, s1BackToCatalog, s2BackToCatalog }));

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
  check("Сценарій 4: API каталогу для учня закритий взагалі (403) — ні прихований, ні опублікований",
    listNoDemo === 403, "status=" + listNoDemo);

  // ---------------- Сценарій 6: приховати / показати / перемкнути ----------
  // Етап 5: у учнів немає каталогу, тому їхній канал перевіряємо через медіа
  // АКТИВНОЇ демонстрації та API стану; карткам — лише сторона викладача.

  // 6.1 показ опублікованого WAV, потім приховування його ПІД ЧАС показу
  const demoWavClicked = await teacherAction(T, TEST_MEDIA, "Показувати всім");
  const demoWavStarted = await waitDemoFile(wavId, true);
  const wavDuringDemo = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  const s1VideoDuring = await waitFor(S1, mediaExpr("video") + " && window.__mark === 42", 15000);
  const hideClicked = await teacherAction(T, TEST_MEDIA, "Приховати");
  const teacherStillSees = await waitFor(T,
    `!!(${cardExpr(TEST_MEDIA)}) && (${cardExpr(TEST_MEDIA)}).className.includes('file-is-hidden')`, 8000);
  const wavHiddenDuringDemo = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  const s1VideoAfterHide = await waitFor(S1, mediaExpr("video") + " && window.__mark === 42", 15000);
  check("Сценарій 6: приховування не обриває активну демонстрацію для учнів, у викладача — закритий стан",
    demoWavClicked && demoWavStarted && wavDuringDemo === 200 && s1VideoDuring &&
      hideClicked && teacherStillSees && wavHiddenDuringDemo === 200 && s1VideoAfterHide,
    JSON.stringify({ demoWavStarted, wavDuringDemo, hideClicked, teacherStillSees, wavHiddenDuringDemo }));

  // 6.2 публікація повертає матеріал у КАТАЛОГ ВИКЛАДАЧА; каталог учня — 403,
  //     а медіа того самого показу для учня лишаються відкритими (200): доступ
  //     визначає активна демонстрація, а не прапорець «приховано»
  const showClicked = await teacherAction(T, TEST_MEDIA, "Показати");
  const teacherCardBack = await waitFor(T,
    `!!(${cardExpr(TEST_MEDIA)}) && !(${cardExpr(TEST_MEDIA)}).className.includes('file-is-hidden')`, 8000);
  const filesAfterShow = await httpStatus(S1, "/api/files");
  const wavShownToStudent = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  check("Сценарій 6: публікація — картка повернулася у викладача, каталог учня (403), медіа показу лишається (200)",
    showClicked && teacherCardBack && filesAfterShow === 403 && wavShownToStudent === 200,
    JSON.stringify({ showClicked, teacherCardBack, filesAfterShow, wavShownToStudent }));

  // 6.3 перемикання показу: активний WAV → прихований PDF
  // (сирий /files для PDF учню і надалі 403 — лише PNG-слайди, тому що саме
  // слайди і є контентом показу для учня)
  await teacherAction(T, TEST_HIDDEN, "Показувати всім");
  const demoPdfAgain = await waitDemoFile(pdfId, true);
  const s1FollowedSwitch = await waitFor(S1, mediaExpr("slide") + " && window.__mark === 42", 20000);
  const s2FollowedSwitch = await waitFor(S2, mediaExpr("slide") + " && window.__mark === 42", 20000);
  const pdfSlidesDuringSwitch = await httpStatus(S1, "/slides/" + encodeURIComponent(pdfId) + "/1");
  const pdfRawDuringSwitch = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  const wavAfterSwitch = await httpStatus(S1, "/files/" + encodeURIComponent(wavId));
  check("Сценарій 6: перемикання показу — обидва учні на новому матеріалі, медіа попереднього закрилося",
    demoPdfAgain && s1FollowedSwitch && s2FollowedSwitch &&
      pdfSlidesDuringSwitch === 200 && pdfRawDuringSwitch === 403 && wavAfterSwitch === 404,
    JSON.stringify({ demoPdfAgain, s1FollowedSwitch, s2FollowedSwitch, pdfSlidesDuringSwitch, pdfRawDuringSwitch, wavAfterSwitch }));

  // 6.4 зупинка показу: медіа показу недоступні, стан порожній
  await evaluate(T, "document.getElementById('stopDemo').click(); true;");
  const finalStop = await waitDemoFile(pdfId, false);
  const pdfAfterStop = await httpStatus(S1, "/files/" + encodeURIComponent(pdfId));
  check("Сценарій 6: показ зупинено, стан сервера порожній, медіа закриті",
    finalStop && pdfAfterStop === 404,
    JSON.stringify({ finalStop, pdfAfterStop }));

  // сесія викладача скасовується при виході
  await evaluate(T, "document.getElementById('btnSwitchRole').click(); true;");
  await delay(800);
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

  // ---------------- Помилки консолі ----------------------------------------
  const expectedBlocked = [TEST_MEDIA, TEST_HIDDEN, wavId, pdfId].filter(Boolean);
  const errReport = {};
  let errorsOk = true;
  for (const sess of [T, S1, S2]) {
    const unexpectedLog = sess.errors.logErrors.filter((t) =>
      !/favicon/i.test(t) &&
      !expectedBlocked.some((n) => t.includes(encodeURIComponent(n)) || t.includes(n)) &&
      !/ERR_ABORTED/i.test(t) &&
      // Очікувана політика доступу Етап 5 (самі ці відповіді й перевіряємо):
      // 403 для каталогу/категорій поза роллю викладача та 401 для стану після
      // скасування сесії — відповіді сервера, а не помилка клієнта
      !/(401|403)\s*\([^)]*\)\s*https?:\/\/\S+\/api\/(state|files|categories)/.test(t));
    errReport[sess.name] = {
      exceptions: sess.errors.exceptions.length,
      consoleErrors: sess.errors.consoleErrors.length,
      logErrors: unexpectedLog.length,
      sample: unexpectedLog.slice(0, 3)
    };
    if (sess.errors.exceptions.length || sess.errors.consoleErrors.length || unexpectedLog.length) errorsOk = false;
  }
  check("Помилки консолі: JS-винятків і неочікуваних помилок немає у трьох клієнтів", errorsOk,
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
  const filesLeft = await apiTeacherFiles();
  check("Тестові файли видалено (net-zero)",
    delWav.status === 200 && delPdf.status === 200 &&
      !filesLeft.some((f) => f.id === wavId || f.id === pdfId),
    JSON.stringify({ wav: delWav.status, pdf: delPdf.status }));

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
