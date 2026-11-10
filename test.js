// Автотести LyServer: npm test (запускає окремий екземпляр сервера)
const { spawn } = require("node:child_process");

const PIN = "2468";
const PORT = 3997;
const base = `http://127.0.0.1:${PORT}`;

// Діагностика CI: лог запущеного екземпляра сервера (stdout/stderr/exit)
let SERVER_LOG = "";

// ---------------------------------------------------------------------------
// Issue #63 (Етап 5): сесії входу.
// Контентні endpoint-ів (/api/state, /files, /slides, heartbeat) вимагають
// чинної сесії, тому тести логіняться окремо для кожної інстанції сервера.
// Сесія — HttpOnly cookie `ly_session`, значення — випадковий id на сервері;
// після перезапуску сервера вона стає недійсною (див. restart нижче).
// ---------------------------------------------------------------------------
const sessions = new Map(); // base URL інстанції -> значення ly_session

async function studentLogin(b = base, name = "Тестовий Учень", register = true) {
  const r = await fetch(b + "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  const m = (r.headers.get("set-cookie") || "").match(/ly_session=([^;]+)/);
  const value = m ? m[1] : "";
  // register=false — окремий «другий клієнт»: не замінює основну сесію у map
  if (value && register) sessions.set(b, value);
  return { status: r.status, cookie: value };
}

/** Заголовки учнівської сесії для контентних запитів */
function sess(b = base) {
  const value = sessions.get(b) || "";
  return value ? { Cookie: "ly_session=" + value } : {};
}

/** Заголовки сесії викладача (зберігаємо окремо — вона йде від /auth/verify) */
let teacherSession = "";
function tSess() {
  return teacherSession ? { Cookie: "ly_session=" + teacherSession } : {};
}

function extractSessionCookie(res) {
  const m = (res.headers.get("set-cookie") || "").match(/ly_session=([^;]+)/);
  return m ? m[1] : "";
}

const results = [];
function check(name, ok, info = "") {
  results.push({ Test: name, Result: ok ? "PASS" : "FAIL", Info: info });
  console.log((ok ? "PASS" : "FAIL") + ": " + name + (info ? " | " + info : ""));
}

// Мінімальний валідний PDF (1 сторінка, текст Hello)
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

// Binary body for fetch: send explicit ArrayBuffer (undici versions >= 6 may not accept Buffer bodies)
const TINY_PDF_BODY = new ArrayBuffer(TINY_PDF.length);
new Uint8Array(TINY_PDF_BODY).set(TINY_PDF);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url + "/health");
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await delay(500);
  }
  return false;
}

