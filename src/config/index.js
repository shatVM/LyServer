const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Issue #85: адміністративний PIN (`PORTAL_PIN`).
 *
 * Раніше без заданої змінної використовувалося значення за замовчуванням,
 * опубліковане в репозиторії (README) — небезпечно для публічного проєкту.
 * Тепер: без PORTAL_PIN PIN генерується випадково ПІД ЧАС ЗАПУСКУ і
 * показується ОДИН раз лише в терміналі сервера (див. server.js). Він не
 * потрапляє в HTTP-відповіді, HTML, браузер чи логи GitHub Actions (у CI,
 * де задано PORTAL_PIN, генерація не використовується взагалі).
 */
let portalPinSource = "env";

function resolvePortalPin() {
  const envPin = typeof process.env.PORTAL_PIN === "string" ? process.env.PORTAL_PIN.trim() : "";
  if (envPin) return envPin;
  portalPinSource = "generated";
  // 6 цифр — випадкове значення для цього запуску процесу
  return String(crypto.randomInt(100000, 1000000));
}

const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "0.0.0.0",
  portalPin: resolvePortalPin(),
  /** "env" — задано через змінну середовища; "generated" — згенеровано на старті */
  portalPinSource,
  dataDir: path.join(__dirname, "..", "..", "materials"),
  slidesDir: path.join(__dirname, "..", "..", "materials", ".slides"),
  metadataFile: path.join(__dirname, "..", "..", "materials", ".metadata.json"),
  // Issue #85: облікові записи викладачів (лежать у materials/ — поза Git)
  teachersFile: path.join(__dirname, "..", "..", "materials", ".teachers.json"),
  /** Issue #85: персональний PIN викладача — рівно 4 цифри */
  teacherPinLength: 4,
  /** Issue #85: ліміт спроб PIN за обліковим записом (додатковий до IP-ліміту) */
  teacherPinMaxAttempts: Number(process.env.TEACHER_PIN_MAX_ATTEMPTS) || 3,
  maxUpload: 1024 * 1024 * 1024, // 1 GB
  // Issue #63 Етап 3: максимальна довжина необов'язкового опису матеріалу
  maxDescriptionLength: 500,
  // Захист PIN від перебору (див. utils/pinLimiter.js)
  pinMaxAttempts: Number(process.env.PIN_MAX_ATTEMPTS) || 5,
  pinWindowMs: Number(process.env.PIN_WINDOW_MS) || 15 * 60 * 1000,
  pinBlockMs: Number(process.env.PIN_BLOCK_MS) || 15 * 60 * 1000,
  // PDF render scale (higher = better quality, but slower & larger files)
  pdfScale: Number(process.env.PDF_SCALE) || 1.8,
  // PPTX slide export resolution
  pptxWidth: Number(process.env.PPTX_WIDTH) || 1920,
  pptxHeight: Number(process.env.PPTX_HEIGHT) || 1080,
  allowedExtensions: new Set([
    ".pdf", ".ppt", ".pptx",
    ".mp4", ".webm", ".m4v", ".mov",
    ".ogg", ".mp3", ".wav"
  ]),
  // Types that are rendered to slide images
  slideExtensions: new Set([".pdf", ".ppt", ".pptx"]),
  mimeTypes: {
    ".pdf": "application/pdf",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".ogg": "video/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav"
  }
};

module.exports = config;
