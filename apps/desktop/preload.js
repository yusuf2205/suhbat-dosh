const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suhbatShell', {
  getDefaultServer: () => ipcRenderer.invoke('suhbat:get-default'),
  setServer: (url) => ipcRenderer.invoke('suhbat:set-server', url),
  checkUpdate: () => ipcRenderer.invoke('suhbat:update-check'),
  installUpdate: () => ipcRenderer.invoke('suhbat:update-install'),
  version: () => ipcRenderer.invoke('suhbat:version'),
  // screenshot protection: the window is left out of screen capture
  protect: (on) => ipcRenderer.invoke('suhbat:protect', !!on),
  openFile: (url, name) => ipcRenderer.invoke('suhbat:open-file', url, name),
  // custom notification windows (position / count are chosen in the settings)
  notify: (n) => ipcRenderer.invoke('suhbat:notify', n),
  notifClick: (chatId) => ipcRenderer.invoke('suhbat:notif-click', chatId),
  notifClose: () => ipcRenderer.invoke('suhbat:notif-close'),
  getNotifPrefs: () => ipcRenderer.invoke('suhbat:notif-get'),
  setNotifPrefs: (p) => ipcRenderer.invoke('suhbat:notif-set', p),
  // the tray menu: the page reports the unread count and the "do not disturb" time; the menu asks the page to go somewhere or to be quiet
  setState: (s) => ipcRenderer.invoke('suhbat:state', s),
  onGo: (cb) => ipcRenderer.on('suhbat:go', (_e, where) => cb(where)),
  onDnd: (cb) => ipcRenderer.on('suhbat:dnd', (_e, until) => cb(until)),
  onOpenChat: (cb) => ipcRenderer.on('suhbat:open-chat', (_e, id) => cb(id)),
  onUpdate: (cb) => ipcRenderer.on('suhbat:update', (_e, s) => cb(s)),
});
