const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const config = require("../config");
const slideService = require("./slideService");
const { safeFilename } = require("../utils/fileHelpers");
const folderService = require("./folderService");
const { badRequest, notFound, conflict, forbidden } = folderService;

// Ensure data directory exists
fs.mkdirSync(config.dataDir, { recursive: true });

class FileService {
  getMetadata() {
    try {
      if (fs.existsSync(config.metadataFile)) {
        const raw = fs.readFileSync(config.metadataFile, "utf-8");
        const parsed = JSON.parse(raw);
        // Issue #63 Етап 3: невідомі верхні ключі (напр. май новіші форми)
        // зберігаємо — не втрачаємо дані попередніх/новіших форматів
        // Issue #88: додаємо folders[] для персональних просторів викладачів
        return {
          ...parsed,
          folders: Array.isArray(parsed.folders) ? parsed.folders : [],
          hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
          files: (parsed.files && typeof parsed.files === "object") ? parsed.files : {}
        };
      }
    } catch (e) {
      console.error("Error reading metadata:", e.message);
    }
    return { folders: [], hidden: [], files: {} };
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

  // Issue #63: перейменування категорії вчителем — змінюється лише назва;
  // id, порядок (order) і createdAt зберігаються, тому посилання матеріалів
  // на категорію не ламаються.
  renameCategory(categoryId, rawName) {
    const name = String(rawName || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 60);
    if (!name) throw Object.assign(new Error("Некоректна назва категорії"), { status: 400 });
    const metadata = this.getMetadata();
    if (!Array.isArray(metadata.categories)) metadata.categories = [];
    const category = metadata.categories.find(item => item.id === categoryId);
    if (!category) throw Object.assign(new Error("Категорію не знайдено"), { status: 404 });
    const duplicate = metadata.categories.some(item => item.id !== categoryId &&
      String(item.name).toLocaleLowerCase("uk") === name.toLocaleLowerCase("uk"));
    if (duplicate) throw Object.assign(new Error("Категорія з такою назвою вже існує"), { status: 409 });
    category.name = name;
    this.saveMetadata(metadata);
    return { ok: true, category };
  }

  // Issue #63: переміщення категорії вгору/вниз. Порядок (order 0..n-1)
  // зберігається в метаданих, тому переживає перезавантаження сторінки,
  // інший пристрій і перезапуск сервера. На межі списку — без змін (ідемпотентно).
  reorderCategory(categoryId, direction) {
    if (direction !== "up" && direction !== "down") {
      throw Object.assign(new Error("Напрямок має бути up або down"), { status: 400 });
    }
    const metadata = this.getMetadata();
    const categories = (Array.isArray(metadata.categories) ? metadata.categories : [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), "uk"));
    const index = categories.findIndex(item => item.id === categoryId);
    if (index === -1) throw Object.assign(new Error("Категорію не знайдено"), { status: 404 });
    const target = index + (direction === "up" ? -1 : 1);
    const moved = target >= 0 && target < categories.length;
    if (moved) {
      [categories[index], categories[target]] = [categories[target], categories[index]];
    }
    metadata.categories = categories.map((item, position) => ({ ...item, order: position }));
    this.saveMetadata(metadata);
    return { ok: true, moved, categories: this.getCategories() };
  }

  // Issue #88: файли викладача (за owner), опціонально в папці folderId
  getFilesForTeacher(teacherId, folderId) {
    const metadata = this.getMetadata();
    const files = Object.entries(metadata.files || {}).map(([fileId, info]) => ({
      id: fileId,
      ...(info && typeof info === "object" ? info : { originalName: typeof info === "string" ? info : fileId })
    })).filter((f) => f.owner === teacherId && (folderId === undefined || f.folderId === folderId));
    return files;
  }

