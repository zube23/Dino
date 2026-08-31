'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dino', {
  listParts: () => ipcRenderer.invoke('parts:list'),
  addParts: (files) => ipcRenderer.invoke('parts:add', files),
  updatePart: (id, patch) => ipcRenderer.invoke('parts:update', id, patch),
  removePart: (id) => ipcRenderer.invoke('parts:remove', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  generate: (req) => ipcRenderer.invoke('nest:generate', req),
  openFile: (p) => ipcRenderer.invoke('file:open', p),
  showInFolder: (p) => ipcRenderer.invoke('file:showInFolder', p),
  listHistory: () => ipcRenderer.invoke('history:list'),
  removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
  pickExe: () => ipcRenderer.invoke('dialog:pickExe'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  appInfo: () => ipcRenderer.invoke('app:info'),
});
