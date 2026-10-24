const express = require("express");
const apiController = require("../controllers/apiController");
const presenceController = require("../controllers/presenceController");

const router = express.Router();

router.get("/files", (req, res) => apiController.getFiles(req, res));
router.get("/categories", (req, res) => apiController.getCategories(req, res));
router.post("/categories", (req, res) => apiController.createCategory(req, res));
router.post("/categories/delete", (req, res) => apiController.deleteCategory(req, res));
router.post("/files/category", (req, res) => apiController.setFileCategory(req, res));
router.post("/files/reorder", (req, res) => apiController.reorderFile(req, res));
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
router.post("/presence/teacher", (req, res) => presenceController.teacherHeartbeat(req, res));
router.get("/presence/students", (req, res) => presenceController.getStudents(req, res));

module.exports = router;
