const express = require("express");
const apiController = require("../controllers/apiController");
const presenceController = require("../controllers/presenceController");
// Issue #79: універсальні візуальні сигнали учням (усі операції — лише з PIN)
const signalController = require("../controllers/signalController");
// Issue #83: MVP системи тестування під час демонстрації
const testingController = require("../controllers/testingController");

const router = express.Router();

router.get("/files", (req, res) => apiController.getFiles(req, res));
router.get("/categories", (req, res) => apiController.getCategories(req, res));
router.post("/categories", (req, res) => apiController.createCategory(req, res));
router.post("/categories/delete", (req, res) => apiController.deleteCategory(req, res));
router.post("/categories/rename", (req, res) => apiController.renameCategory(req, res));
router.post("/categories/reorder", (req, res) => apiController.reorderCategory(req, res));
router.post("/files/category", (req, res) => apiController.setFileCategory(req, res));
router.post("/files/reorder", (req, res) => apiController.reorderFile(req, res));
router.post("/files/rename", (req, res) => apiController.renameFile(req, res));
router.get("/state", (req, res) => apiController.getState(req, res));
router.post("/control", (req, res) => apiController.updateControl(req, res));
router.post("/upload", (req, res) => apiController.uploadFile(req, res));
router.post("/auth/verify", (req, res) => apiController.verifyAuth(req, res));
// Issue #63 (Етап 5): вхід учня — серверна сесія (HttpOnly cookie), без PIN.
// Без неї учень не отримує стан демонстрації та медіа показу.
router.post("/auth/session", (req, res) => apiController.createStudentSession(req, res));
// Issue #63 (доробка/Етап 5): вихід — скасування сесії на сервері та cookie
router.post("/auth/logout", (req, res) => apiController.logoutMedia(req, res));
router.post("/files/toggle-hide", (req, res) => apiController.toggleHide(req, res));
router.post("/files/delete", (req, res) => apiController.deleteFile(req, res));
router.post("/slides/prepare", (req, res) => apiController.prepareSlides(req, res));
router.get("/slides/info", (req, res) => apiController.getSlideInfo(req, res));

// Presence (student tracking)
router.post("/presence/heartbeat", (req, res) => presenceController.heartbeat(req, res));
router.post("/presence/teacher", (req, res) => presenceController.teacherHeartbeat(req, res));
router.get("/presence/students", (req, res) => presenceController.getStudents(req, res));

// Issue #79: універсальні візуальні сигнали учням (конфігурація + доставка).
// Кожна операція перевіряє PIN усередині контролера (приховування елементів
// в інтерфейсі не є захистом); читання стану — /api/state (персональне поле).
router.get("/signals", (req, res) => signalController.getConfig(req, res));
router.post("/signals/create", (req, res) => signalController.create(req, res));
router.post("/signals/update", (req, res) => signalController.update(req, res));
router.post("/signals/delete", (req, res) => signalController.remove(req, res));
router.post("/signals/reorder", (req, res) => signalController.reorder(req, res));
router.post("/signals/send", (req, res) => signalController.send(req, res));
router.post("/signals/dismiss", (req, res) => signalController.dismiss(req, res));

// Issue #83: тестування під час демонстрації. Старт/завершення — лише з PIN;
// відповідь учня — лише з чинною сесією (studentId із прив'язки сесії, не з
// тіла запиту). Читання стану — state.testing у GET /api/state, без нового
// ендпоінту: той самий механізм опитування, що й решта стану демонстрації.
router.post("/testing/start", (req, res) => testingController.start(req, res));
router.post("/testing/finish", (req, res) => testingController.finish(req, res));
router.post("/testing/answer", (req, res) => testingController.answer(req, res));

module.exports = router;
