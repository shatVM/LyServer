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

  getCategories() {
    const metadata = this.getMetadata();
    return (Array.isArray(metadata.categories) ? metadata.categories : [])
      .filter(item => item && typeof item.id === "string" && typeof item.name === "string")
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, "uk"));
  }

  createCategory(rawName) {
    const name = String(rawName || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 60);
    if (!name) throw Object.assign(new Error("Введіть назву категорії"), { status: 400 });
    const metadata = this.getMetadata();
    if (!Array.isArray(metadata.categories)) metadata.categories = [];
    if (metadata.categories.some(category => category.name.toLocaleLowerCase("uk") === name.toLocaleLowerCase("uk"))) {
      throw Object.assign(new Error("Категорія з такою назвою вже існує"), { status: 409 });
    }
    const category = {
      id: "category_" + crypto.randomBytes(6).toString("hex"),
      name,
      order: metadata.categories.length,
      createdAt: Date.now()
    };
    metadata.categories.push(category);
    this.saveMetadata(metadata);
    return category;
  }

  deleteCategory(categoryId) {
    const metadata = this.getMetadata();
    if (!Array.isArray(metadata.categories)) metadata.categories = [];
    const category = metadata.categories.find(item => item.id === categoryId);
    if (!category) throw Object.assign(new Error("Категорію не знайдено"), { status: 404 });
    metadata.categories = metadata.categories.filter(item => item.id !== categoryId)
      .map((item, index) => ({ ...item, order: index }));
    let affectedFiles = 0;
    for (const [id, rawInfo] of Object.entries(metadata.files || {})) {
      if (rawInfo && typeof rawInfo === "object" && rawInfo.categoryId === categoryId) {
        metadata.files[id] = { ...rawInfo, categoryId: "" };
        affectedFiles++;
      }
    }
    this.saveMetadata(metadata);
    return { ok: true, categoryId, affectedFiles };
  }

  getFilesList(isTeacher = false) {
    const metadata = this.getMetadata();
    const hiddenSet = new Set(metadata.hidden);
    const fileMap = metadata.files || {};
    const categories = Array.isArray(metadata.categories) ? metadata.categories : [];
    const categoryIds = new Set(categories.map(category => category.id));
    const order = Array.isArray(metadata.order) ? metadata.order : [];
    const orderIndex = new Map(order.map((id, index) => [id, index]));

    const allFiles = fs.readdirSync(config.dataDir, { withFileTypes: true })
      .filter(item => item.isFile() && !item.name.startsWith("."))
      .map(item => {
        const full = path.join(config.dataDir, item.name);
        const rawInfo = fileMap[item.name];
        const info = rawInfo && typeof rawInfo === "object"
          ? rawInfo
          : { originalName: typeof rawInfo === "string" ? rawInfo : item.name };
        const ext = path.extname(item.name).toLowerCase();
        let conversionStatus = info.conversionStatus || "";
        if (config.slideExtensions.has(ext) && !conversionStatus) {
          try {
            const manifest = JSON.parse(fs.readFileSync(path.join(config.slidesDir, item.name, "manifest.json"), "utf-8"));
            if (Number.isInteger(manifest.pageCount) && manifest.pageCount > 0) conversionStatus = "ready";
          } catch { conversionStatus = "pending"; }
        }
        return {
          id: item.name,
          name: info.originalName || item.name,
          ext,
          size: fs.statSync(full).size,
          hidden: hiddenSet.has(item.name),
          description: typeof info.description === "string" ? info.description : "",
          categoryId: categoryIds.has(info.categoryId) ? info.categoryId : "",
          order: orderIndex.has(item.name) ? orderIndex.get(item.name) : Number.MAX_SAFE_INTEGER,
          conversionStatus,
          conversionError: typeof info.conversionError === "string" ? info.conversionError : ""
        };
      })
      .filter(item => config.allowedExtensions.has(item.ext))
      .sort((a, b) => {
        const aHasOrder = orderIndex.has(a.id), bHasOrder = orderIndex.has(b.id);
        if (aHasOrder !== bHasOrder) return aHasOrder ? 1 : -1;
        return aHasOrder ? a.order - b.order : a.name.localeCompare(b.name, "uk");
      });

    if (isTeacher) return allFiles;
    // Учням не передаємо категорії, порядок або внутрішній стан конвертації.
    // PDF/PPTX доступні лише після підтвердження готового маніфесту.
    return allFiles
      .filter(item => !item.hidden &&
        (!config.slideExtensions.has(item.ext) || item.conversionStatus === "ready"))
      .map(({ id, name, ext, size, hidden, description }) => ({ id, name, ext, size, hidden, description }));
  }

  moveFileToCategory(idOrName, categoryId = "") {
    const safe = safeFilename(idOrName);
    const filePath = getFilePath(safe);
    if (!filePath || !fs.existsSync(filePath)) throw Object.assign(new Error("Файл не знайдено"), { status: 404 });
    const validCategory = String(categoryId || "");
    if (validCategory && !this.getCategories().some(category => category.id === validCategory)) {
      throw Object.assign(new Error("Категорію не знайдено"), { status: 404 });
    }
    const metadata = this.getMetadata();
    if (!metadata.files || typeof metadata.files !== "object") metadata.files = {};
    const current = metadata.files[safe];
    metadata.files[safe] = {
      ...(current && typeof current === "object" ? current : { originalName: typeof current === "string" ? current : safe }),
      categoryId: validCategory
    };
    this.saveMetadata(metadata);
    return { ok: true, file: safe, categoryId: validCategory };
  }

  reorderFile(idOrName, direction) {
    if (direction !== "up" && direction !== "down") {
      throw Object.assign(new Error("Напрямок має бути up або down"), { status: 400 });
    }
    const safe = safeFilename(idOrName);
    const filePath = getFilePath(safe);
    if (!filePath || !fs.existsSync(filePath)) throw Object.assign(new Error("Файл не знайдено"), { status: 404 });
    const metadata = this.getMetadata();
    const all = this.getFilesList(true);
    const current = all.find(item => item.id === safe);
    if (!current) throw Object.assign(new Error("Файл не знайдено"), { status: 404 });
    const group = all.filter(item => item.categoryId === current.categoryId);
    const currentIndex = group.findIndex(item => item.id === safe);
    const targetIndex = currentIndex + (direction === "up" ? -1 : 1);
    const ordered = all.map(item => item.id);
    if (targetIndex >= 0 && targetIndex < group.length) {
      const a = ordered.indexOf(group[currentIndex].id);
      const b = ordered.indexOf(group[targetIndex].id);
      [ordered[a], ordered[b]] = [ordered[b], ordered[a]];
    }
    metadata.order = ordered;
    this.saveMetadata(metadata);
    return { ok: true, order: ordered };
  }

  setConversionStatus(idOrName, status, errorMessage = "") {
    const safe = safeFilename(idOrName);
    const filePath = getFilePath(safe);
    if (!filePath || !fs.existsSync(filePath)) return;
    const metadata = this.getMetadata();
    if (!metadata.files || typeof metadata.files !== "object") metadata.files = {};
    const current = metadata.files[safe];
    metadata.files[safe] = {
      ...(current && typeof current === "object" ? current : { originalName: typeof current === "string" ? current : safe }),
      conversionStatus: status
    };
    if (errorMessage) metadata.files[safe].conversionError = String(errorMessage).slice(0, 500);
    else delete metadata.files[safe].conversionError;
    this.saveMetadata(metadata);
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
    if (Array.isArray(metadata.order)) metadata.order = metadata.order.filter(id => id !== safe);
    this.saveMetadata(metadata);

    return { ok: true, name: safe };
  }

  // Issue #63 Етап 3: необов'язковий опис матеріалу (rawDescription) зберігається
  // в наявних метаданих files[id].description; порожній опис не записується,
  // тому формат записів без опису не змінюється (сумісність зі старими даними)
  async saveFileStream(requestStream, rawOriginalName, rawDescription, rawCategoryId = "") {
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
      const categoryId = String(rawCategoryId || "");
      if (categoryId && !(Array.isArray(metadata.categories) && metadata.categories.some(category => category.id === categoryId))) {
        fs.unlinkSync(filePath);
        throw Object.assign(new Error("Категорію не знайдено"), { status: 400 });
      }
      metadata.files[fileId] = {
        originalName: orig,
        uploadedAt: Date.now(),
        size: bytes,
        ...(description ? { description } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(config.slideExtensions.has(ext) ? { conversionStatus: "converting" } : {})
      };
      if (!Array.isArray(metadata.order)) metadata.order = [];
      metadata.order = metadata.order.filter(id => id !== fileId);
      metadata.order.push(fileId);
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
