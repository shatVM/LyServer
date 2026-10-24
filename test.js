// Автотести LyServer: npm test (запускає окремий екземпляр сервера)
const { spawn } = require("node:child_process");

const PIN = "2468";
const PORT = 3997;
const base = `http://127.0.0.1:${PORT}`;

// Діагностика CI: лог запущеного екземпляра сервера (stdout/stderr/exit)
let SERVER_LOG = "";

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
  // --- Основний екземпляр сервера ---
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), PORTAL_PIN: PIN },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { SERVER_LOG += chunk; });
  child.stderr.on("data", (chunk) => { SERVER_LOG += chunk; });
  child.on("exit", (code, signal) => {
    SERVER_LOG += `[server exit] code=${code} signal=${signal}\n`;
  });

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
      let manifest = null;
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`);
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

      // 4. Учень отримує зображення, сирий PDF закритий
      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`);
      const img = Buffer.from(await r.arrayBuffer());
      const isPng = img.length > 8 && img.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      check("Issue #8: учень отримує PNG-слайд", r.status === 200 && isPng, `status=${r.status}`);

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`);
      check("Issue #8: сирий PDF закритий для учня", r.status === 403, `status=${r.status}`);

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}?pin=${PIN}`);
      check("Викладач: сирий PDF доступний", r.status === 200, `status=${r.status}`);

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
      r = await fetch(`${base}/api/files/toggle-hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, hidden: true })
      });
      check("Викладач: приховування файлу", r.status === 200, `status=${r.status}`);

      const studentList = await (await fetch(base + "/api/files")).json();
      check(
        "Issue #4: прихованого файлу немає в каталозі учня",
        !studentList.some((f) => f.id === fileId)
      );

      r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`);
      check("Issue #4: прихований файл закритий (/files)", r.status === 404, `status=${r.status}`);

      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1`);
      check("Issue #4: приховані слайди закриті (/slides)", r.status === 404, `status=${r.status}`);

      r = await fetch(`${base}/slides/${encodeURIComponent(fileId)}/1?pin=${PIN}`);
      check("Викладач: приховані слайди доступні", r.status === 200, `status=${r.status}`);

      // Issue #63 Р: публічне /api/slides/info теж не розкриває прихований файл
      r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`);
      check("Issue #63 Р: прихований файл закритий у /api/slides/info (учень)", r.status === 404, `status=${r.status}`);
      r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}&pin=${PIN}`);
      check("Issue #63 Р: /api/slides/info прихованого файлу з PIN (викладач)", r.status === 200, `status=${r.status}`);

      await fetch(`${base}/api/files/toggle-hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId, hidden: false })
      });

      // 7. Issue #7: присутність і активність сесії
      r = await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: "s_test_1", name: "Тестовий Учень", active: true })
      });
      check("Присутність: heartbeat активного учня", r.status === 200, `status=${r.status}`);

      r = await fetch(`${base}/api/presence/students`);
      check("Присутність: список без PIN → 403", r.status === 403, `status=${r.status}`);

      let list = await (await fetch(`${base}/api/presence/students?pin=${PIN}`)).json();
      const active = list.find((s) => s.id === "s_test_1");
      check("Присутність: викладач бачить активного учня", Boolean(active && active.online), JSON.stringify(active));

      // Неактивна сесія через form-data (як navigator.sendBeacon)
      await fetch(`${base}/api/presence/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ studentId: "s_test_1", name: "Тестовий Учень", active: "false" })
      });
      list = await (await fetch(`${base}/api/presence/students?pin=${PIN}`)).json();
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
          jsSrc.includes("if (!slideNavAllowed()) return;")
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
      // Учень бачить опис видимого файлу (лише читання), приховані — закриті (Е2/Е4)
      e3List = await (await fetch(base + "/api/files")).json();
      const e3Student = e3List.find((f) => f.id === e3WithDesc.id);
      check(
        "Issue #63 Е3: учень бачить опис видимого файлу",
        Boolean(e3Student) && e3Student.description === e3Desc,
        JSON.stringify(e3Student && e3Student.description)
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
      // Issue #63 Р: читання категорій публічне — учні групують каталог
      r = await fetch(base + "/api/categories");
      const studentCategories = r.status === 200 ? await r.json() : [];
      check(
        "Issue #63 Р: учень отримує список категорій для каталогу",
        r.status === 200 && Array.isArray(studentCategories) &&
          studentCategories.every(category => typeof category.id === "string" && typeof category.name === "string"),
        `status=${r.status}, count=${Array.isArray(studentCategories) ? studentCategories.length : "n/a"}`
      );
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

        r = await fetch(base + "/api/files");
        const studentCategoryList = await r.json();
        const studentCategorized = studentCategoryList.filter(item => item.id === e3WithDesc.id);
        // Issue #63 Р: учень отримує categoryId для групування (без дублікатів),
        // але порядок (order) і стан конвертації, як і раніше, не розкриваються
        check(
          "Issue #63 Р: учень отримує categoryId для групування без дублікатів",
          studentCategorized.length === 1 && studentCategorized[0].categoryId === e4Category.id &&
            !("order" in studentCategorized[0]) && !("conversionStatus" in studentCategorized[0]) &&
            !("conversionError" in studentCategorized[0]),
          JSON.stringify(studentCategorized[0] && studentCategorized[0].categoryId)
        );
        // Матеріали без категорії мають порожній categoryId → «Без категорії»
        check(
          "Issue #63 Р: матеріали без категорії позначені порожнім categoryId",
          studentCategoryList.some(item => item.categoryId === "") &&
            studentCategoryList.some(item => item.categoryId === e4Category.id),
          `total=${studentCategoryList.length}`
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

        // Issue #63 Р: встановлений порядок зберігається в каталозі учня
        r = await fetch(base + "/api/files");
        const studentOrderList = await r.json();
        const studentPosNoDesc = studentOrderList.findIndex(item => item.id === e3NoDesc.id);
        const studentPosWithDesc = studentOrderList.findIndex(item => item.id === e3WithDesc.id);
        check(
          "Issue #63 Р: порядок викладача зберігається в каталозі учня",
          studentPosNoDesc >= 0 && studentPosWithDesc >= 0 && studentPosNoDesc < studentPosWithDesc,
          JSON.stringify(studentOrderList.map(item => item.id))
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

      const apiControllerSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "controllers", "apiController.js"), "utf-8");
      check("Issue #63 Е4: upload запускає фонову конвертацію та фіксує помилку", apiControllerSource.includes("slideService.ensureSlides(result.id)") && apiControllerSource.includes('.then(manifest =>') && apiControllerSource.includes('setConversionStatus(result.id, "failed", conversionError)'));
      const fileServiceSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "src", "services", "fileService.js"), "utf-8");
      check(
        "Issue #63 Р: учень отримує categoryId, але не порядок і стан конвертації; неготові слайди відфільтровано",
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
      const fsMod = require("node:fs");
      const pageOnePath = require("node:path").join(__dirname, "materials", ".slides", fileId, "page-1.png");
      try {
        const originalPng = fsMod.readFileSync(pageOnePath);
        fsMod.writeFileSync(pageOnePath, Buffer.from("не PNG, а тестове сміття"));
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`);
        let cacheInfo = await r.json();
        check(
          "Issue #63 Р: навігація/info не сканує весь набір повторно (кеш)",
          r.status === 200 && cacheInfo.ready === true,
          `status=${r.status}, ready=${cacheInfo.ready}`
        );

        // Зміна набору файлів (видалення PNG) інвалідовує кеш → не готово
        fsMod.unlinkSync(pageOnePath);
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`);
        cacheInfo = r.status === 200 ? await r.json() : { ready: false };
        check(
          "Issue #63 Р: видалення PNG інвалідовує кеш перевірки",
          cacheInfo.ready === false,
          `status=${r.status}, ready=${cacheInfo.ready}`
        );

        // Відновлення файлу (зміна набору) — повна перевірка знову підтверджує готовність
        fsMod.writeFileSync(pageOnePath, originalPng);
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(fileId)}`);
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
          r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(e5Id)}&pin=${PIN}`);
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
        // Публічна відповідь (без PIN): лише факт помилки, без тексту помилки
        r = await fetch(`${base}/api/slides/info?file=${encodeURIComponent(e5Id)}`);
        const e5StudentRaw = await r.text();
        check(
          "Issue #63 Р: /api/slides/info без PIN не розкриває conversionError",
          r.status === 200 && !e5StudentRaw.includes("error") && !e5StudentRaw.includes(e5TeacherInfo.error),
          `status=${r.status}, body=${e5StudentRaw}`
        );
        check(
          "Issue #63 Р: публічна відповідь без локальних шляхів і внутрішніх подробиць",
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

        // Неготовий матеріал не потрапляє в каталог учня і без conversionError
        r = await fetch(base + "/api/files");
        const e5StudentListRaw = await r.text();
        const e5StudentList = JSON.parse(e5StudentListRaw);
        check(
          "Issue #63 Р: неготовий матеріал закритий для учня у /api/files без conversionError",
          !e5StudentList.some((f) => f.id === e5Id) && !e5StudentListRaw.includes("conversionError") && !e5StudentListRaw.includes("conversionStatus"),
          `status=${r.status}`
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
      // Доповнює поведінкові HTTP-тести; роботу DOM перевіряє окрема браузерна перевірка.
      check(
        "Issue #63 Р: акордеон категорій у джерелі клієнта та стилях",
        jsSrc.includes("const collapsedCategoryIds = new Set();") &&
          jsSrc.includes("function renderCategoryGroups(root)") &&
          jsSrc.includes("toggle.setAttribute(\"aria-controls\", bodyId)") &&
          jsSrc.includes("if (isMaterialsPage || (isDemoPage && isTeacher))") &&
          css.includes(".category-toggle") && css.includes(".category-body[hidden]")
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

      const studentStateA = await (await fetch(base + "/api/state")).json();
      const studentStateB = await (await fetch(base + "/api/state")).json();
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
      const stateAfterStudentAttempt = await (await fetch(base + "/api/state")).json();
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
      const stoppedState = await (await fetch(base + "/api/state")).json();
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
          // Старт показу позначає присутність викладача
          r = await fetch(wdogBase + "/api/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: PIN, file: fileId, kind: "slides", page: 1 })
          });
          let wState = await (await fetch(wdogBase + "/api/state")).json();
          check(
            "Issue #63: показ стартує на тестовому екземплярі",
            r.status === 200 && wState.file === fileId,
            `status=${r.status}, file=${wState.file}`
          );

          // Жодного control/heartbeat довше за тайм-аут (3 с) → автозупинка.
          // Перевірка виконується в GET /api/state, який учні опитують саме
          // так, тож тест відтворює реальний шлях відновлення каталогу.
          await delay(3600);
          wState = await (await fetch(wdogBase + "/api/state")).json();
          check(
            "Issue #63: без вчителя демонстрація зупиняється автоматично",
            wState.file === "" && wState.revision > 0,
            `file=${JSON.stringify(wState.file)}, rev=${wState.revision}`
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
          wState = await (await fetch(wdogBase + "/api/state")).json();
          check(
            "Issue #63: heartbeat викладача утримує активний показ",
            r.status === 200 && wState.file === fileId,
            `file=${wState.file}`
          );

          // Прибрати за собою на тестовому екземплярі
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
