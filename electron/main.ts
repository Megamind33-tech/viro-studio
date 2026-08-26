import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#1F1F1F",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const url = process.env.VITE_DEV_SERVER_URL;
  if (url) win.loadURL(url);
  else win.loadFile(join(here, "../dist/index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("press:open-file", async (_e, filters?: Electron.FileFilter[]) => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: filters ?? [{ name: "All", extensions: ["*"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const path = r.filePaths[0];
  const data = await readFile(path);
  return { path, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

ipcMain.handle("press:save-file", async (_e, opts: { defaultPath: string; bytes: ArrayBuffer }) => {
  const r = await dialog.showSaveDialog({ defaultPath: opts.defaultPath });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, Buffer.from(opts.bytes));
  return r.filePath;
});

const FONT_EXT = new Set([".ttf", ".otf", ".woff"]);

function fontDirs(): string[] {
  const dirs: string[] = [];
  if (process.platform === "win32") {
    const windir = process.env.WINDIR || "C:\\Windows";
    dirs.push(join(windir, "Fonts"));
    dirs.push(join(app.getPath("home"), "AppData", "Local", "Microsoft", "Windows", "Fonts"));
  } else if (process.platform === "darwin") {
    dirs.push("/System/Library/Fonts", "/Library/Fonts", join(app.getPath("home"), "Library", "Fonts"));
  } else {
    dirs.push("/usr/share/fonts", join(app.getPath("home"), ".local/share/fonts"), join(app.getPath("home"), ".fonts"));
  }
  return dirs.map((d) => resolve(d));
}

function isFontPath(path: string): boolean {
  const resolved = resolve(path);
  return fontDirs().some((dir) => resolved === dir || resolved.startsWith(dir + sep));
}

function parseFontFile(fileName: string): { family: string; style: string; name: string } {
  const known: Record<string, { family: string; style: string }> = {
    "arial.ttf": { family: "Arial", style: "Regular" },
    "arialbd.ttf": { family: "Arial", style: "Bold" },
    "ariali.ttf": { family: "Arial", style: "Italic" },
    "arialbi.ttf": { family: "Arial", style: "Bold Italic" },
    "times.ttf": { family: "Times New Roman", style: "Regular" },
    "timesbd.ttf": { family: "Times New Roman", style: "Bold" },
    "timesi.ttf": { family: "Times New Roman", style: "Italic" },
    "timesbi.ttf": { family: "Times New Roman", style: "Bold Italic" },
    "cour.ttf": { family: "Courier New", style: "Regular" },
    "courbd.ttf": { family: "Courier New", style: "Bold" },
    "couri.ttf": { family: "Courier New", style: "Italic" },
    "courbi.ttf": { family: "Courier New", style: "Bold Italic" },
    "georgia.ttf": { family: "Georgia", style: "Regular" },
    "georgiab.ttf": { family: "Georgia", style: "Bold" },
    "georgiai.ttf": { family: "Georgia", style: "Italic" },
    "georgiaz.ttf": { family: "Georgia", style: "Bold Italic" },
    "verdana.ttf": { family: "Verdana", style: "Regular" },
    "verdanab.ttf": { family: "Verdana", style: "Bold" },
    "verdanai.ttf": { family: "Verdana", style: "Italic" },
    "verdanaz.ttf": { family: "Verdana", style: "Bold Italic" },
    "tahoma.ttf": { family: "Tahoma", style: "Regular" },
    "tahomabd.ttf": { family: "Tahoma", style: "Bold" },
    "calibri.ttf": { family: "Calibri", style: "Regular" },
    "calibrib.ttf": { family: "Calibri", style: "Bold" },
    "calibrii.ttf": { family: "Calibri", style: "Italic" },
    "calibriz.ttf": { family: "Calibri", style: "Bold Italic" },
    "segoeui.ttf": { family: "Segoe UI", style: "Regular" },
    "segoeuib.ttf": { family: "Segoe UI", style: "Bold" },
    "segoeuii.ttf": { family: "Segoe UI", style: "Italic" },
    "segoeuiz.ttf": { family: "Segoe UI", style: "Bold Italic" },
    "comic.ttf": { family: "Comic Sans MS", style: "Regular" },
    "comicbd.ttf": { family: "Comic Sans MS", style: "Bold" },
    "impact.ttf": { family: "Impact", style: "Regular" },
    "trebuc.ttf": { family: "Trebuchet MS", style: "Regular" },
    "trebucbd.ttf": { family: "Trebuchet MS", style: "Bold" },
    "trebucit.ttf": { family: "Trebuchet MS", style: "Italic" },
    "consola.ttf": { family: "Consolas", style: "Regular" },
    "consolab.ttf": { family: "Consolas", style: "Bold" },
    "constan.ttf": { family: "Constantia", style: "Regular" },
    "gadugi.ttf": { family: "Gadugi", style: "Regular" },
    "malgun.ttf": { family: "Malgun Gothic", style: "Regular" },
    "micross.ttf": { family: "Microsoft Sans Serif", style: "Regular" },
  };
  const hit = known[fileName.toLowerCase()];
  if (hit) {
    const name = hit.style === "Regular" ? hit.family : `${hit.family} ${hit.style}`;
    return { ...hit, name };
  }
  const base = fileName.replace(/\.(ttf|otf|woff)$/i, "").replace(/[-_]+/g, " ");
  return { family: base, style: "Regular", name: base };
}

ipcMain.handle("press:list-fonts", async () => {
  const out: { id: string; family: string; style: string; name: string; path: string }[] = [];
  for (const dir of fontDirs()) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!FONT_EXT.has(extname(name).toLowerCase())) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size < 1000) continue;
      } catch {
        continue;
      }
      const parsed = parseFontFile(name);
      out.push({
        id: `sys-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        family: parsed.family,
        style: parsed.style,
        name: parsed.name,
        path,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});

ipcMain.handle("press:read-font", async (_e, path: string) => {
  if (typeof path !== "string" || !isFontPath(path)) return null;
  if (!FONT_EXT.has(extname(path).toLowerCase())) return null;
  const data = await readFile(path);
  return { path, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});
