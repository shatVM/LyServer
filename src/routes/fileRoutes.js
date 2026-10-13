const express = require("express");
const fileController = require("../controllers/fileController");

const router = express.Router();

router.get("/:name", (req, res) => fileController.streamFile(req, res));

module.exports = router;

