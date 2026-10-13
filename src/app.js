const express = require("express");
const hbs = require("hbs");
const path = require("node:path");

const viewRoutes = require("./routes/viewRoutes");
const apiRoutes = require("./routes/apiRoutes");
const fileRoutes = require("./routes/fileRoutes");
const slideRoutes = require("./routes/slideRoutes");

const app = express();

// View engine setup (hbs)
const viewsPath = path.join(__dirname, "..", "views");
const partialsPath = path.join(viewsPath, "partials");

app.set("view engine", "hbs");
app.set("views", viewsPath);
hbs.registerPartials(partialsPath);

// Register Handlebars helpers
hbs.registerHelper("currentYear", () => new Date().getFullYear());
hbs.registerHelper("isActive", (current, expected) => (current === expected ? "active" : ""));
hbs.registerHelper("eq", (a, b) => a === b);

// Middleware for parsing JSON requests (used by /api/control)
app.use(express.json());

// Serve static assets from public/ directory
app.use(express.static(path.join(__dirname, "..", "public")));

// Routes
app.use("/", viewRoutes);
app.use("/api", apiRoutes);
app.use("/files", fileRoutes);
app.use("/slides", slideRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).send("Сторінку не знайдено");
});

module.exports = app;