  getFilesList(isTeacher = false, teacherId) {
    const metadata = this.getMetadata();
    const hiddenSet = new Set(metadata.hidden);
    const fileMap = metadata.files || {};
    const categories = Array.isArray(metadata.categories) ? metadata.categories : [];
    const categoryIds = new Set(categories.map(category => category.id));
    const order = Array.isArray(metadata.order) ? metadata.order : [];
    const orderIndex = new Map(order.map((id, index) => [id, index]));

    // Issue #88: викладач бачить лише свої файли (власного простору), адмін — усі
    let allFiles = fs.readdirSync(config.dataDir, { withFileTypes: true })
      .filter(item => item.isFile() && !item.name.startsWith("."))
      .map(item => {
        const full = path.join(config.dataDir, item.name);
        const rawInfo = fileMap[item.name];
        const info = rawInfo && typeof rawInfo === "object"
          ? rawInfo
          : { originalName: typeof rawInfo === "string" ? rawInfo : item.name };
        const ext = path.extname(item.name).toLowerCase();
        let conversionStatus = info.conversionStatus || "";
        let conversionError = typeof info.conversionError === "string" ? info.conversionError : "";
        if (config.slideExtensions.has(ext)) {
          const manifest = slideService.getManifest(item.name);
          const manifestReady = manifest && Number.isInteger(manifest.pageCount) && manifest.pageCount > 0;
          if (conversionStatus === "ready" && !manifestReady) {
            conversionStatus = "failed";
            conversionError = conversionError || "PNG-слайди відсутні або пошкоджені";
          } else if (!conversionStatus) {
            if (manifestReady) conversionStatus = "ready";
            else if (manifest && manifest.converting) conversionStatus = "converting";
            else conversionStatus = "pending";
          }
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
          conversionError,
          owner: info.owner || null,
          folderId: info.folderId || null
        };
      })
      .filter(item => config.allowedExtensions.has(item.ext))
      .sort((a, b) => {
        const aHasOrder = orderIndex.has(a.id), bHasOrder = orderIndex.has(b.id);
        if (aHasOrder !== bHasOrder) return aHasOrder ? 1 : -1;
        return aHasOrder ? a.order - b.order : a.name.localeCompare(b.name, "uk");
      });

    if (teacherId) {
      // Викладач бачить свої файли + спільні/legacy (owner === null) для копіювання
      allFiles = allFiles.filter((f) => f.owner === teacherId || f.owner === null);
    } else if (!isTeacher) {
      // Учням — лише публічні (не приховані) та готові
      allFiles = allFiles.filter((f) => !f.hidden && (!config.slideExtensions.has(f.ext) || f.conversionStatus === "ready"));
    }

    if (!isTeacher && !teacherId) {
      // Учням не передаємо порядок (поле order) або внутрішній стан конвертації.
      // Issue #63 Р: categoryId передається — він потрібен для групування каталогу
      // учня за категоріями (один матеріал — одна категорія); самі категорії віддає
      // GET /api/categories. Приховані та неготові матеріали відфільтровуються нижче
      // й не потрапляють у відповідь учню.
      // PDF/PPTX доступні лише після підтвердження готового маніфесту.
      return allFiles
        .filter(item => !item.hidden && (!config.slideExtensions.has(item.ext) || item.conversionStatus === "ready"))
        .map(({ id, name, ext, size, hidden, description, categoryId }) => ({ id, name, ext, size, hidden, description, categoryId }));
    }
    return allFiles;
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
    const record = this.getFileRecord(idOrName);
    if (!record) return;
    const safe = safeFilename(idOrName);
    const filePath = this.filePath(safe);
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
  // Issue #63: перейменування матеріалу вчителем — змінюється лише показна
  // назва (originalName у метаданих); ідентифікатор файлу, шлях до вмісту,
  // опис і категорія не змінюються, тому наявні посилання не ламаються.
  // Issue #88: лише власник файла (або адмін на рівні викликача) може перейменувати.
  // Legacy-файли (owner === null) доступні викладачам лише для перегляду і
  // копіювання — зміна/видалення заборонена.
  renameFile(teacherId, idOrName, rawName) {
    const safe = safeFilename(idOrName);
    const record = this.getFileRecord(safe);
    if (!record) {
      throw Object.assign(new Error("Файл не знайдено"), { status: 404 });
    }
    // TeacherId з сесії: null для адміна, інакше — ID викладача. Legacy-файли
    // (owner === null) не підлягають зміні жодним викладачем.
    if (teacherId && (!record.owner || record.owner !== teacherId)) {
      throw forbidden("Файл належить іншому викладачу або є спільним — зміна заборонена");
    }
    const name = String(rawName || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 120);
    if (!name) throw Object.assign(new Error("Некоректна назва матеріалу"), { status: 400 });
    const metadata = this.getMetadata();
    if (!metadata.files || typeof metadata.files !== "object") metadata.files = {};
    const current = metadata.files[safe];
    const base = current && typeof current === "object"
      ? current
      : { originalName: typeof current === "string" ? current : safe, uploadedAt: Date.now() };
    metadata.files[safe] = { ...base, originalName: name };
    this.saveMetadata(metadata);
    return { ok: true, file: safe, name };
  }

  // Issue #63: приховування/показ матеріалу від учнів; Issue #88: лише власник
  toggleHide(teacherId, idOrName, shouldHide) {
    const record = this.getFileRecord(idOrName);
    if (!record) {
      const error = new Error("Файл не знайдено");
      error.status = 404;
      throw error;
    }
    // Legacy-файли (owner === null) не підлягають зміні жодним викладачем.
    if (teacherId && (!record.owner || record.owner !== teacherId)) {
      throw forbidden("Файл належить іншому викладачу або є спільним — зміна заборонена");
    }
    const safe = safeFilename(idOrName);
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

  // Issue #63: видалення матеріалу; Issue #88: лише власник (або адмін на рівні викликача).
  // Legacy-файли (owner === null) не підлягають видаленню викладачем.
  deleteFile(teacherId, idOrName) {
    const record = this.getFileRecord(idOrName);
    if (!record) {
      const error = new Error("Файл не знайдено");
      error.status = 404;
      throw error;
    }
    // Legacy-файли (owner === null) не підлягають видаленню жодним викладачем.
    if (teacherId && (!record.owner || record.owner !== teacherId)) {
      throw forbidden("Файл належить іншому викладачу або є спільним — видалення заборонене");
    }
    const safe = safeFilename(idOrName);
    const filePath = this.filePath(safe);
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error("Файл не знайдено на диску");
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

  // Issue #63: переміщення файла в категорію; Issue #88: лише власник
  moveFileToCategory(teacherId, idOrName, categoryId = "") {
    const record = this.getFileRecord(idOrName);
    if (!record) throw Object.assign(new Error("Файл не знайдено"), { status: 404 });
    // Legacy-файли (owner === null) не підлягають зміні жодним викладачем.
    if (teacherId && (!record.owner || record.owner !== teacherId)) throw forbidden("Файл належить іншому викладачу або є спільним — зміна заборонена");
    const safe = safeFilename(idOrName);
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

  // Issue #63: зміна порядку файлів; Issue #88: лише власник файла
  reorderFile(teacherId, idOrName, direction) {
    if (direction !== "up" && direction !== "down") {
      throw Object.assign(new Error("Напрямок має бути up або down"), { status: 400 });
    }
    const record = this.getFileRecord(idOrName);
    if (!record) throw Object.assign(new Error("Файл не знайдено"), { status: 404 });
    // Legacy-файли (owner === null) не підлягають зміні жодним викладачем.
    if (teacherId && (!record.owner || record.owner !== teacherId)) throw forbidden("Файл належить іншому викладачу або є спільним — зміна заборонена");
    const safe = safeFilename(idOrName);
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

  /** Фізичний шлях до оригінального файла (для потокового читання) */
  filePath(fileId) {
    const metadata = this.getMetadata();
    const record = metadata.files && metadata.files[fileId];
    if (!record) return null;
    if (record.owner && record.folderId) {
      return folderService.filePhysicalPath(record.owner, record.folderId, fileId);
    }
    if (record.owner) {
      // Файл у корені персонального простору викладача (без папки)
      return path.join(config.dataDir, record.owner, fileId);
    }
    return path.join(config.dataDir, fileId);
  }

  /** Сумісність зі старим кодом: фізичний шлях до файла за його іменем (fileId) */
  getFilePath(fileId) {
    return this.filePath(fileId);
  }

  /** Владелець файла (teacherId або null для shared/legacy) */
  ownerOf(fileId) {
    const metadata = this.getMetadata();
    const record = metadata.files && metadata.files[fileId];
    return record ? (record.owner || null) : null;
  }

  /** Чи належить файл викладачу (або адміну — перевірка на рівні викликача) */
  isOwner(teacherId, fileId) {
    return this.ownerOf(fileId) === teacherId;
  }

  /** Файли викладача (за owner), опціонально в папці folderId */
  getFilesForTeacher(teacherId, folderId) {
    const metadata = this.getMetadata();
    const files = Object.entries(metadata.files || {}).map(([fileId, info]) => ({
      id: fileId,
      ...(info && typeof info === "object" ? info : { originalName: typeof info === "string" ? info : fileId })
    })).filter((f) => f.owner === teacherId && (folderId === undefined || f.folderId === folderId));
    return files;
  }

  /** Копіювання файла у власну папку іншого (או того самого) викладача.
   * Створює новий file ID, незалежний фізичний файл і власні метадані.
   * Оригінал не змінюється. Для PDF/PPT/PPTX створюється власний manifest/PNG-набір.
   */
  async copyFile({ sourceFileId, targetTeacherId, targetFolderId }) {
    if (!folderService.isSafeId(targetTeacherId)) throw badRequest("Некоректний ідентифікатор викладача");
    const sourceRecord = this.getFileRecord(sourceFileId);
    if (!sourceRecord) throw notFound("Вихідний файл не знайдено");
    // Читаємо вміст оригіналу
    const srcPath = this.filePath(sourceFileId);
    if (!srcPath || !fs.existsSync(srcPath)) throw notFound("Файл не знайдено на диску");
    const origName = sourceRecord.originalName || sourceFileId;
    const ext = path.extname(origName).toLowerCase();
    if (!config.allowedExtensions.has(ext)) throw badRequest("Цей тип файлу не дозволено");

    // Створюємо новий запис через saveFileStream з вмістом оригіналу
    const stream = fs.createReadStream(srcPath);
    const result = await this.saveFileStream(stream, origName, sourceRecord.description || "", sourceRecord.categoryId || "", targetTeacherId, targetFolderId);
    return result;
  }

  getFileRecord(fileId) {
    const metadata = this.getMetadata();
    const record = metadata.files && metadata.files[fileId];
    return record || null;
  }

  /** Видалити файл (лише власник або адмін — перевірка на рівні викликача) */
  deleteFile(teacherId, idOrName) {
    const safe = safeFilename(idOrName);
    const filePath = this.filePath(safe);
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error("Файл не знайдено");
      error.status = 404;
      throw error;
    }
    const record = this.getFileRecord(safe);
    if (record && record.owner && record.owner !== teacherId) {
      throw forbidden("Файл належить іншому викладачу");
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

    // Also delete cached slides
    slideService.clearSlides(safe);

    return { ok: true, name: safe };
  }

  /**
   * Issue #63 Етап 3: необов'язковий опис матеріалу (rawDescription) зберігається
   * в наявних метаданих files[id].description; порожній опис не записується,
   * тому формат записів без опису не змінюється (сумісність зі старими даними)
   * Issue #88: файл зберігається у materials/<teacherId>/<folderId>/<fileId>.<ext>
   * (legacy завантаження без teacherId — у корінь materials/)
   */
  async saveFileStream(requestStream, rawOriginalName, rawDescription, rawCategoryId, teacherId, folderId) {
    const orig = path.basename(String(rawOriginalName || "").trim());
    if (!orig) {
      const error = new Error("Некоректне ім'я файлу");
      error.status = 400;
      throw error;
    }

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

    // Issue #88: папка має належати викладачу; фізичний шлях — матеріали
    // <teacherId>/<folderId> (папки створюються ліниво при першому файлі).
    let targetDir;
    if (teacherId && folderId) {
      const folder = folderService.getFolder(folderId);
      if (!folder) throw notFound("Папку не знайдено");
      if (folder.teacherId !== teacherId) throw forbidden("Папка належить іншому викладачу");
      targetDir = path.join(folderService.teacherRootPath(teacherId), String(folderId));
    } else if (teacherId) {
      targetDir = path.join(config.dataDir, teacherId);
    } else {
      targetDir = config.dataDir;
    }
    if (!targetDir) {
      const error = new Error("Некоректний простір зберігання");
      error.status = 400;
      throw error;
    }
    fs.mkdirSync(targetDir, { recursive: true });

    const randomSuffix = crypto.randomBytes(3).toString("hex");
    const fileId = `file_${Date.now()}_${randomSuffix}${ext}`;
    const filePath = path.join(targetDir, fileId);

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

      const metadata = this.getMetadata();
      if (!metadata.files) metadata.files = {};
      const categoryId = String(rawCategoryId || "");
      if (categoryId && !(Array.isArray(metadata.categories) && metadata.categories.some(category => category.id === categoryId))) {
        fs.unlinkSync(filePath);
        throw Object.assign(new Error("Категорію не знайдено"), { status: 400 });
      }
      const record = {
        owner: teacherId || null,
        folderId: folderId || null,
        originalName: orig,
        uploadedAt: Date.now(),
        size: bytes,
        ...(description ? { description } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(config.slideExtensions.has(ext) ? { conversionStatus: "converting" } : {})
      };
      metadata.files[fileId] = record;
      if (!Array.isArray(metadata.order)) metadata.order = [];
      metadata.order = metadata.order.filter(id => id !== fileId);
      metadata.order.push(fileId);
      this.saveMetadata(metadata);

      return {
        id: fileId,
        name: orig,
        size: bytes,
        description,
        owner: record.owner,
        folderId: record.folderId
      };
    } catch (error) {
      try { fs.unlinkSync(filePath); } catch {}
      throw error;
    }
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

  /**
   * Issue #63 (доробка §3): чи матеріал зараз прихований.
   * Використовується станом демонстрації (/api/state → blocked): щойно
   * викладач приховує матеріал, який демонструється, клієнти учнів мають
   * негайно прибрати його з екрана.
   */
  isHidden(name) {
    const safe = safeFilename(name);
    if (!safe) return false;
    const metadata = this.getMetadata();
    return new Set(metadata.hidden || []).has(safe);
  }
}

module.exports = new FileService();
