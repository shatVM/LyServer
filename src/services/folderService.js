/**
 * folderService.js — персональні простори папок викладачів (Issue #88, Етап 1).
 *
 * Фізична схема (за рішенням власника):
 *   materials/<teacherId>/<folderId>/<fileId>.<ext>
 * Фізичні сегменти шляхів — лише безпечні ID (teacherId, folderId, fileId),
 * ніяких довільних назв користувача у шляхах. Ім'я/ПІБ ніколи не потрапляють
 * у фізичний шлях.
 *
 * Батьківські зв'язки папок і порядок файлів зберігаються у .metadata.json:
 *   folders[] = { id, teacherId, parentId, name, createdAt }
 *   files[fileId].folderId — папка, в якій лежить файл (null = кореневий простір)
 *   files[fileId].owner — teacherId власника (null = shared/legacy)
 *
 * Всі операції синхронні (однопоточний Node), читають/пишуть .metadata.json
 * атомарно (tmp + rename), як fileService.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

/** Безпечний ID (teacherId/folderId/fileId уже hex, але перевіряємо формально) */
function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) && id.length >= 1 && id.length <= 128;
}

/** Читання метаданих (свіже з диска, як fileService.getMetadata) */
function readMetadata() {
  let raw;
  try {
    raw = fs.readFileSync(config.metadataFile, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, files: {}, folders: [], order: [], categories: [], hidden: [] };
    }
    throw new Error("Не вдалося прочитати метадані матеріалів");
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Файл метаданих пошкоджений (.metadata.json)");
  }
  if (!data || typeof data !== "object") {
    throw new Error("Файл метаданих має некоректну структуру");
  }
  if (!Array.isArray(data.folders)) data.folders = [];
  if (!data.files || typeof data.files !== "object") data.files = {};
  if (!Array.isArray(data.order)) data.order = [];
  if (!Array.isArray(data.categories)) data.categories = [];
  if (!Array.isArray(data.hidden)) data.hidden = [];
  return data;
}

