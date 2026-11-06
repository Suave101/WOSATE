// Local folder workspaces through the File System Access API: the workbench
// reads the .aadl files of a folder on disk, writes edits back, mirrors
// creations / deletions / renames, and notices changes made by other tools.
// Everything runs in the browser, so the site stays static.

const DB = "wosate-folder";
const STORE = "handles";
const AADL = /\.aadl2?$/i;
const SKIP = new Set(["node_modules", ".git", "dist", "out", "build"]);

export const folderSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

function idb(mode, fn, db = DB) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Remember the folder handle so the workspace reopens after a reload. */
export const rememberFolder = (handle) => idb("readwrite", (s) => (handle ? s.put(handle, "folder") : s.delete("folder"))).catch(() => {});
// A folder opened before the rename from WOWATE is remembered in the old database.
export const recallFolder = async () => {
  const handle = await idb("readonly", (s) => s.get("folder")).catch(() => null);
  return handle || idb("readonly", (s) => s.get("folder"), "wowate-folder").catch(() => null);
};

/** `granted`, `prompt` or `denied`; asking (`request`) needs a user gesture. */
export async function folderPermission(handle, request = false) {
  const opts = { mode: "readwrite" };
  // Origin-private folders have no permission API: they are always writable.
  if (!handle.queryPermission) return "granted";
  if ((await handle.queryPermission(opts)) === "granted") return "granted";
  if (!request) return "prompt";
  return (await handle.requestPermission?.(opts)) || "denied";
}

export async function pickFolder() {
  return window.showDirectoryPicker({ id: "wosate-workspace", mode: "readwrite" });
}

/** Every AADL file below `dir`: { name: "sub/dir/File.aadl", text, lastModified }. */
export async function readFolder(dir, prefix = "") {
  const out = [];
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind === "directory") {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      out.push(...(await readFolder(entry, `${prefix}${name}/`)));
    } else if (AADL.test(name)) {
      const file = await entry.getFile();
      out.push({ name: `${prefix}${name}`, text: await file.text(), lastModified: file.lastModified });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function parentOf(root, path, create) {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, base: parts.at(-1) };
}

export async function writeFile(root, path, text) {
  const { dir, base } = await parentOf(root, path, true);
  const fh = await dir.getFileHandle(base, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

export async function deleteFile(root, path) {
  try {
    const { dir, base } = await parentOf(root, path, false);
    await dir.removeEntry(base);
  } catch (e) {
    if (e.name !== "NotFoundError") throw e;
  }
}

/**
 * Two-way sync between the workspace files and a folder.
 * `push(files)` writes local changes (debounced); `poll()` brings in external changes.
 */
export class FolderSync {
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {{ onExternal: (files: {name,text}[]) => void, onError: (e: Error) => void, onSaved?: (n: number) => void }} cb
   */
  constructor(handle, { onExternal, onError, onSaved }) {
    this.handle = handle;
    this.name = handle.name;
    this.disk = new Map(); // path -> { text, lastModified } as last seen / written
    this.onExternal = onExternal;
    this.onError = onError;
    this.onSaved = onSaved;
    this.pending = null;
    this.timer = null;
    this.writing = Promise.resolve();
  }

  async load() {
    const files = await readFolder(this.handle);
    this.disk = new Map(files.map((f) => [f.name, { text: f.text, lastModified: f.lastModified }]));
    return files.map(({ name, text }) => ({ name, text }));
  }

  /** Queue the workspace state; writes and deletions happen after a short pause in typing. */
  push(files, delay = 300) {
    this.pending = files;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    const files = this.pending;
    this.pending = null;
    clearTimeout(this.timer);
    if (!files) return this.writing;
    this.writing = this.writing.then(async () => {
      let saved = 0;
      const names = new Set(files.map((f) => f.name));
      try {
        for (const f of files) {
          if (this.disk.get(f.name)?.text === f.text) continue;
          await writeFile(this.handle, f.name, f.text);
          const { dir, base } = await parentOf(this.handle, f.name, false);
          const lastModified = (await (await dir.getFileHandle(base)).getFile()).lastModified;
          this.disk.set(f.name, { text: f.text, lastModified });
          saved++;
        }
        for (const path of [...this.disk.keys()]) {
          if (names.has(path)) continue;
          await deleteFile(this.handle, path);
          this.disk.delete(path);
          saved++;
        }
        if (saved) this.onSaved?.(saved);
      } catch (e) {
        this.onError(e);
      }
    });
    return this.writing;
  }

  /** Re-scan the folder; report the full file list if another tool changed it. */
  async poll() {
    if (this.pending) return; // local edits win until they are written
    await this.writing;
    let files;
    try {
      files = await readFolder(this.handle);
    } catch (e) {
      this.onError(e);
      return;
    }
    const changed = files.length !== this.disk.size || files.some((f) => {
      const d = this.disk.get(f.name);
      return !d || (d.lastModified !== f.lastModified && d.text !== f.text);
    });
    if (!changed) return;
    this.disk = new Map(files.map((f) => [f.name, { text: f.text, lastModified: f.lastModified }]));
    this.onExternal(files.map(({ name, text }) => ({ name, text })));
  }

  destroy() {
    clearTimeout(this.timer);
  }
}
