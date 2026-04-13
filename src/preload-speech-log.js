const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("speechLogAPI", {
  get: () => ipcRenderer.invoke("speech-log:get"),
  clear: () => ipcRenderer.send("speech-log:clear"),
  onChanged: (cb) => ipcRenderer.on("speech-log:changed", cb),
});
