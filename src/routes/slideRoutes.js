const express = require("express");
const slideController = require("../controllers/slideController");

const router = express.Router();

// GET /slides/:name/:page  — serve a pre-rendered slide PNG
router.get("/:name/:page", (req, res) => slideController.getSlide(req, res));

module.exports = router;

