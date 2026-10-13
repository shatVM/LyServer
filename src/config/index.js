const path = require("node:path");

const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "0.0.0.0",
  portalPin: process.env.PORTAL_PIN || "2468",
  dataDir: path.join(__dirname, "..", "..", "materials"),
  slidesDir: path.join(__dirname, "..", "..", "materials", ".slides"),
  metadataFile: path.join(__dirname, "..", "..", "materials", ".metadata.json"),
  maxUpload: 1024 * 1024 * 1024, // 1 GB
  // PDF render scale (higher = better quality, but slower & larger files)
  pdfScale: Number(process.env.PDF_SCALE) || 1.8,
  // PPTX slide export resolution
  pptxWidth: Number(process.env.PPTX_WIDTH) || 1920,
  pptxHeight: Number(process.env.PPTX_HEIGHT) || 1080,
  allowedExtensions: new Set([
    ".pdf", ".pptx",
    ".mp4", ".webm", ".m4v", ".mov",
    ".ogg", ".mp3", ".wav"
  ]),
  // Types that are rendered to slide images
  slideExtensions: new Set([".pdf", ".pptx"]),
  mimeTypes: {
    ".pdf": "application/pdf",
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
