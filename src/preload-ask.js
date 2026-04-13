const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("askAPI", {
  submit: (q) => ipcRenderer.send("ask-submit", q),
  cancel: () => ipcRenderer.send("ask-cancel"),
});
