const express = require("express");
const viewController = require("../controllers/viewController");

const router = express.Router();

router.get("/", (req, res) => res.redirect("/materials"));
router.get("/materials", (req, res) => viewController.renderMaterials(req, res));
router.get("/upload", (req, res) => viewController.renderUpload(req, res));
router.get("/demonstration", (req, res) => viewController.renderDemonstration(req, res));
router.get("/students", (req, res) => viewController.renderStudents(req, res));
router.get("/health", (req, res) => viewController.healthCheck(req, res));

module.exports = router;
