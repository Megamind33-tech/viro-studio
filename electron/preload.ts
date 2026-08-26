import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("viroPress", {
  openFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke("press:open-file", filters),
  saveFile: (opts: { defaultPath: string; bytes: ArrayBuffer }) =>
    ipcRenderer.invoke("press:save-file", opts),
  listFonts: () => ipcRenderer.invoke("press:list-fonts"),
  readFont: (path: string) => ipcRenderer.invoke("press:read-font", path),
});
