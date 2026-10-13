/**
 * slideService.js
 * Converts PDF and PPTX files to per-page PNG images on the server.
 *
 * PDF  → pdfjs-dist + canvas (with standard fonts and cmaps for full Cyrillic support)
 * PPTX → PowerPoint COM via PowerShell child_process (requires MS Office on server)
 *
 * Slide images are stored in:  materials/.slides/<fileId>/page-N.png
 * A manifest is written at:    materials/.slides/<fileId>/manifest.json
 *   { pageCount, generatedAt, source }
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const config = require("../config");

const execFileAsync = promisify(execFile);

// Ensure base slides directory exists
fs.mkdirSync(config.slidesDir, { recursive: true });

// Locate pdfjs-dist assets for proper Cyrillic / CJK font decoding
let cMapUrl = undefined;
let standardFontDataUrl = undefined;
try {
  const pdfjsPkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  cMapUrl = path.join(pdfjsPkgDir, "cmaps") + path.sep;
  standardFontDataUrl = path.join(pdfjsPkgDir, "standard_fonts") + path.sep;
} catch (e) {
  console.warn("Could not resolve pdfjs-dist asset paths:", e.message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe folder for a file's slides */
function slideFolder(name) {
  return path.join(config.slidesDir, name);
}

function manifestPath(name) {
  return path.join(slideFolder(name), "manifest.json");
}

function readManifest(name) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(name), "utf-8"));
  } catch {
    return null;
  }
}

function writeManifest(name, data) {
  const folder = slideFolder(name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(manifestPath(name), JSON.stringify(data, null, 2), "utf-8");
}

/** Delete all cached slides for a given file */
function clearSlides(name) {
  const folder = slideFolder(name);
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** Return the absolute path to page PNG (1-indexed). Does NOT check existence. */
function pagePngPath(name, pageNum) {
  return path.join(slideFolder(name), "page-" + pageNum + ".png");
}

// ---------------------------------------------------------------------------
// PDF conversion (pdf-poppler with fallback to pdfjs-dist)
// ---------------------------------------------------------------------------

async function convertPdf(name) {
  const folder = slideFolder(name);
  fs.mkdirSync(folder, { recursive: true });

  const srcPath = path.join(config.dataDir, name);

  try {
    const poppler = require("pdf-poppler");
    const info = await poppler.info(srcPath);
    const totalPages = parseInt(info.pages, 10) || 1;

    // Convert all pages to PNG using Poppler (renders fonts natively with full Cyrillic support)
    await poppler.convert(srcPath, {
      format: "png",
      out_dir: folder,
      out_prefix: "poppler_page"
    });

    // Rename generated poppler_page-01.png / poppler_page-1.png to standard page-1.png
    const files = fs.readdirSync(folder);
    for (const f of files) {
      const match = f.match(/^poppler_page-0*(\d+)\.png$/);
      if (match) {
        const pageNum = parseInt(match[1], 10);
        const oldPath = path.join(folder, f);
        const newPath = pagePngPath(name, pageNum);
        if (oldPath !== newPath) {
          fs.copyFileSync(oldPath, newPath);
          fs.unlinkSync(oldPath);
        }
      }
    }

    const manifest = { pageCount: totalPages, generatedAt: Date.now(), source: "pdf-poppler" };
    writeManifest(name, manifest);
    return manifest;
  } catch (popplerErr) {
    console.warn("pdf-poppler conversion failed, falling back to pdfjs-dist:", popplerErr.message);

    const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
    const { createCanvas } = require("canvas");

    const buf = fs.readFileSync(srcPath);
    const docParams = {
      data: new Uint8Array(buf),
      useSystemFonts: true,
      disableFontFace: false
    };

    if (cMapUrl && fs.existsSync(cMapUrl)) {
      docParams.cMapUrl = cMapUrl;
      docParams.cMapPacked = true;
    }
    if (standardFontDataUrl && fs.existsSync(standardFontDataUrl)) {
      docParams.standardFontDataUrl = standardFontDataUrl;
    }

    const pdf = await pdfjs.getDocument(docParams).promise;
    const total = pdf.numPages;

    for (let i = 1; i <= total; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: config.pdfScale });
      const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      fs.writeFileSync(pagePngPath(name, i), canvas.toBuffer("image/png"));
    }

    const manifest = { pageCount: total, generatedAt: Date.now(), source: "pdf" };
    writeManifest(name, manifest);
    return manifest;
  }
}

// ---------------------------------------------------------------------------
// PPTX conversion (PowerShell + PowerPoint COM)
// ---------------------------------------------------------------------------

async function convertPptx(name) {
  const folder = slideFolder(name);
  fs.mkdirSync(folder, { recursive: true });

  const srcPath = path.join(config.dataDir, name).replace(/\\/g, "\\\\");
  const outFolder = folder.replace(/\\/g, "\\\\");

  const ps = `
$ErrorActionPreference = 'Stop'
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open("${srcPath}", $true, $false, $false)
  $count = $pres.Slides.Count
  $idx = 1
  foreach ($slide in $pres.Slides) {
    $out = "${outFolder}\\\\page-$idx.png"
    $slide.Export($out, "PNG", ${config.pptxWidth}, ${config.pptxHeight})
    $idx++
  }
  $pres.Close()
  Write-Output $count
} finally {
  $ppt.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
  [System.GC]::Collect()
}
`;

  const { stdout } = await execFileAsync("powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", ps
  ], { timeout: 120000 });

  const total = parseInt(stdout.trim(), 10);
  if (!Number.isFinite(total) || total < 1) {
    throw new Error("PowerPoint did not export any slides. Output: " + stdout);
  }

  const manifest = { pageCount: total, generatedAt: Date.now(), source: "pptx" };
  writeManifest(name, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure slides exist for a file. Returns manifest { pageCount, generatedAt, source }.
 * Checks mtime of source file vs manifest – re-converts if source is newer.
 */
async function ensureSlides(name) {
  const srcPath = path.join(config.dataDir, name);
  if (!fs.existsSync(srcPath)) {
    throw Object.assign(new Error("Файл не знайдено"), { status: 404 });
  }

  const existing = readManifest(name);
  if (existing) {
    const srcMtime = fs.statSync(srcPath).mtimeMs;
    if (existing.generatedAt >= srcMtime) {
      return existing; // up-to-date
    }
  }

  const ext = path.extname(name).toLowerCase();
  if (ext === ".pdf") {
    return convertPdf(name);
  } else if (ext === ".pptx") {
    return convertPptx(name);
  } else {
    throw Object.assign(new Error("Конвертація не підтримується для цього типу файлу"), { status: 400 });
  }
}

/**
 * Get manifest info without triggering conversion.
 * Returns null if slides not yet generated.
 */
function getManifest(name) {
  return readManifest(name);
}

/** Get absolute path to a specific page PNG (1-indexed). */
function getPagePath(name, pageNum) {
  const p = pagePngPath(name, pageNum);
  if (!fs.existsSync(p)) return null;
  return p;
}

module.exports = { ensureSlides, getManifest, getPagePath, clearSlides };
