const express = require("express");
const apiController = require("../controllers/apiController");
const presenceController = require("../controllers/presenceController");

const router = express.Router();

router.get("/files", (req, res) => apiController.getFiles(req, res));
router.get("/state", (req, res) => apiController.getState(req, res));
router.post("/control", (req, res) => apiController.updateControl(req, res));
router.post("/upload", (req, res) => apiController.uploadFile(req, res));
router.post("/auth/verify", (req, res) => apiController.verifyAuth(req, res));
router.post("/files/toggle-hide", (req, res) => apiController.toggleHide(req, res));
router.post("/files/delete", (req, res) => apiController.deleteFile(req, res));
router.post("/slides/prepare", (req, res) => apiController.prepareSlides(req, res));
router.get("/slides/info", (req, res) => apiController.getSlideInfo(req, res));

// Presence (student tracking)
router.post("/presence/heartbeat", (req, res) => presenceController.heartbeat(req, res));
router.get("/presence/students", (req, res) => presenceController.getStudents(req, res));

module.exports = router;
