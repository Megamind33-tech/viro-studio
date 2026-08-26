import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
