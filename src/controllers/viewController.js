const config = require("../config");

class ViewController {
  renderMaterials(req, res) {
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
