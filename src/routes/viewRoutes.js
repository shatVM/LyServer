const express = require("express");
const viewController = require("../controllers/viewController");
const auth = require("../utils/auth");

const router = express.Router();

// Issue #63 (доробка §1): корінь веде на сторінку самостійного перегляду, а
// викладача — одразу на «Демонстрацію» (подвійне перенаправлення зайве)
router.get("/", (req, res) => {
  const session = auth.readSession(req);
  res.redirect(session && session.role === "teacher" ? "/demonstration" : "/materials");
});
router.get("/materials", (req, res) => viewController.renderMaterials(req, res));
router.get("/upload", (req, res) => viewController.renderUpload(req, res));
router.get("/demonstration", (req, res) => viewController.renderDemonstration(req, res));
router.get("/students", (req, res) => viewController.renderStudents(req, res));
router.get("/health", (req, res) => viewController.healthCheck(req, res));

module.exports = router;
