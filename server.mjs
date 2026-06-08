import { createServer } from "node:http";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const storageRoot = process.env.STORAGE_DIR || root;
const dataDir = process.env.DATA_DIR || join(storageRoot, "data");
const uploadsDir = process.env.UPLOADS_DIR || join(storageRoot, "uploads");
const backupsDir = join(dataDir, "backups");
const libraryPath = join(dataDir, "library.json");
const port = Number(process.env.PORT || 5176);
const adminPassword = process.env.ADMIN_PASSWORD || "stracon2026";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip"
};

await mkdir(dataDir, { recursive: true });
await mkdir(uploadsDir, { recursive: true });
await mkdir(backupsDir, { recursive: true });
await ensureLibrary();

createServer(async (req, res) => {
  try {
    if (req.url === "/api/library" && req.method === "GET") {
      const library = await readLibrary();
      sendJson(res, library);
      return;
    }

    if (req.url === "/api/admin/verify" && req.method === "POST") {
      if (req.headers["x-admin-password"] !== adminPassword) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      sendJson(res, { ok: true });
      return;
    }

    if (req.url === "/api/admin/recovery" && req.method === "GET") {
      if (req.headers["x-admin-password"] !== adminPassword) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "No autorizado" }));
        return;
      }
      sendJson(res, await recoveryReport());
      return;
    }

    if (req.url === "/api/library" && req.method === "POST") {
      if (req.headers["x-admin-password"] !== adminPassword) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "No autorizado" }));
        return;
      }
      const body = await readBody(req);
      const library = JSON.parse(body);
      const current = await readLibrary();
      await persistUploadedFiles(library);
      const merged = mergeLibraries(current, library);
      merged.version = Date.now();
      merged.updatedAt = merged.version;
      await backupLibrary(current);
      await writeFile(libraryPath, JSON.stringify(merged, null, 2));
      sendJson(res, merged);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Error servidor: ${error.message}`);
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`STRACON Docs listo en http://0.0.0.0:${port}/simple.html`);
});

async function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://localhost:${port}`).pathname;
  if (pathname.startsWith("/uploads/")) {
    await serveFileFromBase(res, uploadsDir, pathname.slice("/uploads/".length));
    return;
  }

  const target = pathname === "/" ? "/simple.html" : pathname;
  await serveFileFromBase(res, root, target);
}

async function serveFileFromBase(res, baseDir, target) {
  const safePath = normalize(decodeURIComponent(target)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(baseDir, safePath);

  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": types[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No encontrado");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 250 * 1024 * 1024) reject(new Error("Archivo demasiado grande. Sube menos documentos a la vez."));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function ensureLibrary() {
  try {
    await stat(libraryPath);
  } catch {
    const bundledLibrary = join(root, "data", "library.json");
    try {
      await cp(bundledLibrary, libraryPath);
      await cp(join(root, "uploads"), uploadsDir, { recursive: true, force: false });
    } catch {
      await writeFile(libraryPath, JSON.stringify(defaultLibrary(), null, 2));
    }
  }
}

async function readLibrary() {
  return JSON.parse(await readFile(libraryPath, "utf8"));
}

function mergeLibraries(current, incoming) {
  const deletedIds = mergeDeletedIds(current.deletedIds, incoming.deletedIds);
  const folders = mergeItems(current.folders, incoming.folders, deletedIds);
  const files = mergeItems(current.files, incoming.files, deletedIds);
  const prunedFolders = pruneFolders(folders, deletedIds);
  const prunedFiles = pruneFiles(files, prunedFolders, deletedIds);

  return {
    ...current,
    ...incoming,
    folders: prunedFolders,
    files: prunedFiles,
    deletedIds
  };
}

