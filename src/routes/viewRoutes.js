const express = require("express");
const viewController = require("../controllers/viewController");
const auth = require("../utils/auth");

const router = express.Router();

// Issue #88 (рев'ю): усі HTML-сторінки порталу віддаються без кешування —
// після виходу back/reload не відкриває захищений вміст із кешу браузера
// (серверна перевірка сесії на сторінках при цьому не прибирається).
// /health — JSON-статус, йому no-store не потрібен.
const noStoreHtml = (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
};

// Issue #63 (доробка §1): корінь веде на сторінку самостійного перегляду, а
// викладача — одразу на «Демонстрацію» (подвійне перенаправлення зайве)
router.get("/", noStoreHtml, (req, res) => {
  const session = auth.readSession(req);
  res.redirect(session && session.role === "teacher" ? "/demonstration" : "/materials");
});
router.get("/materials", noStoreHtml, (req, res) => viewController.renderMaterials(req, res));
router.get("/upload", noStoreHtml, (req, res) => viewController.renderUpload(req, res));
router.get("/demonstration", noStoreHtml, (req, res) => viewController.renderDemonstration(req, res));
router.get("/students", noStoreHtml, (req, res) => viewController.renderStudents(req, res));
// Issue #85: адміністративний розділ «Викладачі» (серверна перевірка доступу)
router.get("/teachers", noStoreHtml, (req, res) => viewController.renderTeachers(req, res));
router.get("/health", (req, res) => viewController.healthCheck(req, res));

module.exports = router;
