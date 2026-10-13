const path = require("node:path");
const config = require("../config");

function safeFilename(input) {
  const base = path.basename(String(input || ""));
  // Sanitize for safe filesystem usage
  return base.replace(/[^a-zA-Z0-9А-Яа-яІіЇїЄєҐґ(). _-]/g, "_");
}

function getFilePath(name) {
  const safe = safeFilename(name);
  if (!safe || safe !== name) return null;
  if (!config.allowedExtensions.has(path.extname(safe).toLowerCase())) return null;
  return path.join(config.dataDir, safe);
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

module.exports = {
  safeFilename,
  getFilePath,
  formatSize
};
