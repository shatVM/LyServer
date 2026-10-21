// Автотести LyServer: npm test (запускає окремий екземпляр сервера)
const { spawn } = require("node:child_process");

const PIN = "2468";
const PORT = 3997;
const base = `http://localhost:${PORT}`;

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
    stdio: "ignore"
  });

  try {
    if (!(await waitForHealth(base))) {
      console.error("Сервер не запустився");
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
      body: TINY_PDF
    });
    const upload = await r.json();
    const fileId = upload.id;
    check("Викладач: завантаження PDF", r.status === 201 && Boolean(fileId), `status=${r.status}`);
    if (!fileId) throw new Error("Не вдалося завантажити тестовий файл");

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
      // Прибирання тестового файлу
      await fetch(`${base}/api/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN, file: fileId })
      }).catch(() => {});
    }

    // 10. Issue #1: ліміт спроб PIN — окремий екземпляр з малим лімітом
    const child2 = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: "3996", PORTAL_PIN: PIN, PIN_MAX_ATTEMPTS: "3" },
      stdio: "ignore"
    });
    try {
      if (await waitForHealth("http://localhost:3996")) {
        const base2 = "http://localhost:3996";
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
  console.error("ERROR:", err.message);
  process.exit(1);
});
