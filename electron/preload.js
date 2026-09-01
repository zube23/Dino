'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dino', {
  canDrag: true, // native drag-out to CypCut works only in the desktop app
  listParts: () => ipcRenderer.invoke('parts:list'),
  addParts: (files) => ipcRenderer.invoke('parts:add', files),
  updatePart: (id, patch) => ipcRenderer.invoke('parts:update', id, patch),
  removePart: (id) => ipcRenderer.invoke('parts:remove', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  generate: (req) => ipcRenderer.invoke('nest:generate', req),
  openSheet: (id) => ipcRenderer.invoke('sheet:open', id),
  saveSheet: (id) => ipcRenderer.invoke('sheet:saveAs', id),
  dragSheet: (id) => ipcRenderer.send('sheet:dragStart', id),
  listHistory: () => ipcRenderer.invoke('history:list'),
  removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
  pickExe: () => ipcRenderer.invoke('dialog:pickExe'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onToast: (cb) => ipcRenderer.on('app:toast', (ev, msg) => cb(String(msg))),
});
