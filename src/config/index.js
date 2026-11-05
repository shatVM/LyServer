const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Issue #85: адміністративний PIN = `PORTAL_PIN`, заданий у середовищі.
 * Без заданої змінної використовується стандартне значення, яке веде
 * проєкт від самого початку (видиме в README); власник може перевизначити
 * його через `PORTAL_PIN`. Генерація випадкового PIN прибрано: сервер має
 * працювати без ручного втручання після кожного перезапуску.
 *
 * Щоб уникнути вливання у Git історії реального PIN: персональні PIN
 * викладачів і їхні хеші лежать у `materials/.teachers.json` (каталог
 * у .gitignore), CLI та панель ніколи не показують PIN і хеш у відповідях.
 */
const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "0.0.0.0",
  // Issue #85: адміністративний PIN — заданий через PORTAL_PIN, або стандартний
  portalPin: process.env.PORTAL_PIN || "2468",
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
