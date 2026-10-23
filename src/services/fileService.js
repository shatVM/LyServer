const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const config = require("../config");
const { getFilePath, safeFilename } = require("../utils/fileHelpers");

// Ensure data directory exists
fs.mkdirSync(config.dataDir, { recursive: true });

class FileService {
  getMetadata() {
    try {
      if (fs.existsSync(config.metadataFile)) {
        const raw = fs.readFileSync(config.metadataFile, "utf-8");
        const parsed = JSON.parse(raw);
        // Issue #63 Етап 3: невідомі верхні ключі (напр. майбутні категорії)
        // зберігаємо — не втрачаємо дані попередніх/новіших форматів
        return {
          ...parsed,
          hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
          files: (parsed.files && typeof parsed.files === "object") ? parsed.files : {}
        };
      }
    } catch (e) {
      console.error("Error reading metadata:", e.message);
    }
    return { hidden: [], files: {} };
  }

  saveMetadata(metadata) {
    try {
      fs.writeFileSync(config.metadataFile, JSON.stringify(metadata, null, 2), "utf-8");
    } catch (e) {
      console.error("Error saving metadata:", e.message);
    }
  }

  // Get original name for an id (or return id itself if not found)
  getOriginalName(idOrName) {
    const meta = this.getMetadata();
    if (meta.files && meta.files[idOrName]) {
      return meta.files[idOrName].originalName || meta.files[idOrName];
    }
    return idOrName;
  }

  getFilesList(isTeacher = false) {
    const metadata = this.getMetadata();
    const hiddenSet = new Set(metadata.hidden);
    const fileMap = metadata.files || {};

    const allFiles = fs.readdirSync(config.dataDir, { withFileTypes: true })
      .filter(item => item.isFile() && !item.name.startsWith("."))
      .map(item => {
        const full = path.join(config.dataDir, item.name);
        const fileInfo = fileMap[item.name];
        const displayName = (fileInfo && fileInfo.originalName)
          ? fileInfo.originalName
          : item.name;

        return {
          id: item.name, // The unique disk identifier (e.g. file_1712345678_abcd.pdf)
          name: displayName, // User-friendly Ukrainian/Cyrillic title
          ext: path.extname(item.name).toLowerCase(),
          size: fs.statSync(full).size,
          hidden: hiddenSet.has(item.name),
          // Issue #63 Етап 3: опис матеріалу; старі записи без опису → порожній рядок
          description: (fileInfo && typeof fileInfo.description === "string")
            ? fileInfo.description
            : ""
        };
      })
      .filter(item => config.allowedExtensions.has(item.ext))
      .sort((a, b) => a.name.localeCompare(b.name, "uk"));

    if (isTeacher) {
      return allFiles;
    }

    // Students only see non-hidden files
    return allFiles.filter(item => !item.hidden);
  }

  toggleHide(idOrName, shouldHide) {
    const safe = safeFilename(idOrName);
    const filePath = getFilePath(safe);
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error("Файл не знайдено");
      error.status = 404;
      throw error;
    }

    const metadata = this.getMetadata();
    const hiddenSet = new Set(metadata.hidden);

    if (shouldHide) {
      hiddenSet.add(safe);
    } else {
      hiddenSet.delete(safe);
    }

    metadata.hidden = Array.from(hiddenSet);
    this.saveMetadata(metadata);

    return { ok: true, name: safe, hidden: shouldHide };
  }

  deleteFile(idOrName) {
    const safe = safeFilename(idOrName);
    const filePath = getFilePath(safe);
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error("Файл не знайдено");
      error.status = 404;
      throw error;
    }

    fs.unlinkSync(filePath);

    // Clean up from metadata
    const metadata = this.getMetadata();
    const hiddenSet = new Set(metadata.hidden);
    if (hiddenSet.has(safe)) {
      hiddenSet.delete(safe);
      metadata.hidden = Array.from(hiddenSet);
    }
    if (metadata.files && metadata.files[safe]) {
      delete metadata.files[safe];
    }
    this.saveMetadata(metadata);

    return { ok: true, name: safe };
  }

  // Issue #63 Етап 3: необов'язковий опис матеріалу (rawDescription) зберігається
  // в наявних метаданих files[id].description; порожній опис не записується,
  // тому формат записів без опису не змінюється (сумісність зі старими даними)
  async saveFileStream(requestStream, rawOriginalName, rawDescription) {
    const orig = path.basename(String(rawOriginalName || "").trim());
    if (!orig) {
      const error = new Error("Некоректне ім'я файлу");
      error.status = 400;
      throw error;
    }

    // Прибираємо керуючі символи, обрізаємо зайві пробіли й довжину
    const description = String(rawDescription || "")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .trim()
      .slice(0, config.maxDescriptionLength);

    const ext = path.extname(orig).toLowerCase();
    if (!config.allowedExtensions.has(ext)) {
      const error = new Error("Цей тип файлу не дозволено");
      error.status = 400;
      throw error;
    }

    // Generate safe ASCII ID: file_<timestamp>_<random><ext>
    const randomSuffix = crypto.randomBytes(3).toString("hex");
    const fileId = `file_${Date.now()}_${randomSuffix}${ext}`;
    const filePath = path.join(config.dataDir, fileId);

    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > config.maxUpload) {
          callback(new Error("Файл більший за 1 ГБ"));
        } else {
          callback(null, chunk);
        }
      }
    });

    try {
      await pipeline(
        requestStream,
        limiter,
        fs.createWriteStream(filePath, { flags: "wx" })
      );

      // Record correspondence in metadata
      const metadata = this.getMetadata();
      if (!metadata.files) metadata.files = {};
      metadata.files[fileId] = {
        originalName: orig,
        uploadedAt: Date.now(),
        size: bytes,
        // Опис додаємо лише за наявності — без опису запис ідентичний старому формату
        ...(description ? { description } : {})
      };
      this.saveMetadata(metadata);

      return {
        id: fileId,
        name: orig,
        size: bytes,
        description
      };
    } catch (error) {
      try { fs.unlinkSync(filePath); } catch {}
      throw error;
    }
  }

  getFilePath(name) {
    return getFilePath(name);
  }

  /**
   * Issue #4: чи доступний файл для ролі.
   * Приховані файли бачить лише викладач (за PIN).
   */
  canAccess(name, isTeacher = false) {
    if (isTeacher) return true;
    const metadata = this.getMetadata();
    const hiddenSet = new Set(metadata.hidden || []);
    return !hiddenSet.has(name);
  }
}

module.exports = new FileService();