async function main() {
  // --- Основний екземпляр сервера (перезапуск перевіряємо в кінці, див. Issue #63) ---
  function startServer() {
    const proc = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: String(PORT), PORTAL_PIN: PIN },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", (chunk) => { SERVER_LOG += chunk; });
    proc.stderr.on("data", (chunk) => { SERVER_LOG += chunk; });
    proc.on("exit", (code, signal) => {
      SERVER_LOG += `[server exit] code=${code} signal=${signal}\n`;
    });
    return proc;
  }

  let child = startServer();

  try {
    if (!(await waitForHealth(base))) {
      console.error("Сервер не запустився");
      console.error("SERVER LOG:\n" + SERVER_LOG);
      process.exit(1);
    }

    // 1. Сторінки та здоров'я
    let r = await fetch(base + "/health");
    check("GET /health", r.status === 200 && (await r.json()).status === "ok");

    r = await fetch(base + "/materials");
    const html = await r.text();
    check("GET /materials рендериться", r.status === 200 && html.includes("Перегляд матеріалів"));

    r = await fetch(base + "/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: PIN })
    });
    check("Верифікація PIN викладача", r.status === 200, `status=${r.status}`);
    // Issue #63 (Етап 5): вхід видає серверну сесію (HttpOnly cookie ly_session)
    teacherSession = extractSessionCookie(r);
    check(
      "Вхід викладача видає серверну сесію (ly_session)",
      teacherSession.length >= 32,
      `cookieLen=${teacherSession.length}`
    );

    // Issue #63 (Етап 5): окрема сесія учня для контентних endpoint-ів
    const studentLoginResult = await studentLogin(base, "Коваленко Олена");
    check(
      "Вхід учня видає серверну сесію (ly_session)",
      studentLoginResult.status === 200 && studentLoginResult.cookie.length >= 32,
      `status=${studentLoginResult.status}, cookieLen=${studentLoginResult.cookie.length}`
    );

    // 2. Завантаження PDF викладачем
    r = await fetch(`${base}/api/upload?name=${encodeURIComponent("Тестовий файл.pdf")}`, {
      method: "POST",
      headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
      body: TINY_PDF_BODY
    });
    const upload = await r.json();
    const fileId = upload.id;
    check("Викладач: завантаження PDF запускає фонову конвертацію", r.status === 201 && Boolean(fileId) && upload.conversionStatus === "converting", "status=" + r.status + ", conversion=" + upload.conversionStatus);
    if (!fileId) throw new Error("Не вдалося завантажити тестовий файл");

    // Issue #63 Етап 3: id завантажених тестових файлів для прибирання в finally
    const e3Ids = [];
    let e4CategoryId = "";

    try {
      // 3. Issue #8: конвертація відбувається одразу після завантаження
      // Issue #63 (Етап 5): /api/slides/info потребує сесії або PIN
      let manifest = null;
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, {
          headers: { "X-Portal-Pin": PIN }
        });
        const data = await res.json();
        if (data.ready) {
          manifest = data;
          break;
        }
        await delay(1000);
      }
      check(
        "Issue #8: конвертація у PNG при завантаженні",
        Boolean(manifest && manifest.pageCount >= 1),
        manifest ? `pageCount=${manifest.pageCount}` : "не готово за 60 с"
      );

      // 4. Медіа: без входу — 401; опубліковане відкрите учневі для самостійного
      //    перегляду (через PNG-слайди), сирий PDF/PPTX для не-викладача — 403;
      //    викладач бачить усе, PIN передається заголовком (не URL)
      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`);
      check("Issue #63 (Етап 5): медіа без входу → 401", r.status === 401, `status=${r.status}`);

      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess() });
      check(
        "Issue #63 (доробка): опубліковані слайди відкриті учневі (самостійний перегляд) → 200",
        r.status === 200 && (r.headers.get("cache-control") || "").includes("no-store"),
        `status=${r.status}, cache-control=${r.headers.get("cache-control")}`
      );

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: sess() });
      check(
        "Issue #8: сирий PDF недоступний учневі поза показом (лише PNG-слайди) → 403",
        r.status === 403,
        `status=${r.status}`
      );

      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: { "X-Portal-Pin": PIN } });
      const img = Buffer.from(await r.arrayBuffer());
      const isPng = img.length > 8 && img.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      check("Issue #8: викладач отримує PNG-слайд (PIN у заголовку)", r.status === 200 && isPng, `status=${r.status}`);

      // Issue #63 (аудит PIN): query-параметр ?pin= більше НЕ авторизує нічого —
      // PIN приймається лише з заголовка X-Portal-Pin або з тіла запиту
      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1?pin=${PIN}`);
      check("Issue #63 (аудит PIN): ?pin= у URL не авторизує медіа → 401", r.status === 401, `status=${r.status}`);
      r = await fetch(`${base}/api/state?pin=${PIN}`);
      check("Issue #63 (аудит PIN): ?pin= у URL не авторизує /api/state → 401", r.status === 401, `status=${r.status}`);

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: { "X-Portal-Pin": PIN } });
      check(
        "Викладач: сирий PDF доступний (PIN у заголовку) → 200, Cache-Control: no-store",
        r.status === 200 && (r.headers.get("cache-control") || "").includes("no-store"),
        `status=${r.status}, cache-control=${r.headers.get("cache-control")}`
      );

      // 5. Issue #2: prepare лише для викладача
      r = await fetch(`${base}/api/slides/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: fileId })
      });
      check("Issue #2: prepare без PIN → 403", r.status === 403, `status=${r.status}`);

      r = await fetch(`${base}/api/slides/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Portal-Pin": PIN },
        body: JSON.stringify({ file: fileId })
      });
      check("Issue #2: prepare з PIN → 200", r.status === 200, `status=${r.status}`);

      // 6. Issue #4: прихований файл недоступний учням
      // Issue #63 Етап 4 §2: ревізія /api/state ДО зміни видимості — порівняємо
      // після, щоб показати миттєву синхронізацію через наявний механізм стану
      const s4RevBeforeHide = (await (await fetch(base + "/api/state", { headers: sess() })).json()).revision;
      r = await fetch(`${base}/api/files/toggle-hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, hidden: true })
      });
      check("Викладач: приховування файлу", r.status === 200, `status=${r.status}`);

      // Issue #63 Етап 4 §2 + Етап 5 + доробка: ДВА незалежні клієнти учнів
      // опитують /api/state — обидва бачать нову ревізію. Каталог учня у цей
      // момент ВІДКРИТИЙ, але лише з опублікованим: щойно прихований файл у
      // відповіді не з'являється (сервер фільтрує, а не приховує кнопки в UI)
      const s4StateA = await (await fetch(base + "/api/state", { headers: sess() })).json();
      const s4StateB = await (await fetch(base + "/api/state", { headers: sess() })).json();
      const s4StudentFilesRes = await fetch(base + "/api/files", { headers: sess() });
      const s4StudentCatsRes = await fetch(base + "/api/categories", { headers: sess() });
      const s4StudentFiles = s4StudentFilesRes.status === 200 ? await s4StudentFilesRes.json() : [];
      const s4HiddenLeak = s4StudentFiles.some((f) => f.id === fileId);
      check(
        "Issue #63 Е4/доробка: ревізія росте у двох клієнтів, каталог учня відкритий, але без прихованого",
        s4StateA.revision > s4RevBeforeHide &&
          s4StateB.revision === s4StateA.revision &&
          s4StudentFilesRes.status === 200 &&
          s4StudentCatsRes.status === 200 &&
          !s4HiddenLeak,
        JSON.stringify({ before: s4RevBeforeHide, a: s4StateA.revision, b: s4StateB.revision, files: s4StudentFilesRes.status, cat: s4StudentCatsRes.status, leak: s4HiddenLeak })
      );

      // Issue #63 (Етап 5): загальний каталог недоступний і взагалі без входу
      const noAuthFiles = await fetch(base + "/api/files");
      const noAuthState = await fetch(base + "/api/state");
      check(
        "Issue #63 (Етап 5): без входу каталог → 403, стан демонстрації → 401",
        noAuthFiles.status === 403 && noAuthState.status === 401,
        `files=${noAuthFiles.status}, state=${noAuthState.status}`
      );

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: sess() });
      check("Issue #4: прихований файл закритий для учня (/files)", r.status === 404, `status=${r.status}`);

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`);
      check("Issue #63 (Етап 5): медіа взагалі без входу → 401", r.status === 401, `status=${r.status}`);

      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess() });
      check("Issue #4: приховані слайди закриті для учня (/slides)", r.status === 404, `status=${r.status}`);

      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: { "X-Portal-Pin": PIN } });
      check("Викладач: приховані слайди доступні (PIN у заголовку)", r.status === 200, `status=${r.status}`);

      // Issue #63 Етап 4 §1: приватне прев'ю та спільна демонстрація прихованих
      // матеріалів. У клієнта <img>/<video> авторизуються HttpOnly cookie
      // сесії; у тестах те саме робить заголовок X-Portal-Pin (?pin= у URL
      // більше не підтримується — див. аудит PIN вище)
      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: { "X-Portal-Pin": PIN } });
      check("Issue #63 Е4: викладач відкриває прихований файл (PIN у заголовку)", r.status === 200, `status=${r.status}`);
      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: sess() });
      check("Issue #63 Е4: той самий файл для учня лишається закритим (404)", r.status === 404, `status=${r.status}`);

      // Issue #63 Р + Етап 5: /api/slides/info теж не розкриває прихований файл
      r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: sess() });
      check("Issue #63 Р: прихований файл закритий у /api/slides/info (учень)", r.status === 404, `status=${r.status}`);
      r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: { "X-Portal-Pin": PIN } });
      check(
        "Issue #63 Р: /api/slides/info прихованого файлу з PIN (викладач), no-store",
        r.status === 200 && (r.headers.get("cache-control") || "").includes("no-store"),
        `status=${r.status}, cache-control=${r.headers.get("cache-control")}`
      );

      // Issue #63 (Етап 5): чинна СЕСІЯ учня не авторизує жодної операції
      // керування — сервер вимагає PIN (403), а не прихований кнопку в UI
      const mgmtControl = await fetch(base + "/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ file: fileId, kind: "slides", page: 1, time: 0, playing: false })
      });
      const mgmtUpload = await fetch(base + "/api/upload?name=" + encodeURIComponent("учень-спроба.pdf"), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...sess() },
        body: TINY_PDF_BODY
      });
      const mgmtDelete = await fetch(base + "/api/files/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ file: fileId })
      });
      const mgmtCategories = await fetch(base + "/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ name: "Учнівська категорія" })
      });
      check(
        "Issue #63 (Етап 5): сесія учня не авторизує керування (контроль/завантаження/видалення/категорії → 403)",
        mgmtControl.status === 403 && mgmtUpload.status === 403 &&
          mgmtDelete.status === 403 && mgmtCategories.status === 403,
        JSON.stringify({
          control: mgmtControl.status, upload: mgmtUpload.status,
          del: mgmtDelete.status, cat: mgmtCategories.status
        })
      );

      await fetch(`${base}/api/files/toggle-hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, hidden: false })
      });

      // Issue #63 Етап 4 §2 + доробка: публікація матеріалу піднімає ревізію —
      // обидва клієнти учнів це бачать, і їхній каталог ОНОВЛЮЄТЬСЯ без
      // перезавантаження: опублікований файл з'являється, прихований — ні
      const s4StateShow = await (await fetch(base + "/api/state", { headers: sess() })).json();
      const s4CatShowA = await fetch(base + "/api/files", { headers: sess() });
      const s4CatShowB = await fetch(base + "/api/categories", { headers: sess() });
      const s4ShowListA = s4CatShowA.status === 200 ? await s4CatShowA.json() : [];
      const s4ShowListB = s4CatShowB.status === 200 ? await s4CatShowB.json() : [];
      const s4TeacherList = await (await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();
      const s4HiddenOnly = s4TeacherList.filter((f) => f.hidden).map((f) => f.id);
      check(
        "Issue #63 Е4/доробка: після публікації ревізія зросла і каталог учня містить файл, а приховані — ні",
        s4StateShow.revision > s4StateA.revision &&
          s4CatShowA.status === 200 &&
          s4ShowListA.some((f) => f.id === fileId) &&
          Array.isArray(s4ShowListB) &&
          s4ShowListB.every((c) => c && c.id && c.name) &&
          !s4ShowListA.some((f) => s4HiddenOnly.includes(f.id)),
        JSON.stringify({ hiddenRev: s4StateA.revision, showRev: s4StateShow.revision, studentFiles: s4CatShowA.status, hasFile: s4ShowListA.some((f) => f.id === fileId), hidden: s4HiddenOnly })
      );

      // ---------------------------------------------------------------------
      // Issue #63 (доробка/Етап 5): 1) медіа активної демонстрації прихованого
      // матеріалу для учня (серверна перевірка на кожен запит); 2) вхід обох
      // ролей через серверну сесію (HttpOnly cookie), скасовувану перезапуском.
      // ---------------------------------------------------------------------

      // (а) приховуємо PDF-тестофайл для перевірок доступу
      r = await fetch(`${base}/api/files/toggle-hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, hidden: true })
      });
      check("Issue #63 Д: приховування файлу перед перевірками медіа", r.status === 200, `status=${r.status}`);

      // (б) вхід викладача видає HttpOnly cookie серверної сесії (ly_session)
      r = await fetch(base + "/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN })
      });
      const dSetCookie = r.headers.get("set-cookie") || "";
      const dCookieMatch = dSetCookie.match(/ly_session=([^;]+)/);
      const dCookie = dCookieMatch ? dCookieMatch[1] : "";
      check(
        "Issue #63 (Етап 5): вхід викладача видає HttpOnly SameSite=Strict cookie сесії",
        r.status === 200 && Boolean(dCookie) && /HttpOnly/i.test(dSetCookie) && /SameSite=Strict/i.test(dSetCookie),
        dSetCookie.slice(0, 160) || `status=${r.status}`
      );
      check(
        "Issue #63 (Етап 5): у cookie випадковий id сесії, а не сам PIN",
        Boolean(dCookie) && dCookie !== PIN && dCookie.length >= 32,
        dCookie ? `length=${dCookie.length}` : "cookie відсутня"
      );

      if (dCookie) {
        // (в) сесія викладача відкриває медіа прихованого файлу — без ?pin= у URL
        const dHdr = { Cookie: `ly_session=${dCookie}` };
        r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: dHdr });
        check("Issue #63 Д: сесія викладача відкриває прихований файл (/files)", r.status === 200, `status=${r.status}`);
        r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: dHdr });
        check("Issue #63 Д: сесія викладача відкриває приховані слайди (/slides)", r.status === 200, `status=${r.status}`);
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: dHdr });
        check("Issue #63 Д: сесія викладача працює в /api/slides/info", r.status === 200, `status=${r.status}`);
        // (г) підроблена cookie та cookie без прав керування
        r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: { Cookie: "ly_session=" + "ab".repeat(32) } });
        check("Issue #63 Д: підроблена cookie сесії не дає доступу", r.status === 401, `status=${r.status}`);
        r = await fetch(base + "/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: `ly_session=${dCookie}` },
          body: JSON.stringify({ page: 1 })
        });
        check("Issue #63 Д: сесія НЕ авторизує операції керування (потрібен PIN)", r.status === 403, `status=${r.status}`);
      }

      // (д) ПОКАЗ прихованого PDF: учень бачить медіа, але не каталог
      r = await fetch(base + "/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 1 })
      });
      check("Issue #63 Д: показ прихованого матеріалу запущено", r.status === 200, `status=${r.status}`);

      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess() });
      check("Issue #63 Д: учень отримує слайди прихованого матеріалу під час показу", r.status === 200, `status=${r.status}`);

      // Issue #63 (Етап 5): два НЕЗАЛЕЖНІ клієнти учнів (окремі сесії) одночасно
      // отримують медіа активної демонстрації
      const secondStudent = await studentLogin(base, "Іваненко Петро", false);
      const twoA = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess() });
      const twoB = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: { Cookie: `ly_session=${secondStudent.cookie}` } });
      check(
        "Issue #63 (Етап 5): два клієнти учнів одночасно отримують медіа показу",
        twoA.status === 200 && twoB.status === 200 && twoA.status === twoB.status,
        `a=${twoA.status}, b=${twoB.status}`
      );

      r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: sess() });
      const dInfo = r.status === 200 ? await r.json() : {};
      check(
        "Issue #63 Д: /api/slides/info готовий для учня під час показу прихованого",
        r.status === 200 && dInfo.ready === true,
        `status=${r.status}, ready=${dInfo.ready}`
      );

      // Демонстрація НЕ розкриває каталог: навіть під час показу прихованого
      // матеріалу він не потрапляє у відповідь /api/files учня (лише медіа
      // активного показу, див. mediaAccess)
      const dStudentCatalog = await fetch(base + "/api/files", { headers: sess() });
      const dStudentList = dStudentCatalog.status === 200 ? await dStudentCatalog.json() : [];
      const dStudentLeak = dStudentList.some((f) => f.id === fileId);
      check(
        "Issue #63 (доробка): під час показу каталог учня відкритий, але прихованого матеріалу в ньому немає",
        dStudentCatalog.status === 200 && !dStudentLeak,
        `status=${dStudentCatalog.status}, leak=${dStudentLeak}`
      );

      const dState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #63 Д: стан показу містить оригінальну назву для заголовка учня",
        dState.file === fileId && typeof dState.fileName === "string" && dState.fileName.length > 0,
        JSON.stringify({ file: dState.file, fileName: dState.fileName })
      );

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { headers: sess() });
      check(
        "Issue #63 Д: сирий PDF для учня закритий і під час показу (лише слайди)",
        r.status === 403,
        `status=${r.status}`
      );

      // (е) відео-матеріал: прихований mp4 відкривається учневі ЛИШЕ під час показу
      const dVideoBytes = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x20]),
        Buffer.from("ftypisom"),
        Buffer.alloc(24, 1)
      ]);
      const dVideoBody = new ArrayBuffer(dVideoBytes.length);
      new Uint8Array(dVideoBody).set(dVideoBytes);
      r = await fetch(`${base}/api/upload?name=${encodeURIComponent("Тестове демо-відео.mp4")}`, {
        method: "POST",
        headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
        body: dVideoBody
      });
      const dVideo = await r.json();
      const dVideoId = dVideo.id || "";
      check("Issue #63 Д: завантаження тестового відео для показу", r.status === 201 && Boolean(dVideoId), `status=${r.status}`);
      if (dVideoId) {
        e3Ids.push(dVideoId);
        await fetch(`${base}/api/files/toggle-hide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: dVideoId, hidden: true })
        });

        // Показ відео-матеріалу замість PDF
        r = await fetch(base + "/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: dVideoId, kind: "video", page: 1 })
        });
        check("Issue #63 Д: показ прихованого відео-матеріалу запущено", r.status === 200, `status=${r.status}`);

        r = await fetch(`${base}/files/${encodeURIComponent(dVideoId)}`, { headers: sess() });
        const dVideoBack = Buffer.from(await r.arrayBuffer());
        check(
          "Issue #63 Д: учень отримує медіа відео під час його показу",
          r.status === 200 && dVideoBack.length === dVideoBytes.length,
          `status=${r.status}, len=${dVideoBack.length}`
        );
        r = await fetch(`${base}/files/${encodeURIComponent(dVideoId)}`, { headers: sess() });
        const dVideoAfterSwitch0 = r.status;
        // Перемикання показу на інший матеріал
        await fetch(base + "/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 1 })
        });
        r = await fetch(`${base}/files/${encodeURIComponent(dVideoId)}`, { headers: sess() });
        check(
          "Issue #63 Д: після перемикання показу доступ до попереднього прихованого зникає",
          dVideoAfterSwitch0 === 200 && r.status === 404,
          `before=${dVideoAfterSwitch0}, after=${r.status}`
        );

        // (ж) завершення показу — прихований матеріал знову закритий
        await fetch(base + "/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, stop: true })
        });
        r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess() });
        check(
          "Issue #63 Д: після завершення показу прихований PDF знову закритий",
          r.status === 404,
          `status=${r.status}`
        );
        r = await fetch(`${base}/files/${encodeURIComponent(dVideoId)}`, { headers: sess() });
        check(
          "Issue #63 Д: після завершення показу приховане відео знову закрите",
          r.status === 404,
          `status=${r.status}`
        );
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: sess() });
        check(
          "Issue #63 Д: після завершення показу /api/slides/info теж закритий",
          r.status === 404,
          `status=${r.status}`
        );
      }

      // (з) повертаємо PDF у публікацію для подальших тестів
      await fetch(`${base}/api/files/toggle-hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, hidden: false })
      });

      // 7. Issue #7: присутність і активність сесії
      // Issue #63 (Етап 5): без чинної сесії присутність не реєструється
      r = await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: "s_test_0", name: "Без входу", active: true })
      });
      check("Присутність: heartbeat без сесії → 401", r.status === 401, `status=${r.status}`);

      r = await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ studentId: "s_test_1", name: "Тестовий Учень", active: true })
      });
      check("Присутність: heartbeat активного учня (з сесією)", r.status === 200, `status=${r.status}`);

      r = await fetch(`${base}/api/presence/students`);
      check("Присутність: список без PIN → 403", r.status === 403, `status=${r.status}`);

      let list = await (await fetch(base + "/api/presence/students", { headers: { "X-Portal-Pin": PIN } })).json();
      const active = list.find((s) => s.id === "s_test_1");
      check("Присутність: викладач бачить активного учня", Boolean(active && active.online), JSON.stringify(active));

      // Неактивна сесія через form-data (як navigator.sendBeacon)
      await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...sess() },
        body: new URLSearchParams({ studentId: "s_test_1", name: "Тестовий Учень", active: "false" })
      });
      list = await (await fetch(base + "/api/presence/students", { headers: { "X-Portal-Pin": PIN } })).json();
      const inactive = list.find((s) => s.id === "s_test_1");
      check(
        "Issue #7: неактивна сесія (beacon) → не онлайн",
        Boolean(inactive && !inactive.online),
        JSON.stringify(inactive)
      );

      // 7а. Issue #19: окремий блок списку учнів на сторінках
      // «Демонстрація» та «Перегляд матеріалів»
      const demoHtml = await (await fetch(base + "/demonstration")).text();
      check(
        "Issue #19: блок учнів на /demonstration",
        demoHtml.includes('id="studentsSideBlock"')
      );
      check(
        "Issue #19: блок прихований для учня (teacher-only, display:none)",
        demoHtml.includes("students-side-block teacher-only") &&
          demoHtml.includes('id="studentsSideBlock" style="display:none"')
      );
      check(
        "Issue #19: id блоку унікальний на сторінці",
        (demoHtml.match(/id="studentsSideBlock"/g) || []).length === 1
      );
      // Блоки обміняно місцями: «Учні» тепер праворуч від «Спільного екрана»,
      // панель показу («Запуск показу», id=teacherBroadcastPanel) — нижче.
      // Порівнюємо саме id, щоб не спрацьовувати на текст коментарів.
      check(
        "Issue #19: порядок — «Учні» перед «Запуск показу»",
        demoHtml.indexOf('id="studentsSideBlock"') !== -1 &&
          demoHtml.indexOf('id="studentsSideBlock"') <
            demoHtml.indexOf('id="teacherBroadcastPanel"')
      );

      const matHtml = await (await fetch(base + "/materials")).text();
      check(
        "Issue #19: блок учнів на /materials",
        matHtml.includes('id="studentsSideBlock"')
      );

      // Регресія: сторінка «Учні» працює через ті самі класи
      const stuHtml = await (await fetch(base + "/students")).text();
      check(
        "Issue #19: /students зберігає studentsList і js-класи",
        stuHtml.includes('id="studentsList"') &&
          stuHtml.includes("js-students-list") &&
          stuHtml.includes("js-students-online-count")
      );

      const css = await (await fetch(base + "/css/style.css")).text();
      check("Issue #19: CSS .students-side-block", css.includes(".students-side-block"));

      const jsSrc = await (await fetch(base + "/js/app.js")).text();
      check(
        "Issue #19: renderStudentsList наповнює всі контейнери",
        jsSrc.includes('document.querySelectorAll(".js-students-list")')
      );

      // Формат даних, який очікує renderStudentsList: {id, name, online}
      check(
        "Issue #19: формат даних для блоку (id/name/online)",
        Array.isArray(list) &&
          list.every(
            (s) =>
              typeof s.id === "string" &&
              typeof s.name === "string" &&
              typeof s.online === "boolean"
          ),
        JSON.stringify(list)
      );

      // 7в. Issue #75: IP-адреса учня — визначається СЕРВЕРОМ із контексту
      // запиту; поле `ip` у тілі та заголовок X-Forwarded-For (без trust proxy)
      // мають ігноруватися
      await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({
          studentId: "s_test_ip",
          name: "IP Учень",
          active: true,
          ip: "203.0.113.7"
        })
      });
      await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.99",
          ...sess()
        },
        body: JSON.stringify({ studentId: "s_test_ip", name: "IP Учень", active: true })
      });
      list = await (await fetch(base + "/api/presence/students", { headers: { "X-Portal-Pin": PIN } })).json();
      const ipStudent = list.find((s) => s.id === "s_test_ip");
      check(
        "Issue #75: IP визначає сервер (не тіло запиту, не X-Forwarded-For)",
        Boolean(
          ipStudent &&
            typeof ipStudent.ip === "string" &&
            ipStudent.ip.length > 0 &&
            ipStudent.ip !== "203.0.113.7" &&
            ipStudent.ip !== "203.0.113.99" &&
            !ipStudent.ip.startsWith("::ffff:") &&
            (/^(\d{1,3}\.){3}\d{1,3}$/.test(ipStudent.ip) || /^[0-9a-f:]+$/i.test(ipStudent.ip))
        ),
        JSON.stringify(ipStudent)
      );
      check(
        "Issue #75: у кожного учня у списку є рядок ip",
        Array.isArray(list) && list.every((s) => typeof s.ip === "string"),
        JSON.stringify(list.map((s) => s.ip))
      );
      check(
        "Issue #75: IP-рядок з ім'ям — рендер у JS і CSS",
        jsSrc.includes('class="student-ip"') &&
          jsSrc.includes("student-info") &&
          css.includes(".student-ip") &&
          css.includes(".student-info")
      );
      check(
        "Issue #75: дрібний сірий шрифт IP у CSS",
        /\.student-ip\s*\{[^}]*font-size:\s*12px[^}]*color:\s*#8a94a6/s.test(css)
      );

      // 7д. Issue #75 (доробка за зворотним зв'язком власника): статус — лише
      // крапка відповідного кольору, ім'я та IP в одному рядку, блок вищий
      check(
        "Issue #75 (доробка): статус — лише крапка, слова «Онлайн» у рядку немає",
        jsSrc.includes("status-dot-online") &&
          jsSrc.includes("status-dot-offline") &&
          !jsSrc.includes("● Онлайн") &&
          /\.status-dot-online\s*\{[^}]*background:\s*#2b8a3e/s.test(css) &&
          /\.status-dot-offline\s*\{[^}]*background:\s*#d9480f/s.test(css)
      );
      check(
        "Issue #75 (доробка): ім'я та IP в одному рядку (baseline), блок учнів вищий 70vh",
        /\.student-info\s*\{[^}]*align-items:\s*baseline/s.test(css) &&
          /\.students-side-block\s+\.students-list\s*\{[^}]*max-height:\s*70vh/s.test(css) &&
          /@media \(max-width: 900px\)[\s\S]*?\.students-side-block\s+\.students-list\s*\{[^}]*max-height:\s*none/s.test(css)
      );

      // 7е. Issue #75 (доробка): у блоці «Спільний екран» заголовок, статус і
      // керування в одному рядку; кнопки — іконки без текстових написів.
      // Тексти перевіряються ЛИШЕ в межах рядка заголовка (інші панелі
      // сторінки, наприклад «Матеріали», мають власні написи)
      const demoHeaderHtml = demoHtml.slice(
        demoHtml.indexOf('class="panel-header-row demo-screen-header"'),
        demoHtml.indexOf('id="viewer"')
      );
      check(
        "Issue #75 (доробка): статус і керування в одному рядку навпроти «Спільний екран»",
        demoHtml.includes('class="panel-header-row demo-screen-header"') &&
          demoHtml.indexOf('id="viewerTitle"') < demoHtml.indexOf('id="status"') &&
          demoHtml.indexOf('id="status"') < demoHtml.indexOf('id="teacherDemoControls"') &&
          demoHtml.indexOf('id="teacherDemoControls"') < demoHtml.indexOf('id="viewer"'),
        JSON.stringify({
          header: demoHtml.indexOf('id="viewerTitle"'),
          status: demoHtml.indexOf('id="status"'),
          controls: demoHtml.indexOf('id="teacherDemoControls"'),
          viewer: demoHtml.indexOf('id="viewer"')
        })
      );
      check(
        "Issue #75 (доробка): кнопки керування — іконки без текстових написів, статус у title",
        demoHeaderHtml.length > 0 &&
          !demoHeaderHtml.includes("← Попередня") &&
          !demoHeaderHtml.includes("Наступна сторінка →") &&
          !demoHeaderHtml.includes("⏹ Зупинити") &&
          !demoHeaderHtml.includes("🔄 Оновити") &&
          !demoHeaderHtml.includes("Керування показом") &&
          /<button[^>]*id="prevPage"[^>]*aria-label="Попередня сторінка"/.test(demoHeaderHtml) &&
          /<button[^>]*id="nextPage"[^>]*aria-label="Наступна сторінка"/.test(demoHeaderHtml) &&
          /<button[^>]*id="stopDemo"[^>]*aria-label="Зупинити демонстрацію"/.test(demoHeaderHtml) &&
          /<button[^>]*id="showShared"[^>]*aria-label="Оновити"/.test(demoHeaderHtml) &&
          demoHeaderHtml.includes("/icons.svg#refresh-cw") &&
          demoHeaderHtml.includes("/icons.svg#chevron-left") &&
          demoHeaderHtml.includes("/icons.svg#chevron-right") &&
          demoHeaderHtml.includes("/icons.svg#corner-down-left") &&
          demoHeaderHtml.includes("/icons.svg#square") &&
          css.includes(".icon-btn") &&
          css.includes(".demo-screen-header") &&
          jsSrc.includes('$("status").title = text'),
        demoHeaderHtml.slice(0, 300)
      );

      // 7г. Issue #75: розгорнутий режим спільної демонстрації на пристрої учня
      check(
        "Issue #75: body.demo-focus у JS і CSS (#viewer на весь простір)",
        jsSrc.includes('classList.toggle("demo-focus"') &&
          css.includes("body.demo-focus #viewer") &&
          css.includes("body.demo-focus header")
      );
      check(
        "Issue #75: кнопка системного fullscreen у розмітці та JS",
        demoHtml.includes('id="demoFullscreenBtn"') &&
          jsSrc.includes("setupDemoFullscreenButton") &&
          jsSrc.includes("requestFullscreen")
      );
      check(
        "Issue #75: системний fullscreen лише за жестом, вихід лише нашим",
        jsSrc.includes("demoFullscreenByUs") &&
          jsSrc.includes("document.exitFullscreen()") &&
          jsSrc.includes("Браузер не дозволив повноекранний режим")
      );
      check(
        "Issue #75: режим прив'язаний до серверного стану показу і ролі",
        jsSrc.includes("setDemoFocus(Boolean(state.file))") &&
          jsSrc.includes("setDemoFocus(active)") &&
          jsSrc.includes('role !== "teacher"')
      );

      // 7б. Issue #61: навігація слайдами натисканням на ліву/праву зону зображення
      check(
        "Issue #61: зони створюються в JS і класи збігаються з CSS",
        jsSrc.includes("ensureSlideZones") &&
          jsSrc.includes('"slide-zone slide-zone-" + (side === "prev" ? "left" : "right")') &&
          jsSrc.includes('zone.dataset.side = side') &&
          jsSrc.includes("<polyline") &&
          css.includes(".slide-zone-left") &&
          css.includes(".slide-zone-right")
      );
      check(
        "Issue #61: без текстових підписів — лише SVG у зоні та aria-label",
        jsSrc.includes("zone.innerHTML = ARROW_SVG[side]") &&
          jsSrc.includes('setAttribute("aria-label"')
      );
      check(
        "Issue #61: перемикання через чинні механізми (navigateSlide)",
        jsSrc.includes("function navigateSlide(delta)") &&
          jsSrc.includes("changeSharedPage(delta)") &&
          jsSrc.includes("stepLocalPage(delta)")
      );
      check(
        "Issue #61: на демонстрації спільний слайд змінює лише викладач",
        jsSrc.includes('if (isDemoPage) return role === "teacher"') &&
          jsSrc.includes("if (!onStep && !slideNavAllowed()) return;")
      );
      check(
        "Issue #61: градієнти 15% / 50% і дзеркалість зон",
        css.includes("opacity: 0.15") &&
          css.includes("opacity: 0.5") &&
          css.includes("linear-gradient(to right, rgba(0, 0, 0, 1)") &&
          css.includes("linear-gradient(to left, rgba(0, 0, 0, 1)")
      );
      check(
        "Issue #61: плавність переходів 200–250 мс",
        css.includes("transition: opacity 220ms ease")
      );
      check(
        "Issue #61: початкова підказка до першої взаємодії",
        jsSrc.includes("setSlideNavHint") &&
          jsSrc.includes("nav-hint") &&
          css.includes("#viewer.nav-hint .slide-zone svg")
      );
      check(
        "Issue #61: дотик не блокує прокручування та жести",
        css.includes("touch-action: manipulation") && jsSrc.includes("touchScrolled")
      );
      // Регресія: глобальні button:hover (#144985) і button:active (scale) мають
      // вищу специфікацію за .slide-zone — зони повинні явно скидати ці стилі
      check(
        "Issue #61: зони скидають глобальні стилі button (синій фон/transform)",
        /\.slide-zone\s*\{[^}]*border-radius:\s*0/.test(css) &&
          /\.slide-zone\s*\{[^}]*background:\s*transparent/.test(css) &&
          /\.slide-zone\s*\{[^}]*transition:\s*none/.test(css) &&
          /\.slide-zone:hover,\s*\.slide-zone:active\s*\{[^}]*background:\s*transparent/.test(css) &&
          /\.slide-zone:hover,\s*\.slide-zone:active\s*\{[^}]*transform:\s*none/.test(css)
      );

      // 7в. Issue #63 (Етап 2): каркас блоків на сторінці «Демонстрація» —
      // блок «Додати матеріали» під'єднано до наявного механізму завантаження,
      // панель показу перейменовано на «Матеріали»
      check(
        "Issue #63 Е2: блок «Додати матеріали» на /demonstration",
        demoHtml.includes('id="teacherUploadPanel"') &&
          demoHtml.includes("Додати матеріали")
      );
      check(
        "Issue #63 Е2: блок прихований для учня (teacher-only, display:none)",
        demoHtml.includes("demo-upload-panel teacher-only") &&
          demoHtml.includes('id="teacherUploadPanel" style="display:none"')
      );
      check(
        "Issue #63 Е2: порядок — «Учні» < «Додати матеріали» < «Матеріали»",
        demoHtml.indexOf('id="studentsSideBlock"') !== -1 &&
          demoHtml.indexOf('id="studentsSideBlock"') <
            demoHtml.indexOf('id="teacherUploadPanel"') &&
          demoHtml.indexOf('id="teacherUploadPanel"') !== -1 &&
          demoHtml.indexOf('id="teacherUploadPanel"') <
            demoHtml.indexOf('id="teacherBroadcastPanel"')
      );
      check(
        "Issue #63 Е2: механізм завантаження під'єднано (поле і кнопка)",
        demoHtml.includes('id="uploadFile"') && demoHtml.includes('id="upload"')
      );
      check(
        "Issue #63 Е2: панель показу перейменовано на «Матеріали», без «Запуск показу»",
        demoHtml.includes("<h3>Матеріали</h3>") && !demoHtml.includes("<h3>Запуск показу</h3>")
      );
      check(
        "Issue #63 Е2: статус завантаження окремий від спільного екрана",
        demoHtml.includes('id="uploadStatus"') &&
          jsSrc.includes("function setUploadStatus") &&
          jsSrc.includes('if ($("uploadStatus")) $("uploadStatus").textContent = text;')
      );
      // Виправлення гонки: перший pollState чекає завантаження списку файлів,
      // інакше заголовок/статус демонстрації показують сирий id файлу
      check(
        "Issue #63 Е2: перший pollState чекає завантаження файлів (без гонки)",
        jsSrc.includes("filesReady.finally(() => pollState(true));") &&
          jsSrc.includes("filesReady = refreshFiles();")
      );
      // Регресія: маршрут /upload не видалено; корінь / віддає сторінку
      // самостійного перегляду БЕЗ перенаправлення — Issue #88: після
      // успішного logout фінальна адреса має бути саме `/` (302 на /materials
      // змінював її на клієнті)
      r = await fetch(base + "/upload");
      check("Issue #63 Е2: /upload залишається доступною", r.status === 200, `status=${r.status}`);
      r = await fetch(base + "/", { redirect: "manual" });
      const rootHtml = await r.text();
      check(
        "Issue #63 Е2/Issue #88: корінь / віддає сторінку матеріалів (200, без 302)",
        r.status === 200 && rootHtml.includes('id="files"'),
        `status=${r.status}, location=${r.headers.get("location")}`
      );

      // 7г. Issue #63 (Етап 3): мультизавантаження та необов'язкові описи.
      // Для API-перевірок використовуємо .mp3 (дозволений тип без конвертації
      // у слайди), вміст — той самий тестовий PDF-байтовий буфер
      check(
        "Issue #63 Е3: мультивибір файлів і черга описів на /demonstration",
        demoHtml.includes('id="uploadFile" type="file" multiple') &&
          demoHtml.includes('id="uploadQueue"')
      );
      check(
        "Issue #63 Е3: JS завантажує лише файли з керованої черги",
        jsSrc.includes("const batch = uploadQueueState.slice()") &&
          jsSrc.includes("for (let i = 0; i < batch.length; i++)") &&
          jsSrc.includes('let url = "/api/upload?name=" + encodeURIComponent(item.file.name)')
      );
      check(
        "Issue #63 Е3: опис передається на сервер",
        jsSrc.includes('url += "&description=" + encodeURIComponent(description)')
      );
      check(
        "Issue #63 Е3: підсумок не маскує помилки окремих файлів",
        jsSrc.includes("failures.push") && jsSrc.includes("Не вдалося завантажити")
      );
      check(
        "Issue #63 Е3: опис у картці безпечно вставляється як текст",
        jsSrc.includes('desc.textContent = String(file.description)') &&
          css.includes(".file-desc") && css.includes("-webkit-line-clamp: 2")
      );
      check(
        "Issue #63 Е3: черга зберігає File та описи незалежно від input",
        jsSrc.includes("let uploadQueueState = []") &&
          jsSrc.includes("input.value = \"\"") &&
          jsSrc.includes("item.description = desc.value")
      );
      check(
        "Issue #63 Е3: після помилки файл лишається в черзі для повтору",
        jsSrc.includes('item.status = "error"') &&
          jsSrc.includes("item.error = error") &&
          jsSrc.includes("uploadQueueState = uploadQueueState.filter((queued) => queued.key !== item.key)")
      );
      check(
        "Issue #63 Е3: паралельний запуск завантаження заблоковано",
        jsSrc.includes("if (uploadInProgress) return") &&
          jsSrc.includes("uploadInProgress = true") &&
          jsSrc.includes("uploadInProgress = false")
      );
      check(
        "Issue #63 Е3: конвертація помилку передає виклику та перевіряє маніфест",
        jsSrc.includes("async function prepareSlidesBg(fileId)") &&
          !jsSrc.slice(jsSrc.indexOf("async function prepareSlidesBg(fileId)"), jsSrc.indexOf("// ---------------------------------------------------------------------------", jsSrc.indexOf("async function prepareSlidesBg(fileId)"))).includes("catch") &&
          jsSrc.includes("Сервер не підтвердив готовність PNG-слайдів")
      );
      check(
        "Issue #63 Е3: повний опис доступний через клавіатуру й mobile info",
        jsSrc.includes('desc.tabIndex = 0') &&
          jsSrc.includes('infoButton.setAttribute("aria-expanded"') &&
          css.includes(".file-desc-info") && css.includes("@media (max-width: 600px)")
      );

      // Завантаження з описом
      const e3Desc = "Тестовий опис: конспект уроку";
      r = await fetch(
        `${base}/api/upload?name=${encodeURIComponent("E3 з описом.mp3")}&description=${encodeURIComponent(e3Desc)}`,
        {
          method: "POST",
          headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
          body: TINY_PDF_BODY
        }
      );
      const e3WithDesc = await r.json();
      if (e3WithDesc.id) e3Ids.push(e3WithDesc.id);
      check(
        "Issue #63 Е3: завантаження з описом → 201 і опис у відповіді",
        r.status === 201 && e3WithDesc.description === e3Desc,
        `status=${r.status}, description=${JSON.stringify(e3WithDesc.description)}`
      );

      // Другий файл без опису — запис метаданих у старому форматі (без description)
      r = await fetch(`${base}/api/upload?name=${encodeURIComponent("E3 без опису.mp3")}`, {
        method: "POST",
        headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
        body: TINY_PDF_BODY
      });
      const e3NoDesc = await r.json();
      if (e3NoDesc.id) e3Ids.push(e3NoDesc.id);
      check(
        "Issue #63 Е3: завантаження без опису → 201, опис порожній",
        r.status === 201 && e3NoDesc.description === "",
        `status=${r.status}, description=${JSON.stringify(e3NoDesc.description)}`
      );

      // Старий формат: у метаданих запис без ключа description
      try {
        const metaRaw = require("node:fs").readFileSync(
          require("node:path").join(__dirname, "materials", ".metadata.json"),
          "utf-8"
        );
        const legacyEntry = JSON.parse(metaRaw).files[e3NoDesc.id];
        check(
          "Issue #63 Е3: без опису ключа description у метаданих немає (старий формат)",
          Boolean(legacyEntry) && !("description" in legacyEntry),
          JSON.stringify(legacyEntry)
        );
      } catch (err) {
        check(
          "Issue #63 Е3: без опису ключа description у метаданих немає (старий формат)",
          false,
          err.message
        );
      }

      // Описи читаються з метаданих: викладач бачить опис і порожній опис
      let e3List = await (await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();
      const e3F1 = e3List.find((f) => f.id === e3WithDesc.id);
      const e3F2 = e3List.find((f) => f.id === e3NoDesc.id);
      check(
        "Issue #63 Е3: опис і запис без опису коректно читаються у /api/files",
        Boolean(e3F1 && e3F2) && e3F1.description === e3Desc && e3F2.description === "",
        JSON.stringify({ withDesc: e3F1 && e3F1.description, noDesc: e3F2 && e3F2.description })
      );
      // Issue #63 (доробка): учень бачить ОПУБЛІКОВАНІ матеріали разом з їхніми
      // описами, а приховані не потрапляють у відповідь ніколи (сервер фільтрує);
      // поля order і conversionStatus йому не передаються (див. fileService)
      const e3StudentCat = await fetch(base + "/api/files", { headers: sess() });
      const e3StudentList = e3StudentCat.status === 200 ? await e3StudentCat.json() : [];
      const e3TeacherHiddenIds = e3List.filter((f) => f.hidden).map((f) => f.id);
      check(
        "Issue #63 (доробка): каталог учня відкритий — опубліковані описи є, прихованих немає, полів керування немає",
        e3StudentCat.status === 200 &&
          Boolean(e3F1) && Boolean(e3F2) &&
          e3StudentList.some((f) => f.id === e3F1.id && f.description === e3Desc) &&
          e3StudentList.some((f) => f.id === e3F2.id && f.description === "") &&
          e3StudentList.every((f) => !e3TeacherHiddenIds.includes(f.id)) &&
          e3StudentList.every((f) => !("order" in f) && !("conversionStatus" in f)),
        JSON.stringify({ status: e3StudentCat.status, count: e3StudentList.length, hidden: e3TeacherHiddenIds.length })
      );

      // Наддовгий опис обрізається до config.maxDescriptionLength (500)
      r = await fetch(
        `${base}/api/upload?name=${encodeURIComponent("E3 довгий опис.mp3")}&description=${encodeURIComponent("Х".repeat(600))}`,
        {
          method: "POST",
          headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
          body: TINY_PDF_BODY
        }
      );
      const e3Long = await r.json();
      if (e3Long.id) e3Ids.push(e3Long.id);
      check(
        "Issue #63 Е3: довгий опис обрізано до 500 символів",
        r.status === 201 && typeof e3Long.description === "string" && e3Long.description.length === 500,
        `length=${e3Long.description && e3Long.description.length}`
      );

      // Issue #63 Етап 4: категорії, сумісність метаданих, порядок і права доступу.
      r = await fetch(base + "/api/categories", { headers: { "X-Portal-Pin": PIN } });
      check("Issue #63 Е4: категорії доступні викладачу з PIN", r.status === 200, "status=" + r.status);
      // Issue #63 (Етап 5 + доробка): читання категорій відкрите для чинної
      // сесії (учень отримує лише категорії з видимими йому матеріалами, і лише
      // id/name/order/createdAt); без входу — 403
      r = await fetch(base + "/api/categories", { headers: sess() });
      const e4StudentCats = r.status === 200 ? await r.json() : [];
      check(
        "Issue #63 (доробка): читання категорій відкрите для учня (200, лише видимі категорії)",
        r.status === 200 && Array.isArray(e4StudentCats) &&
          e4StudentCats.every((c) => c && c.id && c.name && !("files" in c) && !("hidden" in c)),
        `status=${r.status}, count=${e4StudentCats.length}`
      );
      r = await fetch(base + "/api/categories");
      check("Issue #63 (Етап 5): читання категорій без входу → 403", r.status === 403, `status=${r.status}`);
      // Зміна категорій залишається за викладачем
      r = await fetch(base + "/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "учнівська спроба створення" })
      });
      check("Issue #63 Р: створення категорії без PIN заборонено", r.status === 403, "status=" + r.status);

      r = await fetch(base + "/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, name: "Е4 тестова категорія" })
      });
      const createdCategoryData = r.status === 201 ? await r.json() : {};
      const e4Category = createdCategoryData.category;
      if (e4Category && e4Category.id) e4CategoryId = e4Category.id;
      check("Issue #63 Е4: створення категорії з PIN", r.status === 201 && Boolean(e4Category && e4Category.id), "status=" + r.status);
      const persistedCategoryMeta = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "materials", ".metadata.json"), "utf-8"));
      check("Issue #63 Е4: категорія збережена у файлі метаданих", Boolean(e4Category && Array.isArray(persistedCategoryMeta.categories) && persistedCategoryMeta.categories.some(category => category.id === e4Category.id)));

      if (e4Category) {
        r = await fetch(base + "/api/upload?name=" + encodeURIComponent("E4 категорія під час завантаження.mp3") + "&categoryId=" + encodeURIComponent(e4Category.id), {
          method: "POST",
          headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
          body: TINY_PDF_BODY
        });
        const e4Uploaded = await r.json();
        if (e4Uploaded.id) e3Ids.push(e4Uploaded.id);
        const uploadedList = await (await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();
        const uploadedCategorized = uploadedList.find(item => item.id === e4Uploaded.id);
        check("Issue #63 Е4: категорію можна вибрати під час завантаження", r.status === 201 && Boolean(uploadedCategorized && uploadedCategorized.categoryId === e4Category.id), "status=" + r.status);
      }

      if (e4Category && e3WithDesc.id && e3NoDesc.id) {
        r = await fetch(base + "/api/files/category", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: e3WithDesc.id, categoryId: e4Category.id })
        });
        check("Issue #63 Е4: матеріал можна перемістити в категорію", r.status === 200, "status=" + r.status);

        r = await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } });
        const teacherCategoryList = await r.json();
        const teacherCategorized = teacherCategoryList.find(item => item.id === e3WithDesc.id);
        check("Issue #63 Е4: категорія присутня у списку викладача", Boolean(teacherCategorized && teacherCategorized.categoryId === e4Category.id));

        r = await fetch(base + "/api/files", { headers: sess() });
        const e4StudentList = r.status === 200 ? await r.json() : [];
        const e4StudentCategorized = e4StudentList.find(item => item.id === e3WithDesc.id);
        // Issue #63 (доробка): учень отримує ОПУБЛІКОВАНИЙ каталог разом із
        // categoryId (потрібен для групування), але без order і conversionStatus
        check(
          "Issue #63 (доробка): каталог учня містить опубліковане з categoryId, але без полів керування",
          r.status === 200 &&
            Boolean(e4StudentCategorized) && e4StudentCategorized.categoryId === e4Category.id &&
            !("order" in e4StudentCategorized) && !("conversionStatus" in e4StudentCategorized),
          `status=${r.status}, categoryId=${e4StudentCategorized && e4StudentCategorized.categoryId}`
        );
        // Матеріали без категорії мають порожній categoryId → «Без категорії»
        // (перевіряємо по обох списках: викладача та опублікованому учня)
        check(
          "Issue #63 Р: у каталозі викладача є й без категорії, й із категорією",
          teacherCategoryList.some(item => item.categoryId === "") &&
            teacherCategoryList.some(item => item.categoryId === e4Category.id),
          `total=${teacherCategoryList.length}`
        );
        // Точний склад каталогу учня = опубліковані + готові матеріали:
        // приховані та неготові слайди виключені сервером
        const e4ExpectedStudentIds = teacherCategoryList
          .filter(item => !item.hidden && (![".pdf", ".ppt", ".pptx"].includes(item.ext) || item.conversionStatus === "ready"))
          .map(item => item.id)
          .sort();
        const e4ActualStudentIds = e4StudentList.map(item => item.id).sort();
        check(
          "Issue #63 (доробка): каталог учня = рівно опубліковані готові матеріали (без прихованих і неготових)",
          JSON.stringify(e4ActualStudentIds) === JSON.stringify(e4ExpectedStudentIds),
          `student=${e4ActualStudentIds.length}, expected=${e4ExpectedStudentIds.length}`
        );

        r = await fetch(base + "/api/files/category", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: e3NoDesc.id, categoryId: e4Category.id })
        });
        check("Issue #63 Е4: другий матеріал переміщено для тесту порядку", r.status === 200, "status=" + r.status);

        r = await fetch(base + "/api/files/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: e3NoDesc.id, direction: "up" })
        });
        const reordered = r.status === 200 ? await r.json() : {};
        const metaPath = require("node:path").join(__dirname, "materials", ".metadata.json");
        const parsedOrderMeta = JSON.parse(require("node:fs").readFileSync(metaPath, "utf-8"));
        check("Issue #63 Е4: порядок матеріалів записується на диск", r.status === 200 && Array.isArray(parsedOrderMeta.order) && parsedOrderMeta.order.indexOf(e3NoDesc.id) < parsedOrderMeta.order.indexOf(e3WithDesc.id), JSON.stringify(reordered.order || []));

        // Issue #63 Р + доробка: порядок викладача зберігається в його каталозі;
        // учень бачить ті самі опубліковані матеріали, але БЕЗ поля order
        // (поле потрібне лише для керування каталогом викладача)
        const teacherOrderList = await (await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();
        const teacherPosNoDesc = teacherOrderList.findIndex(item => item.id === e3NoDesc.id);
        const teacherPosWithDesc = teacherOrderList.findIndex(item => item.id === e3WithDesc.id);
        const studentOrderList = await (await fetch(base + "/api/files", { headers: sess() })).json();
        check(
          "Issue #63 (доробка): порядок — у каталозі викладача; у каталозі учня полів порядку немає",
          teacherPosNoDesc >= 0 && teacherPosWithDesc >= 0 && teacherPosNoDesc < teacherPosWithDesc &&
            studentOrderList.some(item => item.id === e3NoDesc.id) &&
            studentOrderList.every(item => !("order" in item) && !("conversionStatus" in item)),
          JSON.stringify({ order: teacherOrderList.map(item => item.id).slice(0, 6), studentCount: studentOrderList.length })
        );

        const originalPath = require("node:path").join(__dirname, "materials", e3WithDesc.id);
        r = await fetch(base + "/api/categories/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: e4Category.id })
        });
        const deletedCategory = r.status === 200 ? await r.json() : {};
        const postDeleteMeta = JSON.parse(require("node:fs").readFileSync(metaPath, "utf-8"));
        check("Issue #63 Е4: видалення категорії не видаляє файли", r.status === 200 && require("node:fs").existsSync(originalPath) && deletedCategory.affectedFiles >= 1 && !postDeleteMeta.files[e3WithDesc.id].categoryId, "status=" + r.status + ", affected=" + deletedCategory.affectedFiles);
        if (r.status === 200) e4CategoryId = "";
      }

      // ---------------------------------------------------------------------
      // Issue #63 (§3.1/§3.2): керування категоріями і матеріалами на сервері —
      // перейменування, порядок, права доступу, валідація, збереження на диску
      // ---------------------------------------------------------------------
      r = await fetch(base + "/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, name: "Етап4 категорія А" })
      });
      const s4CatA = r.status === 201 ? (await r.json()).category : null;
      r = await fetch(base + "/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, name: "Етап4 категорія Б" })
      });
      const s4CatB = r.status === 201 ? (await r.json()).category : null;
      check(
        "Issue #63 §3.1: дві категорії створено для тестів керування",
        Boolean(s4CatA && s4CatB && s4CatA.id && s4CatB.id)
      );

      if (s4CatA && s4CatB) {
        // Захист: зміни категорій лише викладачем (PIN)
        r = await fetch(base + "/api/categories/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categoryId: s4CatA.id, name: "зламана назва" })
        });
        check("Issue #63 §3.1: перейменування категорії без PIN заборонено", r.status === 403, "status=" + r.status);
        r = await fetch(base + "/api/categories/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categoryId: s4CatA.id, direction: "up" })
        });
        check("Issue #63 §3.1: переміщення категорії без PIN заборонено", r.status === 403, "status=" + r.status);

        // Перейменування: назва змінюється, id і порядок — ні
        r = await fetch(base + "/api/categories/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: s4CatA.id, name: "Етап4 А перейменована" })
        });
        const s4Renamed = r.status === 200 ? await r.json() : {};
        check(
          "Issue #63 §3.1: перейменування категорії з PIN зберігає id і порядок",
          r.status === 200 && Boolean(s4Renamed.category) &&
            s4Renamed.category.name === "Етап4 А перейменована" &&
            s4Renamed.category.id === s4CatA.id && typeof s4Renamed.category.order === "number",
          "status=" + r.status
        );

        // Валідація назв: порожня → 400, дублікат → 409, невідомий id → 404
        r = await fetch(base + "/api/categories/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: s4CatA.id, name: "   " })
        });
        check("Issue #63 §3.1: порожня назва категорії — 400", r.status === 400, "status=" + r.status);
        r = await fetch(base + "/api/categories/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: s4CatA.id, name: "Етап4 категорія Б" })
        });
        check("Issue #63 §3.1: дублікат назви категорії — 409", r.status === 409, "status=" + r.status);
        r = await fetch(base + "/api/categories/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: "missing-category-id", name: "x" })
        });
        check("Issue #63 §3.1: перейменування невідомої категорії — 404", r.status === 404, "status=" + r.status);

        // Порядок: переміщення вгору реально міняє позицію і зберігається на диску
        // (метадані переживають перезапуск сервера — файл читається всіма екземплярами)
        r = await fetch(base + "/api/categories", { headers: { "X-Portal-Pin": PIN } });
        let s4Cats = r.status === 200 ? await r.json() : [];
        const s4PosB = s4Cats.findIndex(category => category.id === s4CatB.id);
        r = await fetch(base + "/api/categories/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: s4CatB.id, direction: "up" })
        });
        const s4Reorder = r.status === 200 ? await r.json() : {};
        s4Cats = await (await fetch(base + "/api/categories", { headers: { "X-Portal-Pin": PIN } })).json();
        const s4NewPosB = s4Cats.findIndex(category => category.id === s4CatB.id);
        const s4MetaPath = require("node:path").join(__dirname, "materials", ".metadata.json");
        const s4DiskMeta = JSON.parse(require("node:fs").readFileSync(s4MetaPath, "utf-8"));
        const s4DiskCat = (s4DiskMeta.categories || []).find(category => category.id === s4CatB.id);
        check(
          "Issue #63 §3.1: порядок категорій змінюється і зберігається на диску",
          r.status === 200 && s4Reorder.moved === true && s4NewPosB === s4PosB - 1 &&
            Boolean(s4DiskCat) && s4DiskCat.order === s4NewPosB,
          JSON.stringify({ s4PosB, s4NewPosB, diskOrder: s4DiskCat && s4DiskCat.order })
        );

        // Межа списку: перший елемент угору — без помилки і без змін (ідемпотентно)
        r = await fetch(base + "/api/categories/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: s4Cats[0].id, direction: "up" })
        });
        const s4Edge = r.status === 200 ? await r.json() : {};
        check(
          "Issue #63 §3.1: переміщення категорії на межі — 200 без змін",
          r.status === 200 && s4Edge.moved === false,
          "status=" + r.status + ", moved=" + s4Edge.moved
        );

        // Напрямок відхиляється
        r = await fetch(base + "/api/categories/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: s4CatB.id, direction: "sideways" })
        });
        check("Issue #63 §3.1: некоректний напрямок — 400", r.status === 400, "status=" + r.status);
      }

      // Перейменування матеріалу: лише показна назва, id і вміст не змінюються
      if (e3NoDesc.id) {
        r = await fetch(base + "/api/files/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: e3NoDesc.id, name: "Назва без PIN" })
        });
        check("Issue #63 §3.2: перейменування матеріалу без PIN заборонено", r.status === 403, "status=" + r.status);

        r = await fetch(base + "/api/files/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: e3NoDesc.id, name: "Етап4 перейменований" })
        });
        const s4RenFile = r.status === 200 ? await r.json() : {};
        const s4TeacherList = await (await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();
        const s4StudentList = await (await fetch(base + "/api/files", { headers: sess() })).json();
        const s4TeacherOne = s4TeacherList.find(item => item.id === e3NoDesc.id);
        const s4StudentOne = s4StudentList.find(item => item.id === e3NoDesc.id);
        check(
          "Issue #63 §3.2 + доробка: назву бачать і викладач, і учень; id та вміст не змінені",
          r.status === 200 && s4RenFile.file === e3NoDesc.id && s4RenFile.name === "Етап4 перейменований" &&
            Boolean(s4TeacherOne) && s4TeacherOne.name === "Етап4 перейменований" &&
            Boolean(s4StudentOne) && s4StudentOne.name === "Етап4 перейменований" &&
            require("node:fs").existsSync(require("node:path").join(__dirname, "materials", e3NoDesc.id)),
          JSON.stringify({ teacher: s4TeacherOne && s4TeacherOne.name, student: s4StudentOne && s4StudentOne.name })
        );

        r = await fetch(base + "/api/files/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: "missing-file-id", name: "x" })
        });
        check("Issue #63 §3.2: перейменування невідомого файлу — 404", r.status === 404, "status=" + r.status);
        r = await fetch(base + "/api/files/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: e3NoDesc.id, name: "  " })
        });
        check("Issue #63 §3.2: порожня назва матеріалу — 400", r.status === 400, "status=" + r.status);
      }

      // Прибирання тестових категорій (матеріали не чіпаємо)
      for (const s4Cat of [s4CatA, s4CatB]) {
        if (!s4Cat) continue;
        await fetch(base + "/api/categories/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: s4Cat.id })
        });
      }

      const apiControllerSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "controllers", "apiController.js"), "utf-8");
      check("Issue #63 Е4: upload запускає фонову конвертацію та фіксує помилку", apiControllerSource.includes("slideService.ensureSlides(result.id)") && apiControllerSource.includes('.then(manifest =>') && apiControllerSource.includes('setConversionStatus(result.id, "failed", conversionError)'));
      const fileServiceSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "services", "fileService.js"), "utf-8");
      check(
        "Issue #63 Р: у списку матеріалів є categoryId, але не порядок і стан конвертації; неготові слайди відфільтровано",
        fileServiceSource.includes('item.conversionStatus === "ready"') &&
          fileServiceSource.includes('conversionStatus === "ready" && !manifestReady') &&
          fileServiceSource.includes('categoryId: categoryIds.has(info.categoryId) ? info.categoryId : ""') &&
          fileServiceSource.includes("{ id, name, ext, size, hidden, description, categoryId }")
      );
      const slideServiceSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "services", "slideService.js"), "utf-8");
      check("Issue #63 Е4: готовність вимагає наявні PNG для кожної сторінки", slideServiceSource.includes("function validateManifest(name, manifest)") && slideServiceSource.includes("Некоректний PNG-слайд"));
      const configSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "config", "index.js"), "utf-8");
      check("Issue #63 Е4: підтримуються .pdf, .ppt і .pptx", configSource.includes('"\.pdf", ".ppt", ".pptx"') && configSource.includes('slideExtensions: new Set([".pdf", ".ppt", ".pptx"])'));
      const iconSprite = require("node:fs").readFileSync(require("node:path").join(__dirname, "public", "icons.svg"), "utf-8");
      const appSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "public", "js", "app.js"), "utf-8");
      check("Issue #63 Е4: іконки категорій локальні та працюють офлайн", iconSprite.includes('id="folder-input"') && iconSprite.includes('id="arrow-up"') && appSource.includes('use.setAttribute("href", "/icons.svg#" + name)'));

      // ---------------------------------------------------------------------
      // Issue #63 Етап 4: приховані матеріали, керування та адаптивний інтерфейс
      // (джерельні маркери поряд із браузерною перевіркою — див. звіт)
      // ---------------------------------------------------------------------
      const s4CssSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "public", "css", "style.css"), "utf-8");
      check(
        "Issue #63 Е4: іконки дій — eye / monitor-play (демонстрація не око) / eye-off / trash-2",
        iconSprite.includes('id="eye"') && iconSprite.includes('id="eye-off"') &&
          iconSprite.includes('id="monitor-play"') && iconSprite.includes('id="trash-2"') &&
          appSource.includes('"monitor-play"') && appSource.includes('"eye"') &&
          appSource.includes('"eye-off"') && appSource.includes('"trash-2"')
      );
      check(
        "Issue #63 Е4: мітку «Приховано» прибрано, кнопки окремим рядком, мобільні — лише іконки",
        !appSource.includes("badge-hidden") &&
          appSource.includes('"btn-label"') &&
          s4CssSource.includes("flex-direction: column") &&
          s4CssSource.includes(".file-actions .btn-label") &&
          s4CssSource.includes("linear-gradient(90deg, rgba(220, 38, 38")
      );
      check(
        "Issue #63 Е4: категорії — один рядок з назвою та еліпсис; модальне прев'ю вписує зображення",
        s4CssSource.includes("flex-wrap:nowrap") &&
          s4CssSource.includes(".category-name") &&
          s4CssSource.includes("text-overflow:ellipsis") &&
          s4CssSource.includes("object-fit: contain")
      );
      check(
        "Issue #63 (доробка): клієнт опитує каталог лише з чинним входом і перечитує його за ревізією",
        appSource.includes("if (!role) return;") &&
          appSource.includes("createStudentSession") &&
          appSource.includes("let lastCatalogRevision = null;") &&
          appSource.includes("if (role !== \"teacher\" && state.revision !== lastCatalogRevision) {") &&
          appSource.includes("if (!firstState) await refreshFiles();") &&
          !appSource.includes("Каталог недоступний. Учні бачать")
      );
      const s4StateServiceSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "services", "stateService.js"), "utf-8");
      check(
        "Issue #63 Е4: сервер піднімає ревізію при зміні видимості (stateService.touch)",
        s4StateServiceSource.includes("touch()") &&
          apiControllerSource.includes("stateService.touch();")
      );
      // ---------------------------------------------------------------------
      // Issue #63 (доробка): медіа-доступ через HttpOnly cookie замість ?pin=
      // у URL і серверний дозвіл медіа АКТИВНОЇ демонстрації прихованого.
      // ---------------------------------------------------------------------
      const s4AuthSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "utils", "auth.js"), "utf-8");
      const s4MediaSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "utils", "mediaAccess.js"), "utf-8");
      const s4FileCtlSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "controllers", "fileController.js"), "utf-8");
      const s4SlideCtlSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "controllers", "slideController.js"), "utf-8");
      const s4RoutesSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "routes", "apiRoutes.js"), "utf-8");
      // Тіло функцій fileUrl/slideUrl (без коментарів вище — шукаємо сам код)
      const s4UrlSlice = appSource.slice(appSource.indexOf("function fileUrl"), appSource.indexOf("function extOf"));
      check(
        "Issue #63 Д: медіа-URL клієнта без ?pin= (PIN не потрапляє в історію та журнали)",
        s4UrlSlice !== "" &&
          !s4UrlSlice.includes('url += "?pin="') &&
          !s4UrlSlice.includes("encodeURIComponent(pin)") &&
          s4UrlSlice.includes('return "/files/" + encodeURIComponent(name);') &&
          s4UrlSlice.includes('return "/slides/" + encodeURIComponent(name) + "/" + page;')
      );
      check(
        "Issue #63 (Етап 5): серверні сесії — видача, скасування, входи обох ролей",
        s4AuthSource.includes("function issueSession") &&
          s4AuthSource.includes("function clearSession") &&
          s4AuthSource.includes("function requireViewer") &&
          s4AuthSource.includes("function mediaIdentity") &&
          s4AuthSource.includes("httpOnly: true") &&
          s4AuthSource.includes("sameSite: \"strict\"") &&
          s4AuthSource.includes("sessionService") &&
          !s4AuthSource.includes("mediaAuthToken") &&
          apiControllerSource.includes('auth.issueSession(req, res, "teacher"') &&
          apiControllerSource.includes('auth.issueSession(req, res, "student"') &&
          s4RoutesSource.includes('"/auth/session"') &&
          s4RoutesSource.includes('"/auth/logout"')
      );
      check(
        "Issue #63 Д: серверний дозвіл медіа активної демонстрації (mediaAccess)",
        s4MediaSource.includes("stateService.isCurrentlyDemonstrated(name)") &&
          s4FileCtlSource.includes("canViewMedia(name, isTeacher, identity.teacherId, identity.isAdmin)") &&
          s4SlideCtlSource.includes("canViewMedia(name, identity.isTeacher, identity.teacherId, identity.isAdmin)") &&
          apiControllerSource.includes("canViewMedia(file, isTeacher, identity.teacherId, identity.isAdmin)") &&
          // Issue #88 (уточнення Tech-lead): адмін позначений окремо,
          // решта ролей лишається під перевіркою власника
          s4AuthSource.includes("isAdmin: sessionIsAdmin") &&
          s4MediaSource.includes("if (isAdmin) return true;")
      );
      check(
        "Issue #63 Д: клієнт відновлює сесію при завантаженні і скасовує її при зміні ролі",
        appSource.includes('fetch("/api/auth/verify"') &&
          appSource.includes('fetch("/api/auth/logout"') &&
          appSource.includes('fetch("/api/auth/session"') &&
          appSource.includes("prevRole && !newRole")
      );
      check(
        "Issue #63 (Етап 5): перезапуск сервера скасовує всі сесії (reset на старті)",
        require("node:fs").readFileSync(require("node:path").join(__dirname, "server.js"), "utf-8")
          .includes("sessionService.reset()")
      );
      check(
        "Issue #63 Д: стан показу має назву та isCurrentlyDemonstrated (автозупинку)",
        s4StateServiceSource.includes("isCurrentlyDemonstrated(name)") &&
          s4StateServiceSource.includes('fileName: ""') &&
          s4StateServiceSource.includes("fileService.getOriginalName(")
      );

      // ---------------------------------------------------------------------
      // Issue #63 (відгук рев'ю): кеш повної перевірки PNG, без витоку
      // діагностики в публічні відповіді та двохрежимна сторінка учня.
      // ---------------------------------------------------------------------

      // 1) Кешування повної перевірки PNG-набору в slideService
      const stateServiceSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "services", "stateService.js"), "utf-8");
      check(
        "Issue #63 Р: кеш перевірки PNG з інвалідацією за mtime джерела/теки/маніфесту",
        slideServiceSource.includes("manifestValidationCache") &&
          slideServiceSource.includes("function validationFingerprint(name)") &&
          slideServiceSource.includes("manifestValidationCache.delete(name)") &&
          slideServiceSource.includes("validateManifestCached(name, existing)") &&
          slideServiceSource.includes("validateManifestCached(name, manifest)")
      );

      // Регресія: повторні запити (навігація слайдами, /api/slides/info)
      // не роблять повну перевірку всіх PNG кожного разу — пошкодження вмісту
      // наявного файлу без зміни набору файлів не помічається (кеш валідний).
      // Без кешу validateManifest помітив би це одразу і відповідь була б не ready.
      // Issue #63 (Етап 5): /api/slides/info потребує сесії або PIN — тут PIN.
      const fsMod = require("node:fs");
      const pageOnePath = require("node:path").join(__dirname, "materials", ".slides", fileId, "page-1.png");
      try {
        const originalPng = fsMod.readFileSync(pageOnePath);
        fsMod.writeFileSync(pageOnePath, Buffer.from("не PNG, а тестове сміття"));
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: { "X-Portal-Pin": PIN } });
        let cacheInfo = await r.json();
        check(
          "Issue #63 Р: навігація/info не сканує весь набір повторно (кеш)",
          r.status === 200 && cacheInfo.ready === true,
          `status=${r.status}, ready=${cacheInfo.ready}`
        );

        // Зміна набору файлів (видалення PNG) інвалідовує кеш → не готово
        fsMod.unlinkSync(pageOnePath);
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: { "X-Portal-Pin": PIN } });
        cacheInfo = r.status === 200 ? await r.json() : { ready: false };
        check(
          "Issue #63 Р: видалення PNG інвалідовує кеш перевірки",
          cacheInfo.ready === false,
          `status=${r.status}, ready=${cacheInfo.ready}`
        );

        // Відновлення файлу (зміна набору) — повна перевірка знову підтверджує готовність
        fsMod.writeFileSync(pageOnePath, originalPng);
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: { "X-Portal-Pin": PIN } });
        cacheInfo = await r.json();
        check(
          "Issue #63 Р: відновлення PNG повертає готовність набору",
          r.status === 200 && cacheInfo.ready === true && cacheInfo.pageCount >= 1,
          `status=${r.status}, ready=${cacheInfo.ready}, pageCount=${cacheInfo.pageCount}`
        );
      } catch (cacheErr) {
        check("Issue #63 Р: кеш перевірки PNG (збій підготовки тесту)", false, cacheErr.message);
      }

      // 2) Витік діагностики: учень не бачить conversionError та внутрішніх подробиць
      r = await fetch(`${base}/api/upload?name=${encodeURIComponent("E5 пошкоджений.pdf")}`, {
        method: "POST",
        headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
        body: Buffer.from("Це не PDF, а тестовий вміст для помилки конвертації слайдів.")
      });
      const e5Upload = r.status === 201 ? await r.json() : {};
      const e5Id = e5Upload.id;
      if (e5Id) e3Ids.push(e5Id);
      check("Issue #63 Р: завантаження пошкодженого PDF для тесту конвертації", Boolean(e5Id), `status=${r.status}`);

      let e5Failed = false;
      let e5TeacherInfo = null;
      if (e5Id) {
        for (let i = 0; i < 30; i++) {
          r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(e5Id)}`, { headers: { "X-Portal-Pin": PIN } });
          e5TeacherInfo = await r.json();
          if (e5TeacherInfo.failed) {
            e5Failed = true;
            break;
          }
          await delay(1000);
        }
        check(
          "Issue #63 Р: невдала конвертація фіксується як failed",
          e5Failed,
          JSON.stringify(e5TeacherInfo)
        );
      }

      if (e5Failed) {
        // Опублікований, але неготовий матеріал: учень дізнається ЛИШЕ факт
        // неготовності — без conversionError, локальних шляхів і подробиць
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(e5Id)}`, { headers: sess() });
        const e5StudentRaw = await r.text();
        let e5StudentInfo = {};
        try {
          e5StudentInfo = JSON.parse(e5StudentRaw);
        } catch {
          e5StudentInfo = {};
        }
        check(
          "Issue #63 (доробка): /api/slides/info неготового опублікованого → 200 лише з фактом, без подробиць",
          r.status === 200 && e5StudentInfo.ready === false && e5StudentInfo.failed === true &&
            !("error" in e5StudentInfo) && !("conversionError" in e5StudentInfo) &&
            !e5StudentRaw.includes(e5TeacherInfo.error),
          `status=${r.status}, body=${e5StudentRaw}`
        );
        check(
          "Issue #63 Р: відповідь без локальних шляхів і внутрішніх подробиць",
          !e5StudentRaw.includes("materials") && !e5StudentRaw.includes(".slides") &&
            !e5StudentRaw.includes("powershell") && !e5StudentRaw.toLowerCase().includes("stdout") &&
            !e5StudentRaw.includes("at ") && !e5StudentRaw.includes("Error:"),
          e5StudentRaw
        );
        // Захищений діагностичний шлях: викладач із PIN отримує деталі
        check(
          "Issue #63 Р: викладач із PIN отримує деталі помилки конвертації",
          typeof e5TeacherInfo.error === "string" && e5TeacherInfo.error.length > 0,
          e5TeacherInfo.error
        );

        // Неготовий матеріал не потрапляє у ВІДКРИТИЙ каталог учня
        r = await fetch(base + "/api/files", { headers: sess() });
        const e5StudentList = r.status === 200 ? await r.json() : [];
        const e5StudentLeak = e5StudentList.some((f) => f.id === e5Id);
        check(
          "Issue #63 (доробка): неготовий матеріал відсутній у відкритому каталозі учня (200 без нього)",
          r.status === 200 && !e5StudentLeak,
          `status=${r.status}, leak=${e5StudentLeak}`
        );
        // Захищений шлях: викладач бачить стан і причину помилки
        r = await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } });
        const e5TeacherList = await r.json();
        const e5TeacherFile = e5TeacherList.find((f) => f.id === e5Id);
        check(
          "Issue #63 Р: викладач бачить стан конвертації та причину",
          Boolean(e5TeacherFile) && e5TeacherFile.conversionStatus === "failed" &&
            typeof e5TeacherFile.conversionError === "string" && e5TeacherFile.conversionError.length > 0,
          JSON.stringify(e5TeacherFile && { status: e5TeacherFile.conversionStatus, error: e5TeacherFile.conversionError })
        );
      }

      // 3) Одна сторінка учня з двома режимами за серверним станом демонстрації
      check(
        "Issue #63 Р: сторінка учня має контейнер каталогу для двох режимів",
        matHtml.includes('id="materialsCatalogPanel"')
      );
      check(
        "Issue #63 Р: демонстрація у навігації лише для викладача (одна сторінка учня)",
        matHtml.includes('class="nav-link teacher-only') && matHtml.includes('href="/demonstration"')
      );
      check(
        "Issue #63 Р: JS перемикає режими за серверним станом без перезавантаження",
        jsSrc.includes("function setMaterialsDemoMode(active, state = {})") &&
          jsSrc.includes("Boolean(state.file) !== materialsDemoActive") &&
          jsSrc.includes("function restoreLocalViewer()") &&
          jsSrc.includes("if (isMaterialsPage && materialsDemoActive) return;") &&
          jsSrc.includes("if (isMaterialsPage && role === \"teacher\") return;")
      );
      // Акордеон: спільний групувальник каталогу, кнопка-заголовок з
      // aria-expanded/aria-controls, незалежне згортання за id категорії.
      // Початковий стан — усі категорії згорнуті (§2.3): порожня множина
      // expandedCategoryIds. Доповнює поведінкові HTTP-тести; роботу DOM
      // перевіряє окрема браузерна перевірка.
      check(
        "Issue #63 Р: акордеон категорій у джерелі клієнта та стилях",
        jsSrc.includes("const expandedCategoryIds = new Set();") &&
          jsSrc.includes("function renderCategoryGroups(root)") &&
          jsSrc.includes("toggle.setAttribute(\"aria-controls\", bodyId)") &&
          jsSrc.includes("if (isMaterialsPage || (isDemoPage && isTeacher))") &&
          css.includes(".category-toggle") && css.includes(".category-body[hidden]")
      );
      // Issue #63 (§3): керування на сторінці «Демонстрація» — категорії
      // (перейменування/порядок/видалення/створення) і матеріали (приватне
      // прев'ю, видимість, перейменування, видалення) + об'єднання навігації
      check(
        "Issue #63 §3: керування категоріями та матеріалами в джерелі клієнта",
        jsSrc.includes("function renameCategory(category)") &&
          jsSrc.includes("function reorderCategory(category, direction)") &&
          jsSrc.includes("function renameMaterial(fileId, currentName)") &&
          jsSrc.includes("bar.className = \"category-actions\"") &&
          // Етап 4: обробник тепер передається через спільний хелпер кнопок
          jsSrc.includes("() => deleteCategory(group.category)") &&
          demoHtml.includes('id="createCategoryBtn"')
      );
      check(
        "Issue #63 §3.3: модальне приватне прев'ю в джерелі клієнта та розмітці",
        demoHtml.includes('id="previewModal"') &&
          demoHtml.includes('role="dialog"') &&
          demoHtml.includes('aria-modal="true"') &&
          jsSrc.includes("function openPreviewModal(fileId, invoker)") &&
          jsSrc.includes("function closePreviewModal()") &&
          jsSrc.includes("if (e.key === \"Escape\")") &&
          jsSrc.includes("previewInvoker.focus()") &&
          css.includes(".preview-backdrop") &&
          css.includes(".preview-viewer")
      );
      // Приватний перегляд не пише спільний стан: жодного виклику /api/control
      // у коді прев'ю (перевіряється також поведінково в браузері)
      check(
        "Issue #63 §3.3: код приватного прев'ю не містить /api/control",
        !jsSrc.slice(jsSrc.indexOf("function previewRender"), jsSrc.indexOf("function openPreviewModal")).includes("/api/control")
      );
      // Плавне прокручування: учень — до вікна перегляду, вчитель — до
      // спільного екрана після успішного запуску; без руху, якщо вже видимо
      check(
        "Issue #63 §2.7/§3.4: плавне прокручування до вікон у джерелі клієнта",
        jsSrc.includes("function scrollToPanel(panel, block = \"nearest\")") &&
          jsSrc.includes("behavior: \"smooth\"") &&
          jsSrc.includes("focusViewer($(\"viewer\"))") &&
          jsSrc.includes("scrollToPanel(document.querySelector(\".demo-screen-panel\"), \"start\")")
      );
      // §3: єдиний робочий простір вчителя — пункти розділів у навігації
      // ховаються лише для вчителя; матеріали повертаються після виходу
      check(
        "Issue #63 §3: навігація вчителя об'єднана в «Демонстрацію»",
        matHtml.includes('id="navMaterialsLink"') &&
          jsSrc.includes("if ($(\"navUploadLink\")) $(\"navUploadLink\").style.display = \"none\";") &&
          jsSrc.includes("$(\"navMaterialsLink\").style.display = \"\";")
      );
      // Вихід учителя: heartbeat, зупинка показу при «Вийти» та при закритті
      // вкладки. Доповнює поведінковий тест автозупинки вище (окремий екземпляр).
      check(
        "Issue #63: клієнт шле heartbeat викладача та зупиняє показ при виході",
        jsSrc.includes("\"/api/presence/teacher\"") &&
          jsSrc.includes("function reportTeacherLeave()") &&
          jsSrc.includes("startTeacherHeartbeat();") &&
          jsSrc.includes("stopTeacherHeartbeat();") &&
          jsSrc.includes("if (prevRole === \"teacher\")") &&
          jsSrc.includes("reportTeacherLeave();")
      );
      check(
        "Issue #63 Р: зупинка демонстрації — кнопка викладача та серверний стан",
        demoHtml.includes('id="stopDemo"') &&
          jsSrc.includes("await postControl({ stop: true });") &&
          stateServiceSource.includes("if (data && data.stop === true) {")
      );
      check(
        "Issue #63 Р: самостійний перегляд не пише спільний стан демонстрації",
        jsSrc.includes('if (!pin || role !== "teacher") throw new Error("Потрібні права викладача.")') &&
          !jsSrc.slice(jsSrc.indexOf("function displayLocalFile(fileId)"), jsSrc.indexOf("function setLocalPage")).includes("postControl")
      );

      // Початок демонстрації: два «учні» отримують той самий серверний стан
      r = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 1 })
      });
      check("Issue #63 Р: викладач запускає демонстрацію", r.status === 200, `status=${r.status}`);

      const studentStateA = await (await fetch(base + "/api/state", { headers: sess() })).json();
      const studentStateB = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #63 Р: два учні бачать той самий активний стан демонстрації",
        studentStateA.file === fileId && studentStateB.file === fileId &&
          studentStateA.revision === studentStateB.revision,
        JSON.stringify({ a: studentStateA.file, b: studentStateB.file, revA: studentStateA.revision, revB: studentStateB.revision })
      );

      // Спроба учня змінити позицію без PIN не змінює спільний стан
      r = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: fileId, kind: "slides", page: 99 })
      });
      const stateAfterStudentAttempt = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #63 Р: самостійні дії учня не змінюють стан демонстрації",
        r.status === 403 && stateAfterStudentAttempt.file === fileId && stateAfterStudentAttempt.page === 1,
        `status=${r.status}, file=${stateAfterStudentAttempt.file}, page=${stateAfterStudentAttempt.page}`
      );

      // Зупинка демонстрації вчителем скидає стан для всіх клієнтів
      r = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, stop: true })
      });
      const stoppedState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #63 Р: зупинка демонстрації скидає серверний стан (для всіх учнів)",
        r.status === 200 && stoppedState.file === "" && stoppedState.page === 1,
        `status=${r.status}, file=${JSON.stringify(stoppedState.file)}, page=${stoppedState.page}`
      );

      // Issue #63: вихід учителя — присутність викладача (heartbeat)
      r = await fetch(base + "/api/presence/teacher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      check("Issue #63: heartbeat викладача без PIN → 403", r.status === 403, `status=${r.status}`);
      r = await fetch(base + "/api/presence/teacher", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Portal-Pin": PIN },
        body: "{}"
      });
      check("Issue #63: heartbeat викладача з PIN → 200", r.status === 200, `status=${r.status}`);

      // 7г. Issue #83: MVP системи тестування під час демонстрації.
      // Повний цикл на ОСНОВНОМУ екземплярі: старт (3/4 варіанти) → відповіді
      // на парному слайді → автозачинення на непарному → ручне завершення →
      // збереження результатів після зупинки показу → очищення при новому старті.
      const t83Demo = await (await fetch(base + "/demonstration")).text();
      const t83Css = await (await fetch(base + "/css/style.css")).text();
      const t83Js = await (await fetch(base + "/js/app.js")).text();
      const t83StateSrc = require("node:fs").readFileSync(
        require("node:path").join(__dirname, "src", "services", "stateService.js"),
        "utf-8"
      );

      check(
        "Issue #83: розмітка — панель вчителя і кнопки відповіді учня",
        t83Demo.includes('id="testPanel"') &&
          t83Demo.includes('id="testToggleBtn"') &&
          t83Demo.includes('id="testOpt3"') &&
          t83Demo.includes('id="testOpt4"') &&
          t83Demo.includes('id="testStatus"') &&
          t83Demo.includes('id="testHistogram"') &&
          t83Demo.includes('id="testAnswerBar"')
      );
      check(
        "Issue #83: панель тестування — усередині teacher-only блоку «Учні»",
        t83Demo.indexOf('id="studentsSideBlock"') !== -1 &&
          t83Demo.indexOf('id="testPanel"') > t83Demo.indexOf('id="studentsSideBlock"')
      );
      check(
        "Issue #83: CSS кнопок відповіді, гістограми, бейджа та рядка учня",
        t83Css.includes(".test-answer-btn") &&
          t83Css.includes(".test-panel") &&
          t83Css.includes(".test-histogram") &&
          t83Css.includes(".student-test-answer") &&
          t83Css.includes("#viewer[data-test-answer]")
      );
      check(
        "Issue #83: клієнт — стан, рендер панелі/кнопок, три операції",
        t83Js.includes("function applyTestingState") &&
          t83Js.includes("function renderTestingPanel") &&
          t83Js.includes("function renderTestAnswerBar") &&
          t83Js.includes("function updateViewerTestBadge") &&
          t83Js.includes("/api/testing/start") &&
          t83Js.includes("/api/testing/answer") &&
          t83Js.includes("/api/testing/finish")
      );
      check(
        "Issue #83: клієнт надсилає відповідь лише за серверного accepting",
        t83Js.includes("view.accepting !== true")
      );
      check(
        "Issue #83: вказівник запитання оновлюється лише при зміні слайда",
        t83StateSrc.includes("testingService.syncSlide(this.shared.file, this.shared.page);")
      );

      // --- Захист операцій (PIN для старту/завершення, сесія для відповіді) ---
      r = await fetch(base + "/api/testing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ options: 3 })
      });
      check("Issue #83: старт тестування без PIN → 403", r.status === 403, `status=${r.status}`);

      r = await fetch(base + "/api/testing/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN })
      });
      check("Issue #83: завершення незапущеного тестування → 409", r.status === 409, `status=${r.status}`);

      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: 0 })
      });
      check("Issue #83: відповідь без сесії → 401", r.status === 401, `status=${r.status}`);

      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tSess() },
        body: JSON.stringify({ variant: 0 })
      });
      check("Issue #83: відповідь викладача → 403", r.status === 403, `status=${r.status}`);

      // Друга сесія учня БЕЗ heartbeat: studentId ще не прив'язаний до сесії
      const t83Unbound = await studentLogin(base, "Учень без прив'язки", false);
      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "ly_session=" + t83Unbound.cookie },
        body: JSON.stringify({ variant: 0 })
      });
      check("Issue #83: відповідь до прив'язки studentId → 409", r.status === 409, `status=${r.status}`);

      // --- Показ на ПАРНОМУ слайді: там саме запитання ---
      r = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 2 })
      });
      check("Issue #83: демонстрація на слайді 2 (запитання)", r.status === 200, `status=${r.status}`);

      r = await fetch(base + "/api/testing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, options: 5 })
      });
      check("Issue #83: кількість варіантів лише 3 або 4 → 400", r.status === 400, `status=${r.status}`);

      let t83Start = await (await fetch(base + "/api/testing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, options: 4 })
      })).json();
      check(
        "Issue #83: старт (4 варіанти) — active, options=4, запитання = слайд 2",
        Boolean(t83Start.testing) && t83Start.testing.status === "active" &&
          t83Start.testing.options === 4 &&
          Boolean(t83Start.testing.question) && t83Start.testing.question.page === 2,
        JSON.stringify(t83Start.testing)
      );

      r = await fetch(base + "/api/testing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, options: 3 })
      });
      check("Issue #83: повторний старт під час активного → 409", r.status === 409, `status=${r.status}`);

      // Персональний стан: вчитель бачить гістограму, учень — лише свій вибір
      let t83TeacherState = await (await fetch(base + "/api/state", { headers: tSess() })).json();
      let t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #83: state.testing викладача — гістограма та відповіді",
        Boolean(t83TeacherState.testing) && t83TeacherState.testing.status === "active" &&
          Array.isArray(t83TeacherState.testing.histogram) &&
          t83TeacherState.testing.histogram.length === 4 &&
          Boolean(t83TeacherState.testing.answers),
        JSON.stringify(t83TeacherState.testing)
      );
      check(
        "Issue #83: state.testing учня — accepting і свій вибір, без чужих даних",
        Boolean(t83StudentState.testing) && t83StudentState.testing.accepting === true &&
          t83StudentState.testing.yourAnswer === null &&
          t83StudentState.testing.answers === undefined &&
          t83StudentState.testing.histogram === undefined,
        JSON.stringify(t83StudentState.testing)
      );

      // --- Відповідь першого учня (сесія уже прив'язана до s_test_1) ---
      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ variant: 0 })
      });
      t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #83: відповідь учня прийнято (варіант 0 → yourAnswer=0)",
        r.status === 200 && t83StudentState.testing.yourAnswer === 0,
        `status=${r.status}, yourAnswer=${t83StudentState.testing.yourAnswer}`
      );

      // Повторне натискання ЗАМІНЮЄ вибір (у статистиці — лише останній)
      await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ variant: 2 })
      });

      // Другий учень: окрема сесія + heartbeat для прив'язки studentId
      const t83Second = await studentLogin(base, "Другий Учень", false);
      const t83SecondCookie = { Cookie: "ly_session=" + t83Second.cookie };
      await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...t83SecondCookie },
        body: JSON.stringify({ studentId: "s_test_83b", name: "Другий Учень", active: true })
      });
      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...t83SecondCookie },
        body: JSON.stringify({ variant: 1 })
      });

      // Обидва стани — ПІСЛЯ обох відповідей (стан персональний, не спільний)
      const t83SecondState = await (await fetch(base + "/api/state", { headers: t83SecondCookie })).json();
      t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      t83TeacherState = await (await fetch(base + "/api/state", { headers: tSess() })).json();
      const t83Histogram = (t83TeacherState.testing || {}).histogram;
      check(
        "Issue #83: гістограма — два учні, заміна вибору врахована лише один раз",
        Array.isArray(t83Histogram) && t83Histogram.join(",") === "0,1,1,0",
        JSON.stringify(t83Histogram)
      );
      check(
        "Issue #83: відповіді вчителя — по одному актуальному вибору на учня",
        Object.keys(t83TeacherState.testing.answers).length === 2 &&
          t83TeacherState.testing.answers.s_test_83b === 1 &&
          Object.keys(t83TeacherState.testing.answers)
            .some((id) => t83TeacherState.testing.answers[id] === 2),
        JSON.stringify(t83TeacherState.testing.answers)
      );
      check(
        "Issue #83: у кожного учня у стані ЛИШЕ його власний вибір",
        t83SecondState.testing.yourAnswer === 1 && t83SecondState.testing.answers === undefined &&
          t83StudentState.testing.yourAnswer === 2,
        JSON.stringify({ second: t83SecondState.testing, first: t83StudentState.testing })
      );

      // Невідомий варіант (для 4 варіантів допустимі 0…3)
      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ variant: 7 })
      });
      check("Issue #83: невідомий варіант відповіді → 400", r.status === 400, `status=${r.status}`);

      // --- Вступний слайд (1): запитання немає, але результати не зникають ---
      await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 1 })
      });
      t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      t83TeacherState = await (await fetch(base + "/api/state", { headers: tSess() })).json();
      check(
        "Issue #83: слайд 1 — приймання зачинене, запитання та відповіді збережені",
        t83StudentState.testing.accepting === false &&
          Boolean(t83TeacherState.testing.question) &&
          t83TeacherState.testing.question.page === 2 &&
          (t83TeacherState.testing.histogram || []).join(",") === "0,1,1,0",
        JSON.stringify({ student: t83StudentState.testing, teacher: t83TeacherState.testing })
      );

      // --- Непарний слайд-відповідь (3): приймання зачинене, вибір свій лишається ---
      await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 3 })
      });
      t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ variant: 3 })
      });
      check(
        "Issue #83: на слайді-відповіді приймання зачинене (відповідь → 409)",
        t83StudentState.testing.accepting === false &&
          t83StudentState.testing.yourAnswer === 2 && r.status === 409,
        `status=${r.status}, accepting=${t83StudentState.testing.accepting}, yourAnswer=${t83StudentState.testing.yourAnswer}`
      );

      // Повернення на парний слайд відкриває приймання ЗНОВУ (тестування не завершено)
      await fetch(base + "/api/presence/teacher", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Portal-Pin": PIN },
        body: "{}"
      });
      await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 2 })
      });
      t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #83: повернення на запитання відкриває приймання знову",
        t83StudentState.testing.accepting === true,
        `accepting=${t83StudentState.testing.accepting}`
      );

      // --- Ручне завершення: відповіді блокуються, результати лишаються ---
      await fetch(base + "/api/presence/teacher", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Portal-Pin": PIN },
        body: "{}"
      });
      const t83Finish = await (await fetch(base + "/api/testing/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN })
      })).json();
      t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      t83TeacherState = await (await fetch(base + "/api/state", { headers: tSess() })).json();
      r = await fetch(base + "/api/testing/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sess() },
        body: JSON.stringify({ variant: 0 })
      });
      check(
        "Issue #83: ручне завершення — status=finished, приймання заблоковано",
        t83Finish.testing.status === "finished" &&
          t83StudentState.testing.status === "finished" &&
          t83StudentState.testing.accepting === false && r.status === 409,
        `finish=${t83Finish.testing.status}, student=${JSON.stringify(t83StudentState.testing)}, answer=${r.status}`
      );
      check(
        "Issue #83: після завершення вчитель бачить результати запитання",
        Boolean(t83TeacherState.testing.question) &&
          (t83TeacherState.testing.histogram || []).join(",") === "0,1,1,0",
        JSON.stringify(t83TeacherState.testing)
      );

      // --- Зупинка показу НЕ знищує вказівник і результати останнього запитання ---
      await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, stop: true })
      });
      const t83Stopped = await (await fetch(base + "/api/state", { headers: tSess() })).json();
      const t83StoppedStudent = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #83: після зупинки показу запитання та відповіді збережені",
        t83Stopped.file === "" &&
          Boolean(t83Stopped.testing.question) && t83Stopped.testing.question.page === 2 &&
          (t83Stopped.testing.histogram || []).join(",") === "0,1,1,0" &&
          t83StoppedStudent.testing.accepting === false &&
          t83StoppedStudent.testing.yourAnswer === 2,
        JSON.stringify({ teacher: t83Stopped.testing, student: t83StoppedStudent.testing })
      );

      // --- Нове тестування: попередні відповіді очищаються (3 варіанти) ---
      const t83Restart = await (await fetch(base + "/api/testing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, options: 3 })
      })).json();
      t83TeacherState = await (await fetch(base + "/api/state", { headers: tSess() })).json();
      t83StudentState = await (await fetch(base + "/api/state", { headers: sess() })).json();
      check(
        "Issue #83: нове тестування (3 варіанти) — попередні відповіді очищено",
        t83Restart.testing.status === "active" && t83Restart.testing.options === 3 &&
          t83TeacherState.testing.question === null &&
          !Array.isArray(t83TeacherState.testing.histogram) &&
          t83StudentState.testing.yourAnswer === null &&
          t83StudentState.testing.accepting === false,
        JSON.stringify({ restart: t83Restart.testing, teacher: t83TeacherState.testing })
      );

      // Прибирання: активне тестування завершуємо, щоб не лишати стан «active»
      await fetch(base + "/api/testing/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN })
      });

      // === Issue #85: персональні облікові записи викладачів + розділ «Викладачі» ===
      // Критерії: створення/список без PIN і хешів, вхід за персональним PIN
      // (визначення облікового запису), дозволи demo/materials на сервері,
      // негайне відкликання сесій при зміні прав/деактивації/заміні PIN,
      // ліміт спроб за обліковим записом, відсутність адмін-доступу в
      // викладача/учня, випадковий PIN без PORTAL_PIN (лише термінал).
      const t85Fs = require("node:fs");
      const t85Path = require("node:path");
      const t85ConfigSrc = t85Fs.readFileSync(t85Path.join(__dirname, "src", "config", "index.js"), "utf-8");
      const t85Readme = t85Fs.readFileSync(t85Path.join(__dirname, "README.md"), "utf-8");
      const t85Nav = t85Fs.readFileSync(t85Path.join(__dirname, "views", "partials", "nav.hbs"), "utf-8");
      const t85View = t85Fs.readFileSync(t85Path.join(__dirname, "views", "teachers.hbs"), "utf-8");
      const t85PanelJs = t85Fs.readFileSync(t85Path.join(__dirname, "public", "js", "teachers.js"), "utf-8");
      const t85AppJs = t85Fs.readFileSync(t85Path.join(__dirname, "public", "js", "app.js"), "utf-8");
      const t85Gitignore = t85Fs.readFileSync(t85Path.join(__dirname, ".gitignore"), "utf-8");
      const t85StoreFile = t85Path.join(__dirname, "materials", ".teachers.json");

      check(
        "Issue #85: конфігурація з мінімальним стандартним PIN (PORTAL_PIN або 2468)",
        t85ConfigSrc.includes('process.env.PORTAL_PIN || "2468"')
      );
      check(
        "Issue #85: README описує PORTAL_PIN поточним стандартним 2468",
        t85Readme.includes("PORTAL_PIN") && t85Readme.includes("2468")
      );
      check("Issue #85: materials/ поза Git (.gitignore)", t85Gitignore.includes("materials/"));
      check(
        "Issue #85: пункт меню «Викладачі» з класом admin-only",
        t85Nav.includes('class="nav-link admin-only') && t85Nav.includes('href="/teachers"')
      );
      check(
        "Issue #85: сторінка панелі наявна, без PIN/хешів у розмітці",
        t85View.includes('id="teachersList"') &&
          t85View.includes("/js/teachers.js") &&
          !t85View.includes("pinHash")
      );
      check(
        "Issue #85: панель керує /api/teachers і не містить PIN-заголовків",
        t85PanelJs.includes("/api/teachers/create") &&
          t85PanelJs.includes("/api/teachers/set-pin") &&
          !t85PanelJs.includes("X-Portal-Pin")
      );
      check(
        "Issue #85: клієнт шле X-Portal-Teacher разом із PIN і ховає меню для не-адміна",
        t85AppJs.includes('"X-Portal-Teacher"') &&
          t85AppJs.includes("function applyAuthHeaders") &&
          t85AppJs.includes("admin-only")
      );

      const t85AdminHeaders = { "X-Portal-Pin": PIN };
      const t85Name = "Issue85 Тестовий Викладач";
      const t85Pin = "1357"; // персональний PIN (не збігається з адміністративним)
      const t85NewPin = "4682"; // після заміни
      const t85Pin2 = "9753"; // другий запис (тест ліміту спроб)
      let t85Id = "";
      let t85Id2 = "";
      let t85CatId = "";

      /** Вхід за PIN: статус, JSON і cookie нової сесії (учитель/адмін) */
      const t85Verify = async (pinValue) => {
        const resp = await fetch(base + "/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: pinValue })
        });
        let data = null;
        try { data = await resp.json(); } catch { /* відповідь не JSON */ }
        return { status: resp.status, data, cookie: extractSessionCookie(resp) };
      };
      const t85TeacherHeaders = (pinValue, id) => ({
        "Content-Type": "application/json",
        "X-Portal-Pin": pinValue,
        "X-Portal-Teacher": id
      });
      const t85JsonHeaders = { "Content-Type": "application/json" };
      /** Безпечне представлення відповіді: жодних полів pin/pinHash */
      const t85NoSecrets = (value) => {
        const text = JSON.stringify(value);
        return !text.includes("pinHash") && !text.includes('"pin"');
      };

      try {
        // --- Створення облікового запису адміністратором ---
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ fullName: t85Name, pin: t85Pin })
        });
        let t85Body = await r.json().catch(() => null);
        check(
          "Issue #85: створення запису адміністратором → 201, ПІБ і права за замовчуванням",
          r.status === 201 && t85Body && t85Body.teacher &&
            t85Body.teacher.fullName === t85Name &&
            t85Body.teacher.active === true &&
            Array.isArray(t85Body.teacher.permissions) &&
            t85Body.teacher.permissions.includes("demo") &&
            t85Body.teacher.permissions.includes("materials"),
          `status=${r.status}`
        );
        t85Id = t85Body && t85Body.teacher ? t85Body.teacher.id : "";
        check(
          "Issue #85: відповідь створення без PIN/хеша",
          Boolean(t85Id) && t85NoSecrets(t85Body)
        );

        // --- Панель «Викладачі»: лише сесія адміністратора, без PIN-заголовка ---
        // Регресія: поле `pin` у тілі — новий PIN викладача, а не креденціал
        // адміністратора; воно не має перекривати чинну адмін-сесію (403/«Неправильний PIN»).
        const t85SessLogin = await fetch(base + "/api/auth/verify", {
          method: "POST",
          headers: t85JsonHeaders,
          body: JSON.stringify({ pin: PIN })
        });
        const t85SessMatch = (t85SessLogin.headers.get("set-cookie") || "").match(/ly_session=([^;]+)/);
        const t85SessCookie = t85SessMatch ? t85SessMatch[1] : "";
        const t85SessHeaders = {
          "Content-Type": "application/json",
          Cookie: "ly_session=" + t85SessCookie
        };
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: t85SessHeaders,
          body: JSON.stringify({ fullName: "Сесійний Тест", pin: "7391", permissions: ["demo"] })
        });
        let t85SessBody = await r.json().catch(() => null);
        check(
          "Issue #85: створення із сесією адміністратора без PIN-заголовка → 201",
          t85SessLogin.status === 200 && Boolean(t85SessCookie) &&
            r.status === 201 && t85SessBody && t85SessBody.teacher &&
            t85SessBody.teacher.fullName === "Сесійний Тест",
          `login=${t85SessLogin.status} status=${r.status} msg=${t85SessBody && t85SessBody.message}`
        );
        const t85SessId = t85SessBody && t85SessBody.teacher ? t85SessBody.teacher.id : "";
        r = await fetch(base + "/api/teachers/set-pin", {
          method: "POST",
          headers: t85SessHeaders,
          body: JSON.stringify({ id: t85SessId, pin: "7392" })
        });
        check(
          "Issue #85: заміна PIN із сесією без PIN-заголовка → 200",
          Boolean(t85SessId) && r.status === 200,
          `status=${r.status}`
        );
        r = await fetch(base + "/api/teachers/delete", {
          method: "POST",
          headers: t85SessHeaders,
          body: JSON.stringify({ id: t85SessId, confirm: true })
        });
        check(
          "Issue #85: видалення із підтвердженням із сесією без PIN-заголовка → 200",
          Boolean(t85SessId) && r.status === 200,
          `status=${r.status}`
        );
        await fetch(base + "/api/auth/logout", {
          method: "POST",
          headers: { Cookie: "ly_session=" + t85SessCookie }
        });

        // --- Список: наслідки дій для адміністратора, без секретів ---
        r = await fetch(base + "/api/teachers", { headers: t85AdminHeaders });
        t85Body = await r.json().catch(() => null);
        const t85Row = t85Body && Array.isArray(t85Body.teachers)
          ? t85Body.teachers.find((item) => item.id === t85Id)
          : null;
        check(
          "Issue #85: список записів із наслідками (сесії/історія) і без PIN/хеша",
          r.status === 200 && Boolean(t85Row) &&
            Number.isInteger(t85Row.activeSessions) &&
            Number.isInteger(t85Row.historicalLinks) &&
            t85NoSecrets(t85Body),
          `status=${r.status}`
        );

        // --- Вхід викладача за персональним PIN: система називає обліковий запис ---
        let t85Login = await t85Verify(t85Pin);
        const t85Cookie1 = t85Login.cookie;
        check(
          "Issue #85: вхід за персональним PIN → 200, teacherId і ПІБ, без admin",
          t85Login.status === 200 && t85Login.data && t85Login.data.ok === true &&
            t85Login.data.role === "teacher" &&
            t85Login.data.teacherId === t85Id &&
            t85Login.data.fullName === t85Name &&
            !t85Login.data.admin &&
            t85NoSecrets(t85Login.data) &&
            t85Cookie1.length >= 32,
          `status=${t85Login.status}`
        );

        // --- Невірний PIN (лічильник IP; надалі скидається успішними входами) ---
        t85Login = await t85Verify("9999");
        check("Issue #85: невірний PIN викладача → 403", t85Login.status === 403, `status=${t85Login.status}`);

        // --- Викладач не адмін: сесія сама по собі і власні PIN+ід — не адмін ---
        r = await fetch(base + "/api/teachers", { headers: { Cookie: "ly_session=" + t85Cookie1 } });
        check("Issue #85: сесія викладача не читає список облікових записів → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/set-pin", {
          method: "POST",
          headers: Object.assign({ Cookie: "ly_session=" + t85Cookie1 }, t85JsonHeaders),
          body: JSON.stringify({ id: t85Id, pin: t85Pin2 })
        });
        check("Issue #85: викладач не може змінити власний PIN через сесію → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: t85TeacherHeaders(t85Pin, t85Id),
          body: JSON.stringify({ fullName: "Самопризначення", pin: "1111" })
        });
        check("Issue #85: викладач не може створити запис власним PIN → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/teachers", { headers: { Cookie: "ly_session=" + t85Cookie1 } });
        check("Issue #85: сторінка /teachers для викладача → 403", r.status === 403, `status=${r.status}`);

        // --- Операції викладача з персональним PIN + ідентифікатор ---
        r = await fetch(base + "/api/presence/teacher", {
          method: "POST",
          headers: t85TeacherHeaders(t85Pin, t85Id),
          body: JSON.stringify({})
        });
        check("Issue #85: heartbeat викладача (право demo) → 200", r.status === 200, `status=${r.status}`);
        const t85CatName = "Issue85Категорія" + Date.now();
        r = await fetch(base + "/api/categories", {
          method: "POST",
          headers: t85TeacherHeaders(t85Pin, t85Id),
          body: JSON.stringify({ name: t85CatName })
        });
        t85Body = await r.json().catch(() => null);
        check(
          "Issue #85: створення категорії викладачем (право materials) → 201",
          (r.status === 201 || r.status === 200) && t85Body && t85Body.category && t85Body.category.id,
          `status=${r.status}`
        );
        if (t85Body && t85Body.category) t85CatId = t85Body.category.id;

        // --- Відкликання права materials: перевірка на кожному запиті ---
        r = await fetch(base + "/api/teachers/update", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id, permissions: ["demo"] })
        });
        check("Issue #85: адміністратор відкликав право materials → 200", r.status === 200, `status=${r.status}`);
        r = await fetch(base + "/api/categories", {
          method: "POST",
          headers: t85TeacherHeaders(t85Pin, t85Id),
          body: JSON.stringify({ name: t85CatName + "2" })
        });
        check("Issue #85: без materials створення категорії → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/api/presence/teacher", {
          method: "POST",
          headers: t85TeacherHeaders(t85Pin, t85Id),
          body: JSON.stringify({})
        });
        check("Issue #85: право demo після зміни прав збережене → 200", r.status === 200, `status=${r.status}`);
        r = await fetch(base + "/api/state", { headers: { Cookie: "ly_session=" + t85Cookie1 } });
        check("Issue #85: сесію відкликано після зміни прав → 401", r.status === 401, `status=${r.status}`);

        // --- Повторний вхід після відкликання працює (це не бан) ---
        t85Login = await t85Verify(t85Pin);
        const t85Cookie2 = t85Login.cookie;
        check(
          "Issue #85: повторний вхід після зміни прав → 200 і нова сесія",
          t85Login.status === 200 && t85Login.data && t85Login.data.teacherId === t85Id && t85Cookie2.length >= 32,
          `status=${t85Login.status}`
        );
        r = await fetch(base + "/api/state", { headers: { Cookie: "ly_session=" + t85Cookie2 } });
        check("Issue #85: нова сесія викладача читає стан → 200", r.status === 200, `status=${r.status}`);

        // --- Деактивація: вхід і операції неможливі, сесії відкликано ---
        r = await fetch(base + "/api/teachers/update", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id, active: false })
        });
        check("Issue #85: деактивація запису → 200", r.status === 200, `status=${r.status}`);
        t85Login = await t85Verify(t85Pin);
        check("Issue #85: вхід деактивованого викладача → 403", t85Login.status === 403, `status=${t85Login.status}`);
        r = await fetch(base + "/api/presence/teacher", {
          method: "POST",
          headers: t85TeacherHeaders(t85Pin, t85Id),
          body: JSON.stringify({})
        });
        check("Issue #85: операція деактивованого запису → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/api/state", { headers: { Cookie: "ly_session=" + t85Cookie2 } });
        check("Issue #85: сесію відкликано після деактивації → 401", r.status === 401, `status=${r.status}`);

        // --- Повне відновлення запису (адмін-запити скидають ліміт IP) ---
        r = await fetch(base + "/api/teachers/update", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id, active: true, permissions: ["demo", "materials"] })
        });
        check("Issue #85: повторна активація з повними правами → 200", r.status === 200, `status=${r.status}`);

        // --- Заміна PIN: старий PIN помирає, сесії відкликано, хеш у файлі ---
        t85Login = await t85Verify(t85Pin);
        const t85Cookie3 = t85Login.cookie;
        check("Issue #85: вхід старим PIN перед заміною → 200", t85Login.status === 200, `status=${t85Login.status}`);
        r = await fetch(base + "/api/teachers/set-pin", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id, pin: t85NewPin })
        });
        check("Issue #85: заміна PIN адміністратором → 200", r.status === 200, `status=${r.status}`);
        r = await fetch(base + "/api/state", { headers: { Cookie: "ly_session=" + t85Cookie3 } });
        check("Issue #85: сесію відкликано після заміни PIN → 401", r.status === 401, `status=${r.status}`);
        t85Login = await t85Verify(t85Pin);
        check("Issue #85: старий PIN після заміни → 403", t85Login.status === 403, `status=${t85Login.status}`);
        t85Login = await t85Verify(t85NewPin);
        check(
          "Issue #85: новий PIN після заміни → 200 і той самий обліковий запис",
          t85Login.status === 200 && t85Login.data && t85Login.data.teacherId === t85Id,
          `status=${t85Login.status}`
        );

        // --- Без PIN-ідентифікатора персональний PIN не діє (без fallback) ---
        r = await fetch(base + "/api/presence/teacher", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Portal-Pin": t85NewPin },
          body: JSON.stringify({})
        });
        check("Issue #85: персональний PIN без X-Portal-Teacher → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/api/presence/teacher", {
          method: "POST",
          headers: t85TeacherHeaders(t85NewPin, "deadbeefdeadbeef"),
          body: JSON.stringify({})
        });
        check("Issue #85: PIN з невідомим ідентифікатором запису → 403", r.status === 403, `status=${r.status}`);

        // --- Формат PIN: рівно 4 цифри ---
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ fullName: "Issue85 Формат1", pin: "12ab" })
        });
        check("Issue #85: PIN не з 4 цифр (букви) → 400", r.status === 400, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ fullName: "Issue85 Формат2", pin: "12345" })
        });
        check("Issue #85: PIN не з 4 цифр (5 цифр) → 400", r.status === 400, `status=${r.status}`);

        // --- Ліміт спроб ЗА ОБЛІКОВИМ ЗАПИСОМ (3 невдачі → блок, і PIN-відповідність не рятує) ---
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ fullName: "Issue85 Другий", pin: t85Pin2 })
        });
        t85Body = await r.json().catch(() => null);
        t85Id2 = t85Body && t85Body.teacher ? t85Body.teacher.id : "";
        check("Issue #85: створено другий запис для тесту ліміту", r.status === 201 && Boolean(t85Id2), `status=${r.status}`);

        // --- Унікальність PIN: не може належати іншому активному обліковому запису
        // --- і не може збігатися з адміністративним PORTAL_PIN ---
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ fullName: "Issue85 Конфлікт PIN", pin: t85Pin2 })
        });
        check("Issue #85: другий викладач із PIN першого → 400", r.status === 400, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/set-pin", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id, pin: t85Pin2 })
        });
        check("Issue #85: заміна PIN на зайнятий іншим записом → 400", r.status === 400, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ fullName: "Issue85 Конфлікт Адмін", pin: PIN })
        });
        check("Issue #85: PIN рівний адміністративному PORTAL_PIN → 400", r.status === 400, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/set-pin", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id2, pin: PIN })
        });
        check("Issue #85: заміна PIN на PORTAL_PIN → 400", r.status === 400, `status=${r.status}`);
        // Конкурентне створення з однаковим PIN — лише одне успішне (сервер однопоточний,
        // читання+запис синхронні, тому гонки всередині процесу неможливі)
        const pinC = "7777";
        const resultsC = await Promise.all([
          fetch(base + "/api/teachers/create", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
            body: JSON.stringify({ fullName: "Issue85 Конкурент 1", pin: pinC })
          }),
          fetch(base + "/api/teachers/create", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
            body: JSON.stringify({ fullName: "Issue85 Конкурент 2", pin: pinC })
          })
        ]);
        const statusesC = resultsC.map((r) => r.status);
        check(
          "Issue #85: конкурентне створення з однаковим PIN — лише одне успішне",
          statusesC.includes(201) && statusesC.filter((s) => s === 201).length === 1,
          JSON.stringify(statusesC)
        );
        const succC = await (resultsC[statusesC.indexOf(201)]).json().catch(() => null);
        if (succC && succC.teacher && succC.teacher.id) {
          await fetch(base + "/api/teachers/delete", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
            body: JSON.stringify({ id: succC.teacher.id, confirm: true })
          });
        }
        // CLI-інструмент власника теж відхиляє зайнятий PIN
        const { execSync } = require("node:child_process");
        let cliExit = 0;
        try {
          execSync("node tools\\teachers.js create --name \"Issue85 CLIКонфлікт\"", {
            env: Object.assign({}, process.env, { TEACHER_PIN: t85Pin2 }),
            stdio: ["ignore", "pipe", "pipe"]
          });
        } catch (error) {
          cliExit = error.status || 1;
        }
        check("Issue #85: CLI відхиляє зайнятий PIN (не нульовий вихідний код)", cliExit !== 0);
        for (let attempt = 0; attempt < 3; attempt++) {
          await fetch(base + "/api/presence/teacher", {
            method: "POST",
            headers: t85TeacherHeaders("0000", t85Id2),
            body: JSON.stringify({})
          });
        }
        r = await fetch(base + "/api/presence/teacher", {
          method: "POST",
          headers: t85TeacherHeaders(t85Pin2, t85Id2),
          body: JSON.stringify({})
        });
        check(
          "Issue #85: після 3 невдач обліковий запис блокується (429 навіть з правильним PIN)",
          r.status === 429,
          `status=${r.status}`
        );
        t85Login = await t85Verify(t85Pin2);
        check("Issue #85: вхід заблокованого облікового запису → 429", t85Login.status === 429, `status=${t85Login.status}`);
        r = await fetch(base + "/api/teachers", { headers: t85AdminHeaders });
        check("Issue #85: адміністратор не залежить від ліміту запису → 200", r.status === 200, `status=${r.status}`);

        // --- Видалення: лише з підтвердженням ---
        r = await fetch(base + "/api/teachers/delete", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id2 })
        });
        check("Issue #85: видалення без confirm → 400", r.status === 400, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/delete", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id2, confirm: true })
        });
        check("Issue #85: видалення з confirm → 200", r.status === 200, `status=${r.status}`);
        t85Id2 = "";
        r = await fetch(base + "/api/teachers", { headers: t85AdminHeaders });
        t85Body = await r.json().catch(() => null);
        check(
          "Issue #85: видалений запис зник зі списку",
          r.status === 200 && Array.isArray(t85Body.teachers) &&
            !t85Body.teachers.some((item) => item.fullName === "Issue85 Другий")
        );

        // --- Учень і гість без адмін-доступу ---
        r = await fetch(base + "/api/teachers", { headers: sess() });
        check("Issue #85: сесія учня не читає список → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/api/teachers/create", {
          method: "POST",
          headers: Object.assign({}, sess(), t85JsonHeaders),
          body: JSON.stringify({ fullName: "Issue85 Учень", pin: "2222" })
        });
        check("Issue #85: сесія учня не створює записи → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/teachers", { headers: sess() });
        check("Issue #85: сторінка /teachers для учня → 403", r.status === 403, `status=${r.status}`);
        r = await fetch(base + "/api/teachers");
        check("Issue #85: запит без входу до /api/teachers → 401", r.status === 401, `status=${r.status}`);

        // --- Файл записів: лише хеш scrypt, жодного PIN у відкритому вигляді ---
        const t85StoreRaw = t85Fs.readFileSync(t85StoreFile, "utf-8");
        let t85Store = null;
        try { t85Store = JSON.parse(t85StoreRaw); } catch { /* не JSON */ }
        check(
          "Issue #85: materials/.teachers.json містить лише хеши scrypt, без PIN",
          Boolean(t85Store) && Array.isArray(t85Store.teachers) &&
            t85StoreRaw.includes("scrypt$") &&
            t85Store.teachers.every((item) =>
              typeof item.pinHash === "string" && item.pinHash.startsWith("scrypt$") && !("pin" in item)) &&
            !t85StoreRaw.includes('"' + t85Pin + '"') &&
            !t85StoreRaw.includes('"' + t85NewPin + '"') &&
            !t85StoreRaw.includes('"' + t85Pin2 + '"')
        );

        // --- Архівація: м'яке видалення, каталог матеріалів не змінюється ---
        r = await fetch(base + "/api/files", { headers: t85AdminHeaders });
        const t85FilesBefore = r.status === 200 ? (await r.json()).length : -1;
        r = await fetch(base + "/api/teachers/archive", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id })
        });
        check("Issue #85: архівація запису → 200", r.status === 200, `status=${r.status}`);
        r = await fetch(base + "/api/files", { headers: t85AdminHeaders });
        const t85FilesAfter = r.status === 200 ? (await r.json()).length : -2;
        check(
          "Issue #85: архівація не видаляє матеріали (кількість файлів лишилася)",
          t85FilesBefore >= 0 && t85FilesBefore === t85FilesAfter,
          `before=${t85FilesBefore}, after=${t85FilesAfter}`
        );
        r = await fetch(base + "/api/teachers", { headers: t85AdminHeaders });
        t85Body = await r.json().catch(() => null);
        const t85Archived = t85Body && Array.isArray(t85Body.teachers)
          ? t85Body.teachers.find((item) => item.id === t85Id)
          : null;
        check(
          "Issue #85: архівований запис у списку (archived=true, active=false)",
          Boolean(t85Archived) && t85Archived.archived === true && t85Archived.active === false
        );
        t85Login = await t85Verify(t85NewPin);
        check("Issue #85: вхід архівованого запису → 403", t85Login.status === 403, `status=${t85Login.status}`);

        // --- Сторінка /teachers для адміністратора (сесія за PORTAL_PIN) ---
        t85Login = await t85Verify(PIN);
        const t85AdminCookie = t85Login.cookie;
        check(
          "Issue #85: вхід за PORTAL_PIN → admin:true",
          t85Login.status === 200 && t85Login.data && t85Login.data.admin === true && t85Login.data.role === "teacher",
          `status=${t85Login.status}`
        );
        r = await fetch(base + "/teachers", { headers: { Cookie: "ly_session=" + t85AdminCookie } });
        const t85PageHtml = await r.text();
        check(
          "Issue #85: адміністратор відкриває /teachers (панель без PIN/хешів)",
          r.status === 200 &&
            t85PageHtml.includes('id="teachersList"') &&
            t85PageHtml.includes("Викладачі") &&
            !t85PageHtml.includes("pinHash"),
          `status=${r.status}`
        );
        r = await fetch(base + "/teachers");
        check("Issue #85: сторінка /teachers без входу → 403", r.status === 403, `status=${r.status}`);

        // --- Прибирання власних тестових даних (не чужі записи) ---
        r = await fetch(base + "/api/teachers/delete", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
          body: JSON.stringify({ id: t85Id, confirm: true })
        });
        check("Issue #85: прибирання — видалення тестового запису → 200", r.status === 200, `status=${r.status}`);
        if (t85CatId) {
          await fetch(base + "/api/categories/delete", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders),
            body: JSON.stringify({ categoryId: t85CatId })
          });
        }
        r = await fetch(base + "/api/teachers", { headers: t85AdminHeaders });
        t85Body = await r.json().catch(() => null);
        check(
          "Issue #85: після прибирання тестові записи відсутні у файлі",
          r.status === 200 && Array.isArray(t85Body.teachers) &&
            !t85Body.teachers.some((item) => item.id === t85Id || item.fullName === t85Name)
        );

        // --- Захист входу за персональним PIN від перебору (лімітер за IP +
        // --- захищеним відбитком PIN, діє до ідентифікації облікового запису) ---
        const PL = require(t85Path.join(__dirname, "src", "utils", "pinLimiter"));

        // Помилки входу не розкривають існування облікового запису: невірний PIN
        // існуючого (архівованого) запису та PIN неіснуючого запису — одна помилка.
        const rwExist = await t85Verify("4681"); // невірний PIN запису t85Id (зараз 4682)
        const rwNone = await t85Verify("0000"); // PIN, що не належить жодному запису
        check(
          "Issue #85: помилка входу однакова для існуючого та неіснуючого PIN",
          rwExist.status === 403 && rwNone.status === 403 &&
            JSON.stringify(rwExist.data) === JSON.stringify(rwNone.data),
          `exist=${rwExist.status} none=${rwNone.status}`
        );
        // Адміністративний запит скидає лічильник IP перед серією спроб входу
        r = await fetch(base + "/api/teachers", { headers: t85AdminHeaders });
        check("Issue #85: адміністративний запит між тестами лімітера → 200", r.status === 200, `status=${r.status}`);

        // Серія неправильних PIN під час входу: лічильник працює, одна спроба не блокує
        for (let i = 0; i < 4; i++) {
          const rw = await t85Verify("9999");
          check("Issue #85: невдала спроба входу → 403, не блокує після однієї", rw.status === 403, `attempt=${i + 1}`);
        }

        // Одиниця: лімітер за відбиток PIN блокує після 5 невдалих, один PIN не блокує інший
        const fpA = PL.pinFingerprint("11111111");
        const fpB = PL.pinFingerprint("22222222");
        for (let i = 0; i < 5; i++) PL.pinAttemptLimiter.registerFailure(fpA);
        check("Issue #85: лімітер відбитка PIN блокує після 5 невдалих спроб", PL.pinAttemptLimiter.isBlocked(fpA));
        PL.pinAttemptLimiter.registerFailure(fpB);
        check("Issue #85: один PIN не блокує вхід іншим PIN", !PL.pinAttemptLimiter.isBlocked(fpB));
        check("Issue #85: відбиток PIN — хешоподібне значення, а не сам PIN",
          typeof PL.pinFingerprint === "function" && PL.pinFingerprint("x").length === 64 &&
            PL.pinFingerprint("x") !== "x");

        // Статичний перевірка: ключ лімітера входу — відбиток PIN (HMAC), а не IP;
        // зміна IP не скидає лічильник спроб за конкретним PIN.
        const pinLimiterSrc = t85Fs.readFileSync(t85Path.join(__dirname, "src", "utils", "pinLimiter.js"), "utf-8");
        check("Issue #85: лімітер входу використовує захищений відбиток PIN (createHmac/pinFingerprint)",
          pinLimiterSrc.includes("createHmac") && pinLimiterSrc.includes("pinFingerprint") &&
            pinLimiterSrc.includes("pinAttemptLimiter"));
        // PIN не зберігається у лімітері ani у логах сервера
        check("Issue #85: введені PIN не потрапили у журнали сервера",
          !SERVER_LOG.includes("9999") && !SERVER_LOG.includes("4681") && !SERVER_LOG.includes("0000"));

        // Issue #85 (05-11-2026, рішення власника після рядка «стандартний 2468»):
        // випадкова генерація PIN прибрана — сервер має працювати без ручного
        // втручання після кожного перезапуску, PIN = PORTAL_PIN або 2468.
        const GEN_PORT = PORT + 3;
        const genBase = "http://127.0.0.1:" + GEN_PORT;
        const genEnv = Object.assign({}, process.env, { PORT: String(GEN_PORT), CI: "" });
        delete genEnv.PORTAL_PIN;
        const gen = spawn(process.execPath, ["server.js"], {
          env: genEnv,
          stdio: ["ignore", "pipe", "pipe"]
        });
        let genLog = "";
        gen.stdout.on("data", (chunk) => { genLog += chunk; });
        gen.stderr.on("data", (chunk) => { genLog += chunk; });
        try {
          const genUp = await waitForHealth(genBase);
          check("Issue #85: екземпляр без PORTAL_PIN запущено (стандартний PIN)", genUp, "port=" + GEN_PORT);
          if (genUp) {
            const genLogin = await (await fetch(genBase + "/api/auth/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin: PIN })
            })).json().catch(() => null);
            check(
              "Issue #85: без PORTAL_PIN стандартний 4-значний PIN дає адмін-сесію",
              Boolean(genLogin) && genLogin.ok === true && genLogin.admin === true
            );
            const genWrong = await fetch(genBase + "/api/auth/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin: "9999" })
            });
            check("Issue #85: чужий PIN на екземплярі без PORTAL_PIN → 403", genWrong.status === 403, `status=${genWrong.status}`);
            // Значення PIN не потрапляє у відповіді HTTP
            const genRoot = await (await fetch(genBase + "/")).text();
            const genHealth = await (await fetch(genBase + "/health")).text();
            const genDemo = await (await fetch(genBase + "/demonstration")).text();
            check(
              "Issue #85: стандартний PIN відсутній у відповідях HTTP",
              !genRoot.includes(PIN) && !genHealth.includes(PIN) && !genDemo.includes(PIN)
            );
          }
        } finally {
          gen.kill();
        }

        check(
          "Issue #85: основний екземпляр не друкує значення заданого PIN",
          SERVER_LOG.includes("PIN викладача: задано через змінну PORTAL_PIN")
        );
      } finally {
        // Прибирання навіть за помилки: видаляємо лише записи, створені ТУТ
        try {
          const t85CleanupHeaders = Object.assign({ "Content-Type": "application/json" }, t85AdminHeaders);
          if (t85Id) {
            await fetch(base + "/api/teachers/delete", {
              method: "POST",
              headers: t85CleanupHeaders,
              body: JSON.stringify({ id: t85Id, confirm: true })
            });
          }
          if (t85Id2) {
            await fetch(base + "/api/teachers/delete", {
              method: "POST",
              headers: t85CleanupHeaders,
              body: JSON.stringify({ id: t85Id2, confirm: true })
            });
          }
          if (t85CatId) {
            await fetch(base + "/api/categories/delete", {
              method: "POST",
              headers: t85CleanupHeaders,
              body: JSON.stringify({ categoryId: t85CatId })
            });
          }
        } catch { /* прибирання не валить тест */ }
      }

      // === Issue #88: персональні простори матеріалів викладачів ===
      const t88AdminHeaders = { "Content-Type": "application/json", "X-Portal-Pin": PIN };
      const t88Verify = async (pinValue) => {
        const resp = await fetch(base + "/api/auth/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: pinValue })
        });
        let data = null;
        try { data = await resp.json(); } catch { /* не JSON */ }
        const cookie = (resp.headers.get("set-cookie") || "").match(/ly_session=([^;]+)/);
        return { status: resp.status, data, cookie: cookie ? cookie[1] : "" };
      };
      const t88AuthHeaders = (cookie, pin, teacherId) => ({
        "Content-Type": "application/json",
        "X-Portal-Pin": pin,
        "X-Portal-Teacher": teacherId,
        "Cookie": "ly_session=" + cookie
      });
      // Потокове завантаження: без Content-Type, щоб express.json не намагався
      // розібрати бінарне тіло запиту
      const t88UploadHeaders = (cookie, pin, teacherId) => ({
        "X-Portal-Pin": pin,
        "X-Portal-Teacher": teacherId,
        "Cookie": "ly_session=" + cookie
      });
      const t88TeacherHeaders = (cookie, folderId) => {
        const h = { "X-Portal-Pin": PIN, "Cookie": "ly_session=" + cookie };
        if (folderId) h["Content-Type"] = "application/json";
        return h;
      };

      // Створити двох викладачів через адміністратора
      const t88PinA = String(1000 + Math.floor(Math.random() * 9000));
      const t88PinB = String(1000 + Math.floor(Math.random() * 9000));
      let t88TeacherA = null, t88TeacherB = null;
      {
        const ra = await (await fetch(base + "/api/teachers/create", {
          method: "POST", headers: t88AdminHeaders,
          body: JSON.stringify({ fullName: "Issue88 Викладач А", pin: t88PinA, permissions: ["demo", "materials"] })
        })).json();
        t88TeacherA = ra && ra.teacher ? ra.teacher : null;
        const rb = await (await fetch(base + "/api/teachers/create", {
          method: "POST", headers: t88AdminHeaders,
          body: JSON.stringify({ fullName: "Issue88 Викладач Б", pin: t88PinB, permissions: ["demo", "materials"] })
        })).json();
        t88TeacherB = rb && rb.teacher ? rb.teacher : null;
      }
      check(
        "Issue #85: створено двох викладачів для тесту просторів",
        Boolean(t88TeacherA) && Boolean(t88TeacherB) && t88TeacherA.id !== t88TeacherB.id,
        JSON.stringify({ a: t88TeacherA, b: t88TeacherB })
      );

      // Війти як обидва викладачі
      const t88LoginA = await t88Verify(t88PinA);
      const t88LoginB = await t88Verify(t88PinB);
      check(
        "Issue #88: вхід обох викладачів → 200",
        t88LoginA.status === 200 && t88LoginB.status === 200 &&
          t88LoginA.data.teacherId === t88TeacherA.id && t88LoginB.data.teacherId === t88TeacherB.id
      );

      // Завантажити файл кожному викладачу у його простір
      const t88FileA = await (await fetch(base + "/api/materials/upload?name=ФайлА.pdf", {
        method: "POST",
        headers: t88UploadHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: TINY_PDF_BODY
      })).json();
      const t88FileB = await (await fetch(base + "/api/materials/upload?name=ФайлБ.pdf", {
        method: "POST",
        headers: t88UploadHeaders(t88LoginB.cookie, t88PinB, t88TeacherB.id),
        body: TINY_PDF_BODY
      })).json();
      check(
        "Issue #88: кожен викладач завантажив файл у власний простір",
        Boolean(t88FileA) && Boolean(t88FileB) &&
          t88FileA.owner === t88TeacherA.id && t88FileB.owner === t88TeacherB.id &&
          t88FileA.id !== t88FileB.id
      );

      // === Папки: вкладена структура у власному просторі ===
      const t88FolderAResp = await fetch(base + "/api/materials/folder", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ name: "Папка А1" })
      });
      let t88FolderA = null;
      try { t88FolderA = await t88FolderAResp.json(); } catch { /* не JSON */ }
      const t88FolderAId = t88FolderA && t88FolderA.folder ? t88FolderA.folder.id : "";
      const t88FolderAChildResp = await fetch(base + "/api/materials/folder", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ name: "Папка А2", parentId: t88FolderAId })
      });
      let t88FolderAChild = null;
      try { t88FolderAChild = await t88FolderAChildResp.json(); } catch { /* не JSON */ }
      const t88FolderAChildId = t88FolderAChild && t88FolderAChild.folder ? t88FolderAChild.folder.id : "";
      check(
        "Issue #88: створення вкладених папок у власному просторі",
        t88FolderAResp.status === 201 && t88FolderAChildResp.status === 201 &&
          Boolean(t88FolderAId) && Boolean(t88FolderAChildId) &&
          t88FolderAChild.folder.parentId === t88FolderAId &&
          t88FolderA.folder.teacherId === t88TeacherA.id,
        `folder=${t88FolderAResp.status}, child=${t88FolderAChildResp.status}`
      );

      // Завантаження у власну папку: файл зберігається у <teacherId>/<folderId>
      const t88FolderUploadResp = await fetch(
        base + "/api/materials/upload?name=" + encodeURIComponent("ФайлУПапці.pdf") +
          "&folderId=" + encodeURIComponent(t88FolderAId),
        {
          method: "POST",
          headers: t88UploadHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
          body: TINY_PDF_BODY
        }
      );
      let t88FolderFile = null;
      try { t88FolderFile = await t88FolderUploadResp.json(); } catch { /* не JSON */ }
      const t88FolderFileId = t88FolderFile && t88FolderFile.id ? t88FolderFile.id : "";
      check(
        "Issue #88: завантаження у власну папку → 201, folderId збережено",
        t88FolderUploadResp.status === 201 && Boolean(t88FolderFileId) &&
          t88FolderFile.folderId === t88FolderAId && t88FolderFile.owner === t88TeacherA.id,
        `status=${t88FolderUploadResp.status}`
      );

      // Файл із папки віддається сервером за прямим URL власнику
      const t88FolderRawResp = await fetch(base + "/files/" + encodeURIComponent(t88FolderFileId), {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      });
      check(
        "Issue #88: файл із папки доступний власнику за прямим URL",
        Boolean(t88FolderFileId) && t88FolderRawResp.status === 200,
        `status=${t88FolderRawResp.status}`
      );

      // Дерево папок: одна коренева папка з вкладеною дочірньою
      const t88TreeA = await (await fetch(base + "/api/materials/tree", {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      })).json();
      check(
        "Issue #88: дерево папок показує вкладену структуру",
        Array.isArray(t88TreeA.tree) && t88TreeA.tree.length === 1 &&
          Array.isArray(t88TreeA.tree[0].children) && t88TreeA.tree[0].children.length === 1 &&
          t88TreeA.tree[0].children[0].id === t88FolderAChildId
      );

      // Чужа папка: перейменування та завантаження заборонені
      const t88FolderSpoofResp = await fetch(base + "/api/materials/folder/rename", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginB.cookie, t88PinB, t88TeacherB.id),
        body: JSON.stringify({ folderId: t88FolderAId, name: "Чужа папка" })
      });
      const t88FolderUploadBResp = await fetch(
        base + "/api/materials/upload?name=" + encodeURIComponent("Чужий.pdf") +
          "&folderId=" + encodeURIComponent(t88FolderAId),
        {
          method: "POST",
          headers: t88UploadHeaders(t88LoginB.cookie, t88PinB, t88TeacherB.id),
          body: TINY_PDF_BODY
        }
      );
      check(
        "Issue #88: чужа папка недоступна для змін і завантаження",
        t88FolderSpoofResp.status === 403 && t88FolderUploadBResp.status === 403,
        `rename=${t88FolderSpoofResp.status}, upload=${t88FolderUploadBResp.status}`
      );

      // Непорожню папку не можна видалити
      const t88FolderDeleteResp = await fetch(base + "/api/materials/folder/delete", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ folderId: t88FolderAId })
      });
      check(
        "Issue #88: непорожня папка не видаляється → 409",
        t88FolderDeleteResp.status === 409,
        `status=${t88FolderDeleteResp.status}`
      );

      // Викладач А бачить лише свої файли
      const t88FilesA = await (await fetch(base + "/api/materials/files", {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      })).json();
      check(
        "Issue #88: викладач А бачить лише власні файли",
        t88FilesA.files.every((f) => f.owner === t88TeacherA.id) &&
          t88FilesA.files.some((f) => f.id === t88FileA.id) &&
          !t88FilesA.files.some((f) => f.id === t88FileB.id)
      );

      // Викладач А не може доступитися до файлу викладача Б (прямі URL)
      const t88RawB = await fetch(base + "/files/" + encodeURIComponent(t88FileB.id), {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      });
      const t88SlidesB = await fetch(base + "/slides/" + encodeURIComponent(t88FileB.id) + "/1", {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      });
      check(
        "Issue #88: викладач А не читає чужі оригінали та слайди",
        (t88RawB.status === 403 || t88RawB.status === 404) &&
          (t88SlidesB.status === 403 || t88SlidesB.status === 404),
        `raw=${t88RawB.status}, slides=${t88SlidesB.status}`
      );

      // Викладач А не може змінити/приховати/видалити чужій файл
      const t88RenameB = await fetch(base + "/api/materials/file/rename", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ file: t88FileB.id, name: "Хаker.pdf" })
      });
      const t88HideB = await fetch(base + "/api/materials/file/toggle-hide", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ file: t88FileB.id, hidden: true })
      });
      const t88DelB = await fetch(base + "/api/materials/file/delete", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ file: t88FileB.id })
      });
      check(
        "Issue #88: викладач А не може змінити/приховати/видалити чужій файл",
        t88RenameB.status === 403 && t88HideB.status === 403 && t88DelB.status === 403
      );
      // Викладач А може скопіювати файл викладача Б у свій простір
      const t88CopyResp = await fetch(base + "/api/materials/copy", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ sourceFileId: t88FileB.id, targetFolderId: null })
      });
      let t88Copy = null;
      try { t88Copy = await t88CopyResp.json(); } catch { /* не JSON */ }
      const t88CopyId = t88Copy && t88Copy.file ? t88Copy.file.id : "";
      check(
        "Issue #88: копіювання чужого файлу у власну папку — новий ID",
        t88CopyResp.status === 201 &&
          Boolean(t88CopyId) &&
          t88CopyId !== t88FileB.id &&
          t88Copy.file.owner === t88TeacherA.id,
        `status=${t88CopyResp.status}`
      );
      // Issue #88 (рев'ю): конвертація копії завершується ПІД ЧАС копіювання —
      // стан у відповіді готовий, а не завислий "converting"/"pending"
      check(
        "Issue #88 (рев'ю): відповідь копіювання PDF містить готовий стан конвертації",
        t88CopyResp.status === 201 && Boolean(t88Copy) &&
          t88Copy.file.conversionStatus === "ready",
        `conversion=${t88Copy && t88Copy.file && t88Copy.file.conversionStatus}`
      );

      // Копія має власні метадані/слайди, незалежні від оригіналу
      await new Promise(resolve => setTimeout(resolve, 1500));
      const t88CopyInfoResp = await fetch(base + "/api/slides/info?file=" + encodeURIComponent(t88CopyId), {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      });
      let t88CopyInfo = null;
      try { t88CopyInfo = await t88CopyInfoResp.json(); } catch { /* не JSON */ }
      check(
        "Issue #88: копія має власні слайди/метадані, незалежні від оригіналу",
        t88CopyInfoResp.status === 200 && Boolean(t88CopyInfo) &&
          t88CopyInfo.ready === true &&
          Number.isInteger(t88CopyInfo.pageCount) && t88CopyInfo.pageCount >= 1,
        `status=${t88CopyInfoResp.status}, ready=${t88CopyInfo && t88CopyInfo.ready}, pages=${t88CopyInfo && t88CopyInfo.pageCount}`
      );
      // Issue #88 (рев'ю): фізичні докази — власний manifest і PNG копії на
      // диску, а також реальний HTTP-шлях віддачі сторінки
      {
        const t88FsCopy = require("node:fs");
        const t88PathCopy = require("node:path");
        const t88CopyDir = t88PathCopy.join(__dirname, "materials", ".slides", t88CopyId);
        const t88CopySrcDir = t88PathCopy.join(__dirname, "materials", ".slides", t88FileB.id);
        const t88PngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const t88CopyPng = t88PathCopy.join(t88CopyDir, "page-1.png");
        const t88CopyPngOnDisk = t88FsCopy.existsSync(t88PathCopy.join(t88CopyDir, "manifest.json")) &&
          t88FsCopy.existsSync(t88CopyPng) &&
          t88FsCopy.readFileSync(t88CopyPng).subarray(0, 8).equals(t88PngMagic);
        const t88CopyPngHttp = await fetch(base + "/slides/" + encodeURIComponent(t88CopyId) + "/1", {
          headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
        });
        const t88CopyPngBytes = Buffer.from(await t88CopyPngHttp.arrayBuffer());
        check(
          "Issue #88 (рев'ю): копія PDF має власний manifest і PNG (диск + HTTP), теки джерела й копії різні",
          t88CopyDir !== t88CopySrcDir && t88CopyPngOnDisk &&
            t88CopyPngHttp.status === 200 && t88CopyPngBytes.length > 8 &&
            t88CopyPngBytes.subarray(0, 8).equals(t88PngMagic),
          `dirOk=${t88CopyDir !== t88CopySrcDir}, disk=${t88CopyPngOnDisk}, http=${t88CopyPngHttp.status}`
        );
      }

      // Зміна оригіналу (приховати) не впливає на копію
      await fetch(base + "/api/materials/file/toggle-hide", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginB.cookie, t88PinB, t88TeacherB.id),
        body: JSON.stringify({ file: t88FileB.id, hidden: true })
      });
      const t88CopyInfo2Resp = await fetch(base + "/api/slides/info?file=" + encodeURIComponent(t88CopyId), {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      });
      let t88CopyInfo2 = null;
      try { t88CopyInfo2 = await t88CopyInfo2Resp.json(); } catch { /* не JSON */ }
      check(
        "Issue #88: зміна оригіналу не впливає на копію",
        t88CopyInfo2Resp.status === 200 &&
          Boolean(t88CopyInfo2) && t88CopyInfo2.ready === true,
        `status=${t88CopyInfo2Resp.status}, ready=${t88CopyInfo2 && t88CopyInfo2.ready}`
      );

      // === Issue #88 (рев'ю): копія PPTX — реальний шлях конвертації ===
      // Фікстура — справжній PPTX, створений PowerPoint (test/fixtures/test.pptx,
      // 2 слайди). Копія конвертується ПІД ЧАС /api/materials/copy і має власний
      // manifest/PNG, незалежні від джерела; конвертація йде тим самим реальним
      // шляхом (PowerPoint COM), що й для завантаженого файлу, — моків немає.
      let t88PptxSrcId = "";
      let t88PptxCopyId = "";
      {
        const t88FsPptx = require("node:fs");
        const t88PathPptx = require("node:path");
        const t88PptxFixture = t88PathPptx.join(__dirname, "test", "fixtures", "test.pptx");
        check(
          "Issue #88 (рев'ю): фікстура PPTX наявна у test/fixtures",
          t88FsPptx.existsSync(t88PptxFixture) && t88FsPptx.statSync(t88PptxFixture).size > 1000
        );

        const t88PptxUpResp = await fetch(
          base + "/api/materials/upload?name=" + encodeURIComponent("Issue88 тест.pptx"),
          {
            method: "POST",
            headers: t88UploadHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
            body: t88FsPptx.readFileSync(t88PptxFixture)
          }
        );
        const t88PptxUp = t88PptxUpResp.status === 201 ? await t88PptxUpResp.json() : null;
        t88PptxSrcId = t88PptxUp && t88PptxUp.id ? t88PptxUp.id : "";
        check(
          "Issue #88 (рев'ю): PPTX завантажено у простір викладача",
          Boolean(t88PptxSrcId), `status=${t88PptxUpResp.status}`
        );

        // Чекаємо конвертацію джерела (фонову), щоб не тримати дві сесії
        // PowerPoint COM паралельно; сама перевірка копії від неї незалежна
        let t88PptxSrcReady = false;
        for (let i = 0; i < 60 && !t88PptxSrcReady; i++) {
          const srcInfo = await (await fetch(base + "/api/slides/info?file=" + encodeURIComponent(t88PptxSrcId), {
            headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
          })).json().catch(() => null);
          if (srcInfo && srcInfo.ready) { t88PptxSrcReady = true; break; }
          if (srcInfo && srcInfo.failed) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        check(
          "Issue #88 (рев'ю): джерело PPTX сконвертовано реальним шляхом (PowerPoint COM)",
          t88PptxSrcReady, "srcId=" + t88PptxSrcId
        );

        const t88PptxCopyResp = await fetch(base + "/api/materials/copy", {
          method: "POST",
          headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
          body: JSON.stringify({ sourceFileId: t88PptxSrcId, targetFolderId: null })
        });
        const t88PptxCopy = t88PptxCopyResp.status === 201 ? await t88PptxCopyResp.json() : null;
        t88PptxCopyId = t88PptxCopy && t88PptxCopy.file ? t88PptxCopy.file.id : "";
        check(
          "Issue #88 (рев'ю): копія PPTX конвертується під час копіювання → conversionStatus ready",
          t88PptxCopyResp.status === 201 && Boolean(t88PptxCopyId) &&
            t88PptxCopyId !== t88PptxSrcId &&
            t88PptxCopy.file.conversionStatus === "ready",
          `status=${t88PptxCopyResp.status}, conversion=${t88PptxCopy && t88PptxCopy.file && t88PptxCopy.file.conversionStatus}`
        );

        const t88PptxInfoResp = await fetch(base + "/api/slides/info?file=" + encodeURIComponent(t88PptxCopyId), {
          headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
        });
        const t88PptxInfo = await t88PptxInfoResp.json().catch(() => null);
        const t88PptxCopyDir = t88PathPptx.join(__dirname, "materials", ".slides", t88PptxCopyId);
        const t88PngMagicPptx = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const t88PptxPngPath = t88PathPptx.join(t88PptxCopyDir, "page-1.png");
        const t88PptxDiskOk = t88FsPptx.existsSync(t88PathPptx.join(t88PptxCopyDir, "manifest.json")) &&
          t88FsPptx.existsSync(t88PptxPngPath) &&
          t88FsPptx.readFileSync(t88PptxPngPath).subarray(0, 8).equals(t88PngMagicPptx);
        check(
          "Issue #88 (рев'ю): копія PPTX — ready, pageCount ≥ 2, власний manifest і PNG на диску",
          t88PptxInfoResp.status === 200 && Boolean(t88PptxInfo) &&
            t88PptxInfo.ready === true &&
            Number.isInteger(t88PptxInfo.pageCount) && t88PptxInfo.pageCount >= 2 &&
            t88PptxDiskOk,
          `status=${t88PptxInfoResp.status}, ready=${t88PptxInfo && t88PptxInfo.ready}, pages=${t88PptxInfo && t88PptxInfo.pageCount}, disk=${t88PptxDiskOk}`
        );

        const t88PptxPngHttp = await fetch(base + "/slides/" + encodeURIComponent(t88PptxCopyId) + "/1", {
          headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
        });
        const t88PptxPngBytes = Buffer.from(await t88PptxPngHttp.arrayBuffer());
        check(
          "Issue #88 (рев'ю): сторінка1 копії PPTX віддається через HTTP (справжній PNG)",
          t88PptxPngHttp.status === 200 && t88PptxPngBytes.length > 8 &&
            t88PptxPngBytes.subarray(0, 8).equals(t88PngMagicPptx),
          `status=${t88PptxPngHttp.status}`
        );
      }

      // Адмін бачить і керує всіма просторами (включно з orphaned owner ID)
      const t88AdminTree = await (await fetch(base + "/api/materials/admin/tree", {
        headers: t88AdminHeaders
      })).json();
      check(
        "Issue #88: адмін бачить усі простори та файли",
        t88AdminTree.files &&
          Object.values(t88AdminTree.files).some((f) => f.owner === t88TeacherA.id) &&
          Object.values(t88AdminTree.files).some((f) => f.owner === t88TeacherB.id)
      );

      // Учнівський каталог — плоский, агрегує публічні/готові матеріали з усіх просторів
      const t88StudentLogin = await studentLogin(base, "Issue88 Учень");
      const t88StudentFiles = await (await fetch(base + "/api/files", {
        headers: sess()
      })).json();
      check(
        "Issue #88: учнівський каталог — плоский, без прихованих/неготових",
        Array.isArray(t88StudentFiles) &&
          !t88StudentFiles.some((f) => f.hidden) &&
          t88StudentFiles.every((f) => !f.conversionStatus || f.conversionStatus === "ready")
      );

      // === Повний доступ адміністратора до всіх просторів ===
      // Адмін-PIN: дерево й файли чужого простору за ?teacherId=
      const t88AdminTreeA = await (await fetch(base + "/api/materials/tree?teacherId=" + t88TeacherA.id, {
        headers: t88AdminHeaders
      })).json();
      const t88AdminFilesA = await (await fetch(base + "/api/materials/files?teacherId=" + t88TeacherA.id, {
        headers: t88AdminHeaders
      })).json();
      check(
        "Issue #88: адмін відкриває дерево й файли чужого простору",
        Array.isArray(t88AdminTreeA.tree) && t88AdminTreeA.tree.length >= 1 &&
          Array.isArray(t88AdminFilesA.files) && t88AdminFilesA.files.some((f) => f.id === t88FileA.id),
        JSON.stringify({ tree: (t88AdminTreeA.tree || []).length, files: (t88AdminFilesA.files || []).length })
      );

      // Адмін перейменовує чужий файл і завантажує файл у чужий простір
      const t88AdminRenameB = await fetch(base + "/api/materials/file/rename", {
        method: "POST",
        headers: t88AdminHeaders,
        body: JSON.stringify({ file: t88FileB.id, name: "АдмінПерейменував.pdf" })
      });
      // Без Content-Type: тіло — бінарне (як у t88UploadHeaders)
      const t88AdminUploadResp = await fetch(
        base + "/api/materials/upload?name=" + encodeURIComponent("АдмінФайл.pdf") +
          "&teacherId=" + t88TeacherA.id,
        { method: "POST", headers: { "X-Portal-Pin": PIN }, body: TINY_PDF_BODY }
      );
      let t88AdminUploadFile = null;
      try { t88AdminUploadFile = await t88AdminUploadResp.json(); } catch { /* не JSON */ }
      check(
        "Issue #88: адмін перейменовує чужий файл і завантажує у чужий простір",
        t88AdminRenameB.status === 200 && t88AdminUploadResp.status === 201 &&
          Boolean(t88AdminUploadFile) && t88AdminUploadFile.owner === t88TeacherA.id,
        `rename=${t88AdminRenameB.status}, upload=${t88AdminUploadResp.status}`
      );

      // Викладач не може відкрити чужий простір через ?teacherId= —
      // teacherId береться лише з сесії, параметр ігнорується
      const t88TeacherFilesSpoof = await (await fetch(base + "/api/materials/files?teacherId=" + t88TeacherB.id, {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      })).json();
      check(
        "Issue #88: викладач не відкриває чужий простір через ?teacherId",
        Array.isArray(t88TeacherFilesSpoof.files) &&
          t88TeacherFilesSpoof.files.every((f) => f.owner === t88TeacherA.id) &&
          !t88TeacherFilesSpoof.files.some((f) => f.id === t88FileB.id),
        JSON.stringify((t88TeacherFilesSpoof.files || []).map((f) => f.owner))
      );

      // === Сумісність просторів з чинними API (Issue #85/#63) ===
      // Конвертація слайдів: раніше slideService шукав джерело лише в корені
      // materials/, і файл простору давав «Файл не знайдено» (conversionStatus
      // = failed) — учні не могли відкрити матеріал.
      const t88PrepareResp = await fetch(base + "/api/slides/prepare", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ file: t88FileA.id })
      });
      let t88Prepare = null;
      try { t88Prepare = await t88PrepareResp.json(); } catch { /* не JSON */ }
      check(
        "Issue #88: конвертація слайдів файлу простору → маніфест",
        t88PrepareResp.status === 200 && Boolean(t88Prepare) &&
          Number.isInteger(t88Prepare.pageCount) && t88Prepare.pageCount >= 1,
        `status=${t88PrepareResp.status}, pages=${t88Prepare && t88Prepare.pageCount}`
      );

      // === Issue #88 (рев'ю): /api/slides/prepare — перевірка власника ===
      // Обов'язковий тест рев'ю: викладач А шле ID файла Б → 403, і стан, і
      // manifest, і PNG файла Б залишаються незмінними (жодного setConversion-
      // Status/ensureSlides до перевірки власника — відповідь іде перед ними).
      {
        const t88FsPrep = require("node:fs");
        const t88PathPrep = require("node:path");
        const snapPrep = (id) => {
          const dir = t88PathPrep.join(__dirname, "materials", ".slides", id);
          try {
            return t88FsPrep.readdirSync(dir).sort().map(f => {
              const st = t88FsPrep.statSync(t88PathPrep.join(dir, f));
              return f + "|" + st.mtimeMs + "|" + st.size;
            }).join(";");
          } catch { return null; }
        };
        const infoPrep = async (headers, id) => {
          const resp = await fetch(base + "/api/slides/info?file=" + encodeURIComponent(id), { headers });
          return { status: resp.status, body: await resp.json().catch(() => null) };
        };
        const aPrepHeaders = t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id);
        const bPrepHeaders = t88AuthHeaders(t88LoginB.cookie, t88PinB, t88TeacherB.id);

        const bInfoBefore = await infoPrep(bPrepHeaders, t88FileB.id);
        const bSlidesBefore = snapPrep(t88FileB.id);
        const prepareBCross = await fetch(base + "/api/slides/prepare", {
          method: "POST",
          headers: aPrepHeaders,
          body: JSON.stringify({ file: t88FileB.id })
        });
        const bInfoAfter = await infoPrep(bPrepHeaders, t88FileB.id);
        const bSlidesAfter = snapPrep(t88FileB.id);
        check(
          "Issue #88 (рев'ю): викладач А шле prepare чужого файла Б → 403, стан/manifest/PNG Б незмінні",
          prepareBCross.status === 403 &&
            bInfoBefore.status === 200 && bInfoAfter.status === 200 &&
            JSON.stringify(bInfoBefore.body) === JSON.stringify(bInfoAfter.body) &&
            JSON.stringify(bSlidesBefore) === JSON.stringify(bSlidesAfter),
          `status=${prepareBCross.status}`
        );

        // Спільний/legacy-файл (owner === null): викладач не конвертує й не
        // змінює стан — копіювання окремо дозволене, prepare тут закритий
        const legacyBefore = await infoPrep(aPrepHeaders, fileId);
        const legacySlidesBefore = snapPrep(fileId);
        const prepareLegacy = await fetch(base + "/api/slides/prepare", {
          method: "POST",
          headers: aPrepHeaders,
          body: JSON.stringify({ file: fileId })
        });
        const legacyAfter = await infoPrep(aPrepHeaders, fileId);
        const legacySlidesAfter = snapPrep(fileId);
        check(
          "Issue #88 (рев'ю): prepare спільного/legacy-файлу викладачем → 403, стан незмінний",
          prepareLegacy.status === 403 &&
            legacyBefore.status === 200 && legacyAfter.status === 200 &&
            JSON.stringify(legacyBefore.body) === JSON.stringify(legacyAfter.body) &&
            JSON.stringify(legacySlidesBefore) === JSON.stringify(legacySlidesAfter),
          `status=${prepareLegacy.status}`
        );

        // Власний файл А: той самий маршрут готується нормально
        const prepareOwn = await fetch(base + "/api/slides/prepare", {
          method: "POST",
          headers: aPrepHeaders,
          body: JSON.stringify({ file: t88FileA.id })
        });
        const prepareOwnBody = await prepareOwn.json().catch(() => null);
        check(
          "Issue #88 (рев'ю): викладач А готує ВЛАСНИЙ файл → 200 з маніфестом",
          prepareOwn.status === 200 && Boolean(prepareOwnBody) &&
            Number.isInteger(prepareOwnBody.pageCount) && prepareOwnBody.pageCount >= 1,
          `status=${prepareOwn.status}`
        );

        // Адміністратор має повний доступ до чужого файла (окремий випадок)
        const prepareAdminB = await fetch(base + "/api/slides/prepare", {
          method: "POST",
          headers: t88AdminHeaders,
          body: JSON.stringify({ file: t88FileB.id })
        });
        const prepareAdminBBody = await prepareAdminB.json().catch(() => null);
        check(
          "Issue #88 (рев'ю): адміністратор готує чужий файл → 200 з маніфестом",
          prepareAdminB.status === 200 && Boolean(prepareAdminBBody) &&
            Number.isInteger(prepareAdminBBody.pageCount) && prepareAdminBBody.pageCount >= 1,
          `status=${prepareAdminB.status}, pages=${prepareAdminBBody && prepareAdminBBody.pageCount}`
        );

        // Обхід, який закрито: персональний PIN БЕЗ cookie раніше давав
        // адмін-доступ до старих маршрутів (teacherIdFromSession → null) —
        // тепер 401, і жодна зміна стану/назви не відбувається
        const bypassHeaders = {
          "Content-Type": "application/json",
          "X-Portal-Pin": t88PinB,
          "X-Portal-Teacher": t88TeacherB.id
        };
        const bypassPrepare = await fetch(base + "/api/slides/prepare", {
          method: "POST",
          headers: bypassHeaders,
          body: JSON.stringify({ file: t88FileB.id })
        });
        const bypassRename = await fetch(base + "/api/files/rename", {
          method: "POST",
          headers: bypassHeaders,
          body: JSON.stringify({ file: t88FileB.id, name: "ОбхідСесії.pdf" })
        });
        const bTreeAfterBypass = await (await fetch(base + "/api/materials/admin/tree", {
          headers: t88AdminHeaders
        })).json();
        const bRecordAfterBypass = (bTreeAfterBypass.files || {})[t88FileB.id];
        check(
          "Issue #88 (рев'ю): персональний PIN без cookie → 401 у старих маршрутах, файл Б незмінний",
          bypassPrepare.status === 401 && bypassRename.status === 401 &&
            Boolean(bRecordAfterBypass) &&
            bRecordAfterBypass.originalName === "АдмінПерейменував.pdf",
          `prepare=${bypassPrepare.status}, rename=${bypassRename.status}, name=${bRecordAfterBypass && bRecordAfterBypass.originalName}`
        );
      }

      // Каталог викладача (/api/files): файли власного простору видимі
      const t88TeacherCatalog = await (await fetch(base + "/api/files", {
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
      })).json();
      check(
        "Issue #88: каталог викладача містить файли його простору",
        Array.isArray(t88TeacherCatalog) &&
          t88TeacherCatalog.some((f) => f.id === t88FileA.id) &&
          t88TeacherCatalog.every((f) => f.owner === t88TeacherA.id || f.owner === null),
        JSON.stringify((Array.isArray(t88TeacherCatalog) ? t88TeacherCatalog : []).map((f) => f.id))
      );

      // Учнівський каталог: готовий файл простору доступний для перегляду
      const t88StudentSpace = await (await fetch(base + "/api/files", { headers: sess() })).json();
      check(
        "Issue #88: учнівський каталог містить готовий файл простору",
        Array.isArray(t88StudentSpace) && t88StudentSpace.some((f) => f.id === t88FileA.id),
        JSON.stringify((Array.isArray(t88StudentSpace) ? t88StudentSpace : []).map((f) => f.id))
      );

      // Старт демонстрації з файлу простору: stateService раніше перевіряв
      // наявність файла лише в корені → 404 «Файл не знайдено»
      const t88DemoStart = await fetch(base + "/api/control", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ file: t88FileA.id })
      });
      let t88DemoState = null;
      try {
        t88DemoState = await (await fetch(base + "/api/state", {
          headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)
        })).json();
      } catch { /* не JSON */ }
      check(
        "Issue #88: старт демонстрації з файлу простору",
        t88DemoStart.status === 200 && Boolean(t88DemoState) && t88DemoState.file === t88FileA.id,
        `start=${t88DemoStart.status}, file=${t88DemoState && t88DemoState.file}`
      );
      // Зупинка показу, щоб не впливати на подальші тести
      await fetch(base + "/api/control", {
        method: "POST",
        headers: t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id),
        body: JSON.stringify({ stop: true })
      });

      // Прямі URL оригіналів і слайдів не обходять авторизацію (без сесії)
      const t88NoSessionRaw = await fetch(base + "/files/" + encodeURIComponent(t88FileA.id));
      const t88NoSessionSlides = await fetch(base + "/slides/" + encodeURIComponent(t88FileA.id) + "/1");
      check(
        "Issue #88: прямі URL без сесії — 401",
        t88NoSessionRaw.status === 401 && t88NoSessionSlides.status === 401
      );

      // === Issue #88 (уточнення Tech-lead): адмін має повний доступ
      // до медіа ВСІХ викладачів; ізоляція звичайних викладачів лишається ===
      const t88AdminMediaLogin = await t88Verify(PIN);
      const t88AdminPinHdrs = { "Content-Type": "application/json", "X-Portal-Pin": PIN };
      const t88AdminSessHdrs = {
        "Content-Type": "application/json",
        Cookie: "ly_session=" + t88AdminMediaLogin.cookie
      };
      const t88MediaStatus = async (headers, url) => (await fetch(base + url, { headers })).status;
      const t88MediaTrio = async (headers, id) => {
        const enc = encodeURIComponent(id);
        return [
          await t88MediaStatus(headers, "/files/" + enc),
          await t88MediaStatus(headers, "/slides/" + enc + "/1"),
          await t88MediaStatus(headers, "/api/slides/info?file=" + enc)
        ].join("/");
      };
      check(
        "Issue #88 (Tech-lead): сесія за PORTAL_PIN має admin=true",
        t88AdminMediaLogin.status === 200 && Boolean(t88AdminMediaLogin.data) &&
          t88AdminMediaLogin.data.admin === true && t88AdminMediaLogin.data.role === "teacher",
        `status=${t88AdminMediaLogin.status}`
      );

      const t88AdminForeignPin = await t88MediaTrio(t88AdminPinHdrs, t88FileB.id);
      const t88AdminForeignSess = await t88MediaTrio(t88AdminSessHdrs, t88FileB.id);
      const t88AdminOwnA = await t88MediaTrio(t88AdminPinHdrs, t88FileA.id);
      const t88AdminShared = await t88MediaTrio(t88AdminPinHdrs, fileId);
      check(
        "Issue #88 (Tech-lead): адмін бачить медіа чужого викладача (файл/слайд/стан) — за PIN і за сесією",
        t88AdminForeignPin === "200/200/200" && t88AdminForeignSess === "200/200/200",
        `pin=${t88AdminForeignPin}, session=${t88AdminForeignSess}`
      );
      check(
        "Issue #88 (Tech-lead): адмін бачить медіа власника та спільного/legacy-файлу",
        t88AdminOwnA === "200/200/200" && t88AdminShared === "200/200/200",
        `ownA=${t88AdminOwnA}, shared=${t88AdminShared}`
      );

      const t88BB = t88AuthHeaders(t88LoginB.cookie, t88PinB, t88TeacherB.id);
      const t88TeacherBFar = await t88MediaTrio(t88BB, t88FileA.id);
      const t88TeacherBOwn = await t88MediaTrio(t88BB, t88FileB.id);
      const t88TeacherBShared = await t88MediaTrio(t88BB, fileId);
      check(
        "Issue #88 (Tech-lead): звичайний викладач лишається ізольованим від чужого простору",
        t88TeacherBFar === "404/404/404",
        `foreign=${t88TeacherBFar}`
      );
      check(
        "Issue #88 (Tech-lead): звичайний викладач бачить власні та спільні медіа",
        t88TeacherBOwn === "200/200/200" && t88TeacherBShared === "200/200/200",
        `own=${t88TeacherBOwn}, shared=${t88TeacherBShared}`
      );

      // Підміна teacherId у тілі не дає доступу до чужого простору
      const t88Spoof = await fetch(base + "/api/materials/file/delete", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json", "X-Portal-Pin": "2222" }, t88AuthHeaders(t88LoginA.cookie, t88PinA, t88TeacherA.id)),
        body: JSON.stringify({ file: t88FileB.id, teacherId: t88TeacherB.id })
      });
      check(
        "Issue #88: підміна teacherId у тілі не дає доступу до чужого простору",
        t88Spoof.status === 403
      );

      // Видалення облікового запису не видаляє його файли
      await fetch(base + "/api/teachers/delete", {
        method: "POST",
        headers: t88AdminHeaders,
        body: JSON.stringify({ id: t88TeacherA.id, confirm: true })
      });
      const t88FilesAfterDel = await (await fetch(base + "/api/materials/admin/tree", {
        headers: t88AdminHeaders
      })).json();
      check(
        "Issue #88: видалення облікового запису не видаляє його файли",
        Object.values(t88FilesAfterDel.files || {}).some((f) => f.owner === t88TeacherA.id)
      );

      // Прибирання: файл викладача Б і сам обліковий запис Б
      try {
        await fetch(base + "/api/materials/file/delete", {
          method: "POST",
          headers: t88AuthHeaders(t88LoginB.cookie, t88PinB, t88TeacherB.id),
          body: JSON.stringify({ file: t88FileB.id })
        });
      } catch { /* прибирання не валить тест */ }
      await fetch(base + "/api/teachers/delete", {
        method: "POST",
        headers: t88AdminHeaders,
        body: JSON.stringify({ id: t88TeacherB.id, confirm: true })
      });

      // Обліковий запис А видалено вище (саме це і перевіряє вище — «файли
      // після видалення акаунта зберігаються»), його сесію скасовано. Тому
      // прибирання виконує адміністратор — повний доступ до всіх просторів,
      // включно з осиротілим (власника вже немає). Це водночас перевіряє
      // адмін-доступ: спочатку файли, потім порожні папки.
      const t88AdminCleanupFiles = [];
      for (const id of [t88FolderFileId, t88FileA.id, t88CopyId, t88AdminUploadFile && t88AdminUploadFile.id, t88PptxSrcId, t88PptxCopyId].filter(Boolean)) {
        try {
          const resp = await fetch(base + "/api/materials/file/delete", {
            method: "POST",
            headers: t88AdminHeaders,
            body: JSON.stringify({ file: id })
          });
          t88AdminCleanupFiles.push(resp.status);
        } catch { t88AdminCleanupFiles.push(0); }
      }
      // Порожні папки: спочатку дочірня, потім батьківська
      const t88AdminCleanupFolders = [];
      for (const id of [t88FolderAChildId, t88FolderAId].filter(Boolean)) {
        try {
          const resp = await fetch(base + "/api/materials/folder/delete", {
            method: "POST",
            headers: t88AdminHeaders,
            body: JSON.stringify({ folderId: id })
          });
          t88AdminCleanupFolders.push(resp.status);
        } catch { t88AdminCleanupFolders.push(0); }
      }
      check(
        "Issue #88: адмін прибирає осиротілий простір (файли й папки)",
        t88AdminCleanupFiles.length > 0 && t88AdminCleanupFiles.every((s) => s === 200) &&
          t88AdminCleanupFolders.length > 0 && t88AdminCleanupFolders.every((s) => s === 200),
        JSON.stringify({ files: t88AdminCleanupFiles, folders: t88AdminCleanupFolders })
      );

      // Порожні директорії просторів тестових викладачів прибираємо з диска
      // (саме їх створив цей тест; метадані вже очищено адмін-операціями вище)
      try {
        const t88Fs = require("node:fs");
        const t88PathMod = require("node:path");
        for (const id of [t88TeacherA.id, t88TeacherB.id]) {
          t88Fs.rmSync(t88PathMod.join(__dirname, "materials", id), { recursive: true, force: true });
        }
      } catch { /* прибирання не валить тест */ }

      // === Issue #88 §4: Вихід (logout) ===
      // Вихід адміністратора зі сторінки /teachers
      const t88AdminLogin = await t88Verify(PIN, { "X-Portal-Pin": PIN });
      const t88AdminCookie = t88AdminLogin.cookie;
      // Перевіряємо, що адміністративний PIN дає сесію з access admin
      check("Issue #88: вхід адміністратора дає admin сесію", t88AdminLogin.status === 200 && t88AdminLogin.data && t88AdminLogin.data.admin === true);
      const t88AdminLogout = await fetch(base + "/api/auth/logout", {
        method: "POST",
        headers: { ...t88AdminHeaders, Cookie: "ly_session=" + t88AdminCookie }
      });
      check("Issue #88: вихід адміністратора — сесія скасована", t88AdminLogout.status === 200);
      // Старий cookie не дає доступу після виходу
      const t88AdminAfterLogout = await fetch(base + "/api/teachers", {
        headers: { Cookie: "ly_session=" + t88AdminCookie }
      });
      check("Issue #88: старий cookie адміністратора після виходу — 401", t88AdminAfterLogout.status === 401);
      // Повідомлення сервера не кешує сторінку після виходу
      check(
        "Issue #88: відповідь logout без кешування",
        (t88AdminLogout.headers.get("Cache-Control") || "").includes("no-store")
      );

      // Вихід викладача з ПЕРСОНАЛЬНИМ PIN — реальна сесія (записи А/Б уже
      // видалені вище; без окремого запису перевірка була б формальною з
      // порожнім cookie). Після виходу старий cookie відхиляється (401).
      const t88PinLogout = String(1000 + Math.floor(Math.random() * 9000));
      const t88LogoutTeacher = await (await fetch(base + "/api/teachers/create", {
        method: "POST",
        headers: t88AdminHeaders,
        body: JSON.stringify({
          fullName: "Issue88 Вихід Тест",
          pin: t88PinLogout,
          permissions: ["demo", "materials"]
        })
      })).json();
      const t88TeacherLogin = await t88Verify(t88PinLogout);
      const t88TeacherCookie = t88TeacherLogin.cookie;
      check(
        "Issue #88: вхід викладача з персональним PIN дає чинну сесію",
        Boolean(t88LogoutTeacher && t88LogoutTeacher.teacher) &&
          t88TeacherLogin.status === 200 && Boolean(t88TeacherCookie),
        `status=${t88TeacherLogin.status}`
      );
      const t88TeacherLogout = await fetch(base + "/api/auth/logout", {
        method: "POST",
        headers: { Cookie: "ly_session=" + t88TeacherCookie }
      });
      check(
        "Issue #88: вихід викладача — сесія скасована",
        t88TeacherLogout.status === 200
      );
      const t88TeacherAfterLogout = await fetch(base + "/api/state", {
        headers: { Cookie: "ly_session=" + t88TeacherCookie }
      });
      check(
        "Issue #88: старий cookie викладача після виходу — 401",
        t88TeacherAfterLogout.status === 401
      );
      await fetch(base + "/api/teachers/delete", {
        method: "POST",
        headers: t88AdminHeaders,
        body: JSON.stringify({
          id: t88LogoutTeacher && t88LogoutTeacher.teacher ? t88LogoutTeacher.teacher.id : "",
          confirm: true
        })
      });

      // Issue #88 (рев'ю): logout знімає cookie З ТИМИ САМИМИ атрибутами, що
      // й видача (Path/HttpOnly/SameSite=Strict), із терміном дії в минулому —
      // інакше браузер не видалив би пару HttpOnly-сесійної cookie
      const t88SetCookie = t88AdminLogout.headers.get("set-cookie") || "";
      check(
        "Issue #88 (рев'ю): logout очищує ly_session (Path/HttpOnly/SameSite=Strict, Expires у минулому)",
        /ly_session=;/.test(t88SetCookie) &&
          /path=\//i.test(t88SetCookie) &&
          /httponly/i.test(t88SetCookie) &&
          /samesite=strict/i.test(t88SetCookie) &&
          /expires=thu,\s*01 jan 1970/i.test(t88SetCookie),
        t88SetCookie
      );

      // Issue #88 (рев'ю): усі HTML-сторінки віддаються без кешування — після
      // виходу back/reload не відкриває захищений вміст із кешу браузера.
      // Серверні перевірки сесії збережено: /teachers без входу → 403, з
      // адмін-сесією → 200.
      const t88HtmlCache = [];
      for (const p of ["/materials", "/upload", "/demonstration", "/students"]) {
        const resp = await fetch(base + p, { redirect: "manual" });
        t88HtmlCache.push({ p, status: resp.status, cc: resp.headers.get("cache-control") || "" });
      }
      const t88TeachersNoSession = await fetch(base + "/teachers");
      const t88AdminLogin2 = await t88Verify(PIN);
      const t88TeachersAdmin = await fetch(base + "/teachers", {
        headers: { Cookie: "ly_session=" + (t88AdminLogin2.cookie || "") }
      });
      await fetch(base + "/api/auth/logout", {
        method: "POST",
        headers: { Cookie: "ly_session=" + (t88AdminLogin2.cookie || "") }
      });
      check(
        "Issue #88 (рев'ю): HTML-сторінки — Cache-Control no-store; /teachers: без сесії 403, адміну 200",
        t88HtmlCache.every(x => x.cc.includes("no-store")) &&
          t88TeachersNoSession.status === 403 &&
          t88TeachersAdmin.status === 200,
        JSON.stringify({
          pages: t88HtmlCache.map(x => x.p + ":" + x.status + ":" + x.cc),
          noSession: t88TeachersNoSession.status,
          admin: t88TeachersAdmin.status
        })
      );

      // Вхід викладача — перевіряємо відображення Прізвище І.П.
      // Створимо викладача з ПІБ, потім входимо його власним PIN
      const t88PinName = String(1000 + Math.floor(Math.random() * 9000));
      const t88NameTeacher = await (await fetch(base + "/api/teachers/create", {
        method: "POST",
        headers: t88AdminHeaders,
        body: JSON.stringify({ fullName: "Шевченко Тарас Миколайович", pin: t88PinName, permissions: ["demo", "materials"] })
      })).json();
      const t88NameLogin = await t88Verify(t88PinName);
      check(
        "Issue #88: вхід викладача з ПІБ",
        Boolean(t88NameTeacher && t88NameTeacher.teacher) &&
          t88NameLogin.status === 200 &&
          Boolean(t88NameLogin.data) &&
          t88NameLogin.data.fullName === "Шевченко Тарас Миколайович" &&
          !t88NameLogin.data.admin,
        `status=${t88NameLogin.status}`
      );






      // Прибирання
      await fetch(base + "/api/teachers/delete", {
        method: "POST",
        headers: t88AdminHeaders,
        body: JSON.stringify({ id: t88NameTeacher && t88NameTeacher.teacher ? t88NameTeacher.teacher.id : "", confirm: true })
      });

      // Issue #63: автозупинка демонстрації, коли вчитель пішов. Окремий
      // екземпляр із коротким тайм-аутом присутності — щоб не впливати на
      // інші тести; той самий каталог матеріалів на диску (fileId існує на
      // цьому етапі).
      const WDOG_PORT = PORT + 2;
      const wdogBase = "http://127.0.0.1:" + WDOG_PORT;
      const wdog = spawn(process.execPath, ["server.js"], {
        env: {
          ...process.env,
          PORT: String(WDOG_PORT),
          PORTAL_PIN: PIN,
          TEACHER_PRESENCE_TIMEOUT_MS: "3000"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let wdogLog = "";
      wdog.stdout.on("data", (chunk) => { wdogLog += chunk; });
      wdog.stderr.on("data", (chunk) => { wdogLog += chunk; });
      try {
        const wdogUp = await waitForHealth(wdogBase);
        check("Issue #63: екземпляр сервера для тесту автозупинки запущено", wdogUp, "port=" + WDOG_PORT);
        if (wdogUp) {
          // Issue #63 (Етап 5): на тестовому екземплярі — власна сесія учня
          await studentLogin(wdogBase, "Учень автозупинки");

          // Issue #63 (§3.1): порядок категорій переживає перезапуск сервера —
          // «свіжий» екземпляр читає той самий файл метаданих і повертає той
          // самий перелік у тому самому порядку
          const mainCats = await (await fetch(base + "/api/categories", { headers: { "X-Portal-Pin": PIN } })).json();
          const freshCats = await (await fetch(wdogBase + "/api/categories", { headers: { "X-Portal-Pin": PIN } })).json();
          const mainIds = (mainCats || []).map(category => category.id).join(",");
          const freshIds = (freshCats || []).map(category => category.id).join(",");
          check(
            "Issue #63 §3.1: порядок категорій однаковий на «перезапущеному» екземплярі",
            Array.isArray(mainCats) && Array.isArray(freshCats) && mainIds === freshIds,
            JSON.stringify({ mainIds, freshIds })
          );

          // Старт показу позначає присутність викладача
          r = await fetch(wdogBase + "/api/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 1 })
          });
          let wState = await (await fetch(wdogBase + "/api/state", { headers: sess(wdogBase) })).json();
          check(
            "Issue #63: показ стартує на тестовому екземплярі",
            r.status === 200 && wState.file === fileId,
            `status=${r.status}, file=${wState.file}`
          );

          // Issue #63 (доробка): приховування опублікованого матеріалу ПІД ЧАС
          // активного показу — негайне відкликання медіа (404) і очищення екрану.
          // Каталог учня теж оновлюється (матеріал зникає).
          await fetch(wdogBase + "/api/files/toggle-hide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: PIN, file: fileId, hidden: true })
          });
          const wHiddenSlides = await fetch(`${wdogBase}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess(wdogBase) });
          const wHiddenRaw = await fetch(`${wdogBase}/files/${encodeURIComponent(fileId)}`, { headers: sess(wdogBase) });
          const wHiddenInfo = await fetch(`${wdogBase}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: sess(wdogBase) });
          const wHiddenListRes = await fetch(wdogBase + "/api/files", { headers: sess(wdogBase) });
          const wHiddenList = wHiddenListRes.status === 200 ? await wHiddenListRes.json() : [];
          const wHiddenLeak = wHiddenList.some((f) => f.id === fileId);
          check(
            "Issue #63 (доробка): після приховування активного матеріалу медіа відкликано (404), каталог оновлено",
            wHiddenSlides.status === 404 && wHiddenRaw.status === 404 && wHiddenInfo.status === 404 &&
              wHiddenListRes.status === 200 && !wHiddenLeak,
            `slides=${wHiddenSlides.status}, raw=${wHiddenRaw.status}, info=${wHiddenInfo.status}, cat=${wHiddenListRes.status}, leak=${wHiddenLeak}`
          );

          // Жодного control/heartbeat довше за тайм-аут (3 с) → автозупинка.
          // Перевірка виконується в GET /api/state, який учні опитують саме
          // так, тож тест відтворює реальний шлях відновлення каталогу.
          await delay(3600);
          wState = await (await fetch(wdogBase + "/api/state", { headers: sess(wdogBase) })).json();
          check(
            "Issue #63: без вчителя демонстрація зупиняється автоматично",
            wState.file === "" && wState.revision > 0,
            `file=${JSON.stringify(wState.file)}, rev=${wState.revision}`
          );

          // Issue #63 (доробка): разом зі станом автозупинка відкликає і ДОСТУП
          // до медіа прихованого матеріалу — перевірка виконується на сервері
          // при кожному запиті, тож 404 повертається без дій клієнта
          const wAutoSlides = await fetch(`${wdogBase}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess(wdogBase) });
          const wAutoFiles = await fetch(`${wdogBase}/files/${encodeURIComponent(fileId)}`, { headers: sess(wdogBase) });
          const wAutoInfo = await fetch(`${wdogBase}/api/slides/info?file=${encodeURIComponent(fileId)}`, { headers: sess(wdogBase) });
          check(
            "Issue #63 (доробка): після автозупинки медіа прихованого матеріалу закриті (404 на всіх шляхах)",
            wAutoSlides.status === 404 && wAutoFiles.status === 404 && wAutoInfo.status === 404,
            `slides=${wAutoSlides.status}, files=${wAutoFiles.status}, info=${wAutoInfo.status}`
          );

          // Heartbeat викладача утримує показ активним (2 × 1.8 с < 3 с)
          r = await fetch(wdogBase + "/api/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 1 })
          });
          await delay(1800);
          await fetch(wdogBase + "/api/presence/teacher", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Portal-Pin": PIN },
            body: "{}"
          });
          await delay(1800);
          wState = await (await fetch(wdogBase + "/api/state", { headers: sess(wdogBase) })).json();
          check(
            "Issue #63: heartbeat викладача утримує активний показ",
            r.status === 200 && wState.file === fileId,
            `file=${wState.file}`
          );

          // Повторний старт показу знову відкриває медіа прихованого матеріалу
          // (зворотний бік відкликання); далі — повернення початкового стану
          const wRestartSlides = await fetch(`${wdogBase}/slides/${encodeURIComponent(fileId)}/1`, { headers: sess(wdogBase) });
          check(
            "Issue #63 (доробка): після повторного старту показу медіа прихованого знову відкриті (200)",
            wRestartSlides.status === 200,
            `slides=${wRestartSlides.status}`
          );

          // Прибрати за собою на тестовому екземплярі: показ зупинено, файл
          // повернуто до опублікованого стану (він належить тестовому набору)
          await fetch(wdogBase + "/api/files/toggle-hide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: PIN, file: fileId, hidden: false })
          });
          await fetch(wdogBase + "/api/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: PIN, stop: true })
          });
        }
      } finally {
        wdog.kill();
      }

      // Захист не ослаб: перевірка PIN під час завантаження
      r = await fetch(`${base}/api/upload?name=${encodeURIComponent("E3 без PIN.mp3")}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: TINY_PDF_BODY
      });
      check("Issue #63 Е3: завантаження без PIN → 403", r.status === 403, `status=${r.status}`);

      // 8. Керування трансляцією потребує PIN
      r = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "0000", file: fileId, kind: "slides", page: 1 })
      });
      check("Керування трансляцією: хибний PIN → 403", r.status === 403, `status=${r.status}`);

      // 9. Заборонений тип файлу
      r = await fetch(`${base}/api/upload?name=${encodeURIComponent("virus.txt")}`, {
        method: "POST",
        headers: { "X-Portal-Pin": PIN, "Content-Type": "application/octet-stream" },
        body: Buffer.from("hello")
      });
      check("Завантаження: заборонений тип → 400", r.status === 400, `status=${r.status}`);
    } finally {
      if (e4CategoryId) {
        await fetch(base + "/api/categories/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, categoryId: e4CategoryId })
        }).catch(() => {});
      }
      // Прибирання тестового файлу
      await fetch(`${base}/api/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId })
      }).catch(() => {});
      // Прибирання тестових файлів Етапу 3
      for (const id of e3Ids) {
        await fetch(`${base}/api/files/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN, file: id })
        }).catch(() => {});
      }
    }

    // 10. Issue #1: ліміт спроб PIN — окремий екземпляр з малим лімітом
    const child2 = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: "3996", PORTAL_PIN: PIN, PIN_MAX_ATTEMPTS: "3" },
      stdio: "ignore"
    });
    try {
      if (await waitForHealth("http://127.0.0.1:3996")) {
        const base2 = "http://127.0.0.1:3996";
        const statuses = [];
        for (let i = 0; i < 3; i++) {
          const res = await fetch(base2 + "/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: "9999" })
          });
          statuses.push(res.status);
        }
        const res = await fetch(base2 + "/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN })
        });
        check(
          "Issue #1: після ліміту спроб PIN блокується (429)",
          res.status === 429,
          `спроби: ${statuses.join(",")}; фінальна: ${res.status}`
        );
      } else {
        check("Issue #1: лімітатор спроб (другий екземпляр не стартував)", false);
      }
    } finally {
      child2.kill();
    }

    // 11. Issue #63 (Етап 5): ПЕРЕРЕЗАПУСК сервера анулює всі входи.
    //    Старі cookie викладача й учня відхиляються (401), матеріали та
    //    метадані зберігаються, а після повторного входу права повертаються.
    try {
      const filesBefore = await (await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();
      const catsBefore = await (await fetch(base + "/api/categories", { headers: { "X-Portal-Pin": PIN } })).json();
      const oldTeacherCookie = teacherSession;
      const oldStudentCookie = sessions.get(base) || "";

      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
        setTimeout(resolve, 8000);
      });
      child = startServer();
      const restarted = await waitForHealth(base, 60);
      check("Issue #63 (Етап 5): сервер перезапущено для тесту сесій", restarted, `port=${PORT}`);
      sessions.delete(base);
      teacherSession = "";

      if (restarted) {
        const oldTeacherState = await fetch(base + "/api/state", {
          headers: { Cookie: `ly_session=${oldTeacherCookie}` }
        });
        const oldStudentState = await fetch(base + "/api/state", {
          headers: { Cookie: `ly_session=${oldStudentCookie}` }
        });
        const oldTeacherMedia = await fetch(base + "/files/невіснуючий-файл.pdf", {
          headers: { Cookie: `ly_session=${oldTeacherCookie}` }
        });
        const oldTeacherCatalog = await fetch(base + "/api/files", {
          headers: { Cookie: `ly_session=${oldTeacherCookie}` }
        });
        check(
          "Issue #63 (Етап 5): старі сесії після перезапуску не відновлюють доступ",
          oldTeacherState.status === 401 &&
            oldStudentState.status === 401 &&
            oldTeacherMedia.status === 401 &&
            oldTeacherCatalog.status === 403,
          JSON.stringify({
            teacherState: oldTeacherState.status,
            studentState: oldStudentState.status,
            teacherMedia: oldTeacherMedia.status,
            teacherCatalog: oldTeacherCatalog.status
          })
        );

        // Повторний вхід: ті самі облікові дані, нові сесії
        const reVerify = await fetch(base + "/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: PIN })
        });
        teacherSession = extractSessionCookie(reVerify);
        const reStudent = await studentLogin(base, "Коваленко Олена");
        const reStudentState = await fetch(base + "/api/state", { headers: sess() });
        const reTeacherMedia = await fetch(base + "/files/невіснуючий-файл.pdf", { headers: tSess() });
        check(
          "Issue #63 (Етап 5): після повторного входу доступ відповідно до ролі",
          reVerify.status === 200 && Boolean(teacherSession) &&
            reStudent.status === 200 && Boolean(reStudent.cookie) &&
            reStudentState.status === 200 &&
            reTeacherMedia.status === 404 && // 404, а не 401: сесія дійсна, файлу просто немає
            Boolean(oldTeacherCookie) && teacherSession !== oldTeacherCookie,
          JSON.stringify({
            verify: reVerify.status,
            student: reStudent.status,
            state: reStudentState.status,
            teacherMedia: reTeacherMedia.status
          })
        );

        // Дані, які зберігаються на диску, перезапуск не чіпає
        const filesAfter = await (await fetch(base + "/api/files", { headers: { "X-Portal-Pin": PIN } })).json();
        const catsAfter = await (await fetch(base + "/api/categories", { headers: { "X-Portal-Pin": PIN } })).json();
        check(
          "Issue #63 (Етап 5): матеріали та категорії не втрачені після перезапуску",
          JSON.stringify(filesAfter) === JSON.stringify(filesBefore) &&
            JSON.stringify(catsAfter) === JSON.stringify(catsBefore),
          JSON.stringify({ files: filesAfter.length, cats: catsAfter.length })
        );

        // Після перезапуску лімітатор спроб PIN теж порожній (стан у пам'яті)
        const postRestartPin = await fetch(base + "/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "0000" })
        });
        check(
          "Issue #63 (Етап 5): після перезапуску лімітатор спроб PIN порожній (не 429)",
          postRestartPin.status === 403,
          `status=${postRestartPin.status}`
        );
      }
    } finally {
      child.kill();
    }
  } finally {
    child.kill();
  }

  // Підсумок
  const width = Math.max(...results.map((x) => x.Test.length));
  results.forEach((x) => console.log(`${x.Result.padEnd(5)} ${x.Test.padEnd(width)} ${x.Info}`));
  const fails = results.filter((x) => x.Result === "FAIL");
  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nALL TESTS PASSED");
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err.stack || err.message);
  if (err.cause) {
    console.error("CAUSE:", (err.cause && (err.cause.stack || err.cause.message)) || String(err.cause));
  }
  console.error("SERVER LOG:\n" + SERVER_LOG);
  process.exit(1);
});
