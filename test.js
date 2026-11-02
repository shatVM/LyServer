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
      // Регресія: маршрут /upload не видалено, корінь / перенаправляє на /materials
      r = await fetch(base + "/upload");
      check("Issue #63 Е2: /upload залишається доступною", r.status === 200, `status=${r.status}`);
      r = await fetch(base + "/", { redirect: "manual" });
      check(
        "Issue #63 Е2: корінь / перенаправляє на /materials",
        (r.status === 301 || r.status === 302) && r.headers.get("location") === "/materials",
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
          s4FileCtlSource.includes("canViewMedia(name, isTeacher)") &&
          s4SlideCtlSource.includes("canViewMedia(name, identity.isTeacher)") &&
          apiControllerSource.includes("canViewMedia(file, isTeacher)")
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