function mergeItems(currentItems = [], incomingItems = [], deletedIds = {}) {
  const byId = new Map();

  for (const item of currentItems) {
    if (!item?.id) continue;
    byId.set(item.id, normalizeItem(item));
  }

  for (const item of incomingItems) {
    if (!item?.id) continue;
    const normalized = normalizeItem(item);
    const existing = byId.get(normalized.id);
    if (!existing || itemTime(normalized) > itemTime(existing)) {
      byId.set(normalized.id, {
        ...existing,
        ...normalized,
        url: normalized.url || existing?.url,
        mime: normalized.mime || existing?.mime
      });
    }
  }

  return [...byId.values()]
    .filter((item) => !isDeleted(item, deletedIds))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function mergeDeletedIds(currentDeleted = {}, incomingDeleted = {}) {
  const deletedIds = { ...currentDeleted };
  for (const [id, value] of Object.entries(incomingDeleted || {})) {
    deletedIds[id] = Math.max(Number(deletedIds[id] || 0), Number(value || 0));
  }
  return deletedIds;
}

function normalizeItem(item) {
  return {
    ...item,
    updatedAt: Number(item.updatedAt || item.createdAt || 0),
    createdAt: Number(item.createdAt || item.updatedAt || 0)
  };
}

function itemTime(item) {
  return Number(item.updatedAt || item.createdAt || 0);
}

function isDeleted(item, deletedIds) {
  return Number(deletedIds[item.id] || 0) >= itemTime(item);
}

function pruneFolders(folders, deletedIds) {
  const roots = new Set(["root", "root-electricos", "root-obras-civil"]);
  let changed = true;
  let kept = folders.filter((folder) => !isDeleted(folder, deletedIds));

  while (changed) {
    changed = false;
    const folderIds = new Set(kept.map((folder) => folder.id));
    const next = kept.filter((folder) => roots.has(folder.parent) || folderIds.has(folder.parent));
    changed = next.length !== kept.length;
    kept = next;
  }

  return kept;
}

function pruneFiles(files, folders, deletedIds) {
  const validParents = new Set(["root", "root-electricos", "root-obras-civil", ...folders.map((folder) => folder.id)]);
  return files.filter((file) => validParents.has(file.parent) && !isDeleted(file, deletedIds));
}

async function backupLibrary(library) {
  const version = library.version || library.updatedAt || Date.now();
  const backupPath = join(backupsDir, `library-${version}.json`);
  await writeFile(backupPath, JSON.stringify(library, null, 2));
}

async function recoveryReport() {
  const library = await readLibrary();
  const referencedFiles = new Set(
    (library.files || [])
      .map((file) => file.url)
      .filter(Boolean)
      .map((url) => basename(decodeURIComponent(url)))
  );
  const uploads = await fileList(uploadsDir, "/uploads/");
  const backups = await fileList(backupsDir, "/api/admin/backups/");

  return {
    library: {
      version: library.version,
      updatedAt: library.updatedAt,
      folders: library.folders?.length || 0,
      files: library.files?.length || 0
    },
    uploads: uploads.map((file) => ({
      ...file,
      referenced: referencedFiles.has(file.name)
    })),
    orphanUploads: uploads.filter((file) => !referencedFiles.has(file.name)),
    backups
  };
}

async function fileList(dir, urlPrefix) {
  try {
    const names = await readdir(dir);
    const files = [];
    for (const name of names) {
      const filePath = join(dir, name);
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      files.push({
        name,
        url: `${urlPrefix}${encodeURIComponent(name)}`,
        size: info.size,
        modifiedAt: info.mtime.toISOString()
      });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function sendJson(res, value) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}

async function persistUploadedFiles(library) {
  if (!Array.isArray(library.files)) return;

  for (const file of library.files) {
    if (!file?.data?.startsWith?.("data:")) continue;

    const match = file.data.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) continue;

    const mime = match[1];
    const base64 = match[2];
    const ext = cleanExt(file.ext || extensionFromMime(mime) || "bin");
    const filename = `${file.id || Date.now()}-${safeName(file.name || "documento")}.${ext}`;
    const filePath = join(uploadsDir, filename);

    await writeFile(filePath, Buffer.from(base64, "base64"));
    file.url = `/uploads/${filename}`;
    file.mime = mime;
    delete file.data;
  }
}

function cleanExt(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
}

function safeName(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "documento";
}

function extensionFromMime(mime) {
  const map = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/csv": "csv",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt",
    "application/zip": "zip"
  };
  return map[mime];
}

function defaultLibrary() {
  const version = Date.now();
  return {
    version,
    updatedAt: version,
    folders: [
      { id: "art", kind: "folder", parent: "root", name: "ART", color: "blue" },
      { id: "certificados-cursos", kind: "folder", parent: "root", name: "Certificados de Cursos", color: "yellow" },
      { id: "certificados-herramientas", kind: "folder", parent: "root", name: "Certificados Herramientas", color: "gray" },
      { id: "cursos", kind: "folder", parent: "root", name: "Cursos", color: "purple" },
      { id: "difusiones", kind: "folder", parent: "root", name: "Difusiones x Cuadrillas", color: "green" },
      { id: "examenes", kind: "folder", parent: "root", name: "Examenes Preocupacionales", color: "orange" },
      { id: "hds", kind: "folder", parent: "root", name: "HDS", color: "gray" },
      { id: "plan-rigging", kind: "folder", parent: "root", name: "Plan Rigging", color: "yellow" },
      { id: "procedimientos", kind: "folder", parent: "root", name: "Procedimientos", color: "blue" },
      { id: "trabajador-sebastian", kind: "folder", parent: "certificados-cursos", name: "Sebastian Alejandro Cid Grandon", color: "yellow" },
      { id: "trabajador-dagoberto", kind: "folder", parent: "certificados-cursos", name: "Dagoberto Alexis Matus Leiva", color: "yellow" },
      { id: "trabajador-alex", kind: "folder", parent: "certificados-cursos", name: "Alex Anibal Montoya Esparza", color: "yellow" },
      { id: "trabajador-denis", kind: "folder", parent: "certificados-cursos", name: "Denis Eduardo Navarro Canales", color: "yellow" },
      { id: "trabajador-segundo", kind: "folder", parent: "certificados-cursos", name: "Segundo Ivan Ahumada Contreras", color: "yellow" },
      { id: "trabajador-marcelo", kind: "folder", parent: "certificados-cursos", name: "Marcelo Antonio Canales Varela", color: "yellow" },
      { id: "trabajador-patricio", kind: "folder", parent: "certificados-cursos", name: "Patricio Alejandro Salgado Diaz", color: "yellow" },
      { id: "trabajador-rodrigo", kind: "folder", parent: "certificados-cursos", name: "Rodrigo Patricio Segovia Araya", color: "yellow" }
    ],
    files: []
  };
}
