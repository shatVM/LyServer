/**
 * teachers.js — логіка адміністративного розділу «Викладачі» (Issue #85).
 *
 * Панель працює лише з чинною СЕСІЄЮ адміністратора (вхід за PORTAL_PIN):
 * запити /api/teachers/* несуть HttpOnly cookie; сервер відхиляє сесію
 * викладача чи учня (403) і запити без входу (401). Заголовків із PIN тут
 * немає — у відповідях сервера не буває ні PIN, ні хеша (перевіряється і
 * в автотестах: см. test.js, блоk Issue #85).
 *
 * Безпека розмітки: назви ПІБ і будь-які дані з API вставляються через
 * textContent/createElement — HTML-розмітка з серверних даних не будується
 * (захист від XSS через ім'я викладача).
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /** Повідомлення про помилку в заданому блоці (або приховування) */
  function showError(id, message) {
    const el = $(id);
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.style.display = "block";
    } else {
      el.textContent = "";
      el.style.display = "none";
    }
  }

  /** Універсальний запит до адмін-API: JSON + обробка втрати сесії */
  async function adminApi(url, options = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    const response = await fetch(url, Object.assign({}, options, { headers }));
    let data = null;
    try {
      data = await response.json();
    } catch { /* відповідь не JSON (наприклад, 401 текстом) */ }
    if (response.status === 401 || response.status === 403) {
      const error = new Error(
        response.status === 401
          ? "Сесію не знайдено — увійдіть заново як адміністратор (PIN адміністратора)."
          : "Доступ має лише адміністратор (вхід за PORTAL_PIN)."
      );
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error((data && data.message) || ("Помилка сервера: " + response.status));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /** Текст статусу запису */
  function statusText(t) {
    if (t.archived) return { text: "архівований", cls: "badge-archived" };
    if (!t.active) return { text: "деактивований", cls: "badge-off" };
    return { text: "активний", cls: "badge-on" };
  }

  /** Рядок таблиці одного облікового запису */
  function buildRow(t) {
    const row = document.createElement("div");
    row.className = "teacher-row";
    row.dataset.id = t.id;

    const main = document.createElement("div");
    main.className = "teacher-row-main";

    const name = document.createElement("div");
    name.className = "teacher-name";

    // ПІБ редагується прямо в рядку (зберігається кнопкою «Зберегти»)
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "teacher-name-input";
    nameInput.maxLength = 120;
    nameInput.value = t.fullName;
    nameInput.autocomplete = "off";
    name.appendChild(nameInput);

    const status = document.createElement("span");
    const st = statusText(t);
    status.className = "teacher-badge " + st.cls;
    status.textContent = st.text;
    name.appendChild(status);
    main.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "teacher-meta";
    // Наслідки дій — адміністратор бачить їх ДО підтвердження (Issue #85)
    meta.textContent =
      "ролі: " + (t.roles || []).join(", ") +
      " · активних сесій: " + (t.activeSessions || 0) +
      " · історичних посилань: " + (t.historicalLinks || 0) +
      " · оновлено: " + (t.updatedAt ? new Date(t.updatedAt).toLocaleString("uk-UA") : "—");
    main.appendChild(meta);
    row.appendChild(main);

    const perms = document.createElement("div");
    perms.className = "teacher-perms-row";
    ["demo", "materials"].forEach((perm) => {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "teacher-perm";
      box.value = perm;
      box.checked = Array.isArray(t.permissions) && t.permissions.includes(perm);
      label.appendChild(box);
      label.appendChild(document.createTextNode(
        perm === "demo" ? " демонстрація" : " матеріали"
      ));
      perms.appendChild(label);
    });
    row.appendChild(perms);

    const actions = document.createElement("div");
    actions.className = "teacher-actions";

    const btnSave = document.createElement("button");
    btnSave.type = "button";
    btnSave.className = "btn-ghost";
    btnSave.textContent = "Зберегти";
    btnSave.addEventListener("click", () => saveRow(t, row));
    actions.appendChild(btnSave);

    const btnToggle = document.createElement("button");
    btnToggle.type = "button";
    btnToggle.className = "btn-ghost";
    btnToggle.textContent = t.active ? "Деактивувати" : "Активувати";
    btnToggle.addEventListener("click", () => setActive(t, !t.active));
    actions.appendChild(btnToggle);

    const btnArchive = document.createElement("button");
    btnArchive.type = "button";
    btnArchive.className = "btn-ghost";
    btnArchive.textContent = "Архівувати";
    btnArchive.addEventListener("click", () => archiveRow(t));
    actions.appendChild(btnArchive);

    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.className = "btn-danger";
    btnDelete.textContent = "Видалити";
    btnDelete.addEventListener("click", () => deleteRow(t));
    actions.appendChild(btnDelete);

    row.appendChild(actions);
    return row;
  }

  /** Збереження змін рядка: ПІБ, дозволи (зміна прав → релогін викладача) */
  async function saveRow(t, row) {
    showError("teacherListError", "");
    const nameInput = row.querySelector(".teacher-name-input");
    const fullName = nameInput ? nameInput.value.trim() : t.fullName;
    const boxes = Array.from(row.querySelectorAll(".teacher-perm"));
    const permissions = boxes.filter((b) => b.checked).map((b) => b.value);
    try {
      await adminApi("/api/teachers/update", {
        method: "POST",
        body: JSON.stringify({ id: t.id, fullName, permissions })
      });
      await loadTeachers();
      showToastIfAvailable("Запис «" + fullName + "» оновлено. Чинні сесії викладача відкликано.", "success");
    } catch (error) {
      showError("teacherListError", error.message);
    }
  }

  /** Активація/деактивація: деактивація відкликає сесії та блокує вхід */
  async function setActive(t, active) {
    showError("teacherListError", "");
    if (!active) {
      const ok = window.confirm(
        "Деактивувати обліковий запис «" + t.fullName + "»?\n\n" +
        "Наслідки: вхід за персональним PIN стане неможливим, " +
        "активних сесій буде відкликано: " + (t.activeSessions || 0) + ".\n" +
        "Матеріали та історія (посилань: " + (t.historicalLinks || 0) + ") не зміняться."
      );
      if (!ok) return;
    }
    try {
      await adminApi("/api/teachers/update", {
        method: "POST",
        body: JSON.stringify({ id: t.id, active })
      });
      await loadTeachers();
    } catch (error) {
      showError("teacherListError", error.message);
    }
  }

  /** Архівація: м'яке видалення зі збереженням усієї історії */
  async function archiveRow(t) {
    showError("teacherListError", "");
    const ok = window.confirm(
      "Архівувати обліковий запис «" + t.fullName + "»?\n\n" +
      "Наслідки: вхід і чинні сесії припиняться, але запис і вся історія " +
      "збережуться (історичних посилань: " + (t.historicalLinks || 0) + "). " +
      "Це рекомендована дія, якщо викладач залишив роботу."
    );
    if (!ok) return;
    try {
      await adminApi("/api/teachers/archive", {
        method: "POST",
        body: JSON.stringify({ id: t.id })
      });
      await loadTeachers();
    } catch (error) {
      showError("teacherListError", error.message);
    }
  }

  /** Видалення: лише з явним підтвердженням і показаними наслідками */
  async function deleteRow(t) {
    showError("teacherListError", "");
    if (t.historicalLinks > 0) {
      showError(
        "teacherListError",
        "У запису «" + t.fullName + "» є історичні посилання (" +
        t.historicalLinks + ") — скористайтеся архівацією замість видалення."
      );
      return;
    }
    const ok = window.confirm(
      "ВИДАЛИТИ обліковий запис «" + t.fullName + "» назавжди?\n\n" +
      "Наслідки: вхід за персональним PIN стане неможливим, " +
      "активних сесій буде відкликано: " + (t.activeSessions || 0) + ".\n" +
      "Матеріали не видаляються (історичних посилань: 0), але відновити " +
      "запис і PIN буде неможливо. Якщо історія потрібна — архівуйте."
    );
    if (!ok) return;
    try {
      await adminApi("/api/teachers/delete", {
        method: "POST",
        body: JSON.stringify({ id: t.id, confirm: true })
      });
      await loadTeachers();
    } catch (error) {
      showError("teacherListError", error.message);
    }
  }

  /** Завантаження та рендер списку (без PIN/хешів — їх немає у відповіді) */
  async function loadTeachers() {
    showError("teacherListError", "");
    try {
      const data = await adminApi("/api/teachers");
      const list = Array.isArray(data.teachers) ? data.teachers : [];
      const container = $("teachersList");
      if (container) {
        container.replaceChildren();
        if (!list.length) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Облікових записів ще немає — створіть першого викладача.";
          container.appendChild(empty);
        } else {
          list.forEach((t) => container.appendChild(buildRow(t)));
        }
      }
      // Селект для заміни PIN — лише ПІБ, без будь-яких секретів
      const select = $("teacherPinSelect");
      if (select) {
        select.replaceChildren();
        list.forEach((t) => {
          const option = document.createElement("option");
          option.value = t.id;
          option.textContent = t.fullName + (t.archived ? " (архівований)" : "");
          select.appendChild(option);
        });
      }
    } catch (error) {
      showError("teacherListError", error.message);
    }
  }

  /** Створення запису: ПІБ + 4-значний PIN + дозволи */
  async function createTeacher(event) {
    event.preventDefault();
    showError("teacherFormError", "");
    const fullName = $("teacherFullName") ? $("teacherFullName").value.trim() : "";
    const pinValue = $("teacherPin") ? $("teacherPin").value.trim() : "";
    const permissions = [];
    if ($("permDemo") && $("permDemo").checked) permissions.push("demo");
    if ($("permMaterials") && $("permMaterials").checked) permissions.push("materials");

    if (!/^\d{4}$/.test(pinValue)) {
      showError("teacherFormError", "PIN має містити рівно 4 цифри.");
      return;
    }
    try {
      await adminApi("/api/teachers/create", {
        method: "POST",
        body: JSON.stringify({ fullName, pin: pinValue, permissions })
      });
      // PIN лишається лише у цій вкладці — у список і логи він не потрапляє
      if ($("teacherPin")) $("teacherPin").value = "";
      if ($("teacherFullName")) $("teacherFullName").value = "";
      await loadTeachers();
      showToastIfAvailable("Обліковий запис створено.", "success");
    } catch (error) {
      showError("teacherFormError", error.message);
    }
  }

  /** Заміна PIN: старий PIN показати неможливо, лише замінити */
  async function replacePin(event) {
    event.preventDefault();
    showError("teacherPinError", "");
    const id = $("teacherPinSelect") ? $("teacherPinSelect").value : "";
    const pinValue = $("teacherNewPin") ? $("teacherNewPin").value.trim() : "";
    if (!id) {
      showError("teacherPinError", "Оберіть обліковий запис.");
      return;
    }
    if (!/^\d{4}$/.test(pinValue)) {
      showError("teacherPinError", "PIN має містити рівно 4 цифри.");
      return;
    }
    try {
      await adminApi("/api/teachers/set-pin", {
        method: "POST",
        body: JSON.stringify({ id, pin: pinValue })
      });
      if ($("teacherNewPin")) $("teacherNewPin").value = "";
      await loadTeachers();
      showToastIfAvailable("PIN замінено; чинні сесії викладача відкликано.", "success");
    } catch (error) {
      showError("teacherPinError", error.message);
    }
  }

  /** Коротке повідомлення; тости є не на кожній сторінці — fallback на статус */
  function showToastIfAvailable(message, type) {
    if (typeof window.showToast === "function") {
      window.showToast(message, type || "success");
    }
  }

  // Ініціалізація панелі
  if ($("teacherCreateForm")) $("teacherCreateForm").addEventListener("submit", createTeacher);
  if ($("teacherPinForm")) $("teacherPinForm").addEventListener("submit", replacePin);
  if ($("teacherReloadBtn")) $("teacherReloadBtn").addEventListener("click", () => void loadTeachers());

  // Список завантажується одразу; повторно — коли адмін увійшов/відновив сесію
  void loadTeachers();
  window.addEventListener("focus", () => void loadTeachers());
})();
