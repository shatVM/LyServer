const config = require("../config");
const auth = require("../utils/auth");

class ViewController {
  /**
   * Issue #63 (доробка §1): сторінка «Перегляд матеріалів» — сторінка
   * САМОСТІЙНОГО перегляду учня. Усі дії викладача з матеріалами (каталог,
   * категорії, публікація/приховування, описи, порядок, приватне прев'ю) уже
   * виконуються на сторінці «Демонстрація», тому викладача на /materials
   * перенаправляємо туди (302). Без чинної сесії викладача (гість, учень)
   * сторінка рендериться як раніше; клієнт додатково переводить викладача
   * на /demonstration після входу прямо на цій сторінці (updateRoleUI).
   */
  renderMaterials(req, res) {
    const session = auth.readSession(req);
    if (session && session.role === "teacher") {
      return res.redirect("/demonstration");
    }
    res.render("materials", {
      title: "Перегляд матеріалів",
      activeMenu: "materials",
      description: "Локальна бібліотека матеріалів для роботи в укритті",
      port: config.port
    });
  }

  renderUpload(req, res) {
    res.render("upload", {
      title: "Додавання матеріалів",
      activeMenu: "upload",
      description: "Завантаження навчальних файлів на локальний сервер",
      port: config.port
    });
  }

  renderDemonstration(req, res) {
    res.render("demonstration", {
      title: "Демонстрація",
      activeMenu: "demonstration",
      description: "Спільна синхронізована трансляція для аудиторії",
      port: config.port
    });
  }

  renderStudents(req, res) {
    res.render("students", {
      title: "Учні",
      activeMenu: "students",
      description: "Список підключених учнів та їх статус присутності",
      port: config.port
    });
  }

  healthCheck(req, res) {
    res.json({ status: "ok" });
  }
}

module.exports = new ViewController();