function writeMetadata(data) {
  fs.mkdirSync(path.dirname(config.metadataFile), { recursive: true });
  const tmp = `${config.metadataFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, config.metadataFile);
  } catch (error) {
    try {
      fs.copyFileSync(tmp, config.metadataFile);
      fs.unlinkSync(tmp);
    } catch {
      throw error;
    }
  }
}

/** Папка викладача: `materials/<teacherId>/` */
function teacherRootPath(teacherId) {
  if (!isSafeId(teacherId)) return null;
  return path.join(config.dataDir, String(teacherId));
}

/** Фізичний шлях файла: `materials/<teacherId>/<folderId>/<fileId>.<ext>` */
function filePhysicalPath(teacherId, folderId, fileName) {
  if (!isSafeId(teacherId) || !isSafeId(folderId)) return null;
  const base = path.basename(String(fileName || ""));
  if (!base || base !== String(fileName)) return null;
  if (!config.allowedExtensions.has(path.extname(base).toLowerCase())) return null;
  return path.join(config.dataDir, String(teacherId), String(folderId), base);
}

class FolderService {
  /** Отримати папку за ID */
  getFolder(folderId) {
    if (!isSafeId(folderId)) return null;
    const data = readMetadata();
    return data.folders.find((f) => f.id === folderId) || null;
  }

  /** Список папок викладача (включаючи вкладені) */
  listFolders(teacherId) {
    const data = readMetadata();
    return data.folders.filter((f) => f.teacherId === teacherId);
  }

  /** Дерево папок викладача (корені + вкладені) */
  folderTree(teacherId) {
    const folders = this.listFolders(teacherId);
    const byId = new Map(folders.map((f) => [f.id, { ...f, children: [] }]));
    const roots = [];
    for (const f of folders) {
      const node = byId.get(f.id);
      if (f.parentId && byId.has(f.parentId)) {
        byId.get(f.parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }
    roots.sort((a, b) => a.name.localeCompare(b.name, "uk"));
    for (const node of byId.values()) {
      node.children.sort((a, b) => a.name.localeCompare(b.name, "uk"));
    }
    return roots;
  }

  /** Створити папку */
  createFolder({ teacherId, name, parentId }) {
    if (!isSafeId(teacherId)) throw badRequest("Некоректний ідентифікатор викладача");
    const folderName = String(name || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 60);
    if (!folderName) throw badRequest("Не вказано назву папки");
    let parent = null;
    if (parentId !== undefined && parentId !== null && parentId !== "") {
      if (!isSafeId(parentId)) throw badRequest("Некоректний ID батьківської папки");
      parent = this.getFolder(parentId);
      if (!parent) throw notFound("Батьківську папку не знайдено");
      if (parent.teacherId !== teacherId) throw forbidden("Папка належить іншому викладачу");
    }
    const data = readMetadata();
    if (
      data.folders.some(
        (f) => f.teacherId === teacherId && f.name === folderName && f.parentId === (parentId || null)
      )
    ) {
      throw conflict("Папка з такою назвою вже існує в цьому просторі");
    }
    const folderId = "folder_" + crypto.randomBytes(6).toString("hex");
    const folder = {
      id: folderId,
      teacherId,
      parentId: parentId || null,
      name: folderName,
      createdAt: Date.now()
    };
    data.folders.push(folder);
    writeMetadata(data);
    return folder;
  }

  /** Перейменувати папку */
  renameFolder({ teacherId, folderId, name }) {
    if (!isSafeId(folderId)) throw badRequest("Некоректний ID папки");
    const folder = this.getFolder(folderId);
    if (!folder) throw notFound("Папку не знайдено");
    if (folder.teacherId !== teacherId) throw forbidden("Папка належить іншому викладачу");
    const folderName = String(name || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 60);
    if (!folderName) throw badRequest("Не вказано назву папки");
    const data = readMetadata();
    if (
      data.folders.some(
        (f) => f.id !== folderId && f.teacherId === teacherId && f.name === folderName && f.parentId === folder.parentId
      )
    ) {
      throw conflict("Папка з такою назвою вже існує в цьому просторі");
    }
    folder.name = folderName;
    writeMetadata(data);
    return { ok: true, folder };
  }

  /** Чи є childId нащадком ancestorId (захист від циклів) */
  isDescendantOf(childId, ancestorId) {
    let current = this.getFolder(childId);
    let depth = 0;
    while (current && current.parentId && depth < 1000) {
      if (current.parentId === ancestorId) return true;
      current = this.getFolder(current.parentId);
      depth++;
    }
    return false;
  }

  /** Перемістити папку */
  moveFolder({ teacherId, folderId, parentId }) {
    if (!isSafeId(folderId)) throw badRequest("Некоректний ID папки");
    const folder = this.getFolder(folderId);
    if (!folder) throw notFound("Папку не знайдено");
    if (folder.teacherId !== teacherId) throw forbidden("Папка належить іншому викладачу");
    let parent = null;
    if (parentId !== undefined && parentId !== null && parentId !== "") {
      if (!isSafeId(parentId)) throw badRequest("Некоректний ID батьківської папки");
      parent = this.getFolder(parentId);
      if (!parent) throw notFound("Батьківську папку не знайдено");
      if (parent.teacherId !== teacherId) throw forbidden("Батьківська папка належить іншому викладачу");
      if (this.isDescendantOf(folderId, parentId)) throw badRequest("Не можна перемістити папку у власний нащадок");
    }
    const data = readMetadata();
    const f = data.folders.find((x) => x.id === folderId);
    f.parentId = parentId || null;
    writeMetadata(data);
    return { ok: true, folder: f };
  }

  /** Видалити порожню папку (без дочірніх папок і файлів) */
  deleteFolder({ teacherId, folderId }) {
    if (!isSafeId(folderId)) throw badRequest("Некоректний ID папки");
    const folder = this.getFolder(folderId);
    if (!folder) throw notFound("Папку не знайдено");
    if (folder.teacherId !== teacherId) throw forbidden("Папка належить іншому викладачу");
    const data = readMetadata();
    const hasChildren = data.folders.some((f) => f.parentId === folderId);
    const hasFiles = Object.entries(data.files || {}).some(([, f]) => f && f.folderId === folderId);
    if (hasChildren || hasFiles) throw conflict("Папку не порожньою — видалення не дозволено");
    data.folders = data.folders.filter((f) => f.id !== folderId);
    writeMetadata(data);
    return { ok: true, folderId };
  }
}

module.exports = new FolderService();
module.exports.badRequest = badRequest;
module.exports.notFound = notFound;
module.exports.conflict = conflict;
module.exports.forbidden = forbidden;
module.exports.isSafeId = isSafeId;
module.exports.filePhysicalPath = filePhysicalPath;
module.exports.teacherRootPath = teacherRootPath;
