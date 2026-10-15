// Suhbat-dosh desktop shell. The UI and all business logic live on the user's own server (same web client),
// so there is nothing to duplicate here: this process only remembers the server address and hosts a window.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, net, session, shell } = require('electron');
const os = require('node:os');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SERVER = 'https://suhbat-dosh.uz';
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('empty');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
  return u.origin;
}

let win = null;
let tray = null;
const startHidden = process.argv.includes('--hidden');
let serverOrigin = readConfig().server || DEFAULT_SERVER;

// Calls and voice messages need a secure context. A plain-http server on your own network is trusted
// explicitly (only the configured origin); an https domain needs no exception.
if (serverOrigin && serverOrigin.startsWith('http:')) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', serverOrigin);
}

function showConnect(error) {
  const q = new URLSearchParams({ def: serverOrigin || DEFAULT_SERVER });
  if (error) q.set('error', error);
  win.loadFile(path.join(__dirname, 'connect.html'), { search: q.toString() });
}

function openServer() {
  if (!serverOrigin) return showConnect();
  win.loadURL(serverOrigin).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 360, minHeight: 480,
    show: !startHidden, title: 'Suhbat-dosh', backgroundColor: '#fbc700', autoHideMenuBar: process.platform !== 'darwin',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  // Identify the shell to the web client (it shows "change server" in settings).
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} SuhbatShell/desktop SuhbatApp/${app.getVersion()}`);

  // Only the configured server (and our local connect page) may load inside the window.
  win.webContents.on('will-navigate', (e, url) => {
    const ok = url.startsWith('file://') || (serverOrigin && new URL(url).origin === serverOrigin);
    if (!ok) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^tg:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    if (/^https?:/.test(url)) {
      if (serverOrigin && new URL(url).origin === serverOrigin) return { action: 'allow' };
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith('file://')) showConnect(`${desc} (${serverOrigin})`);
  });
  openServer();
  // like Telegram: closing the window keeps the app (and its connection) running in the tray
  win.on('close', (e) => {
    if (!app.isQuitting && tray) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 20, height: 20 });
    tray = new Tray(img);
  } catch { tray = null; return; }
  tray.setToolTip('Suhbat-dosh');
  const cfg = () => readConfig();
  const menu = () => Menu.buildFromTemplate([
    { label: 'Открыть Suhbat-dosh', click: showWindow },
    { type: 'separator' },
    {
      label: 'Запускать при входе в систему', type: 'checkbox', checked: cfg().autostart !== false,
      click: (i) => { writeConfig({ ...readConfig(), autostart: i.checked }); applyAutostart(); },
    },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
}

function applyAutostart() {
  try {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: readConfig().autostart !== false, openAsHidden: true, args: ['--hidden'] });
  } catch { /* unsupported platform */ }
}

function buildMenu() {
  const t = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Suhbat-dosh',
      submenu: [
        { label: 'Сменить сервер… / Serverni almashtirish…', accelerator: 'CmdOrCtrl+Shift+S', click: () => win && showConnect() },
        { label: 'Перезагрузить', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
        { type: 'separator' },
        ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

// ---- self-update: installers and latest.yml live in <server>/downloads (your own server)
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;
let updateState = { state: 'idle' };

function pushUpdate(s) {
  updateState = s;
  win?.webContents.send('suhbat:update', s);
}

function feedUrl() {
  return process.env.SUHBAT_UPDATE_URL || `${serverOrigin || DEFAULT_SERVER}/downloads`;
}

autoUpdater.on('update-available', (i) => pushUpdate({ state: 'available', version: i.version }));
autoUpdater.on('update-not-available', () => pushUpdate({ state: 'none' }));
autoUpdater.on('download-progress', (p) => pushUpdate({ ...updateState, state: 'available', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (i) => pushUpdate({ state: 'downloaded', version: i.version }));
autoUpdater.on('error', (e) => pushUpdate({ state: 'error', message: String(e?.message || e).slice(0, 200) }));

async function checkUpdates() {
  if (!app.isPackaged && !process.env.SUHBAT_UPDATE_URL) return { state: 'none' };
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() });
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r?.updateInfo?.version;
    if (v && v !== app.getVersion() && updateState.state !== 'downloaded') return { state: 'available', version: v };
    return updateState.state === 'downloaded' ? updateState : { state: 'none' };
  } catch (e) {
    return { state: 'error', message: String(e?.message || e).slice(0, 200) };
  }
}

ipcMain.handle('suhbat:update-check', () => checkUpdates());
ipcMain.handle('suhbat:update-install', () => { autoUpdater.quitAndInstall(false, true); });
ipcMain.handle('suhbat:version', () => app.getVersion());

// ---- notification windows: like Telegram Desktop, in the chosen screen corner, up to N at a time
const popups = []; // { win, timer }
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const notifPrefs = () => {
  const c = readConfig();
  return { corner: CORNERS.includes(c.notifCorner) ? c.notifCorner : 'br', count: Math.min(5, Math.max(1, Number(c.notifCount) || 3)) };
};

function layoutPopups() {
  const { corner } = notifPrefs();
  const wa = require('electron').screen.getPrimaryDisplay().workArea;
  const W = 340;
  const H = 88;
  const gap = 8;
  popups.forEach((p, i) => {
    const x = corner.endsWith('r') ? wa.x + wa.width - W - 12 : wa.x + 12;
    const off = 12 + i * (H + gap);
    const y = corner.startsWith('b') ? wa.y + wa.height - H - off : wa.y + off;
    if (!p.win.isDestroyed()) p.win.setBounds({ x, y, width: W, height: H });
  });
}

function closePopup(p) {
  clearTimeout(p.timer);
  const i = popups.indexOf(p);
  if (i >= 0) popups.splice(i, 1);
  if (!p.win.isDestroyed()) p.win.close();
  layoutPopups();
}

ipcMain.handle('suhbat:notify', (_e, n) => {
  const title = String(n?.title || 'Suhbat-dosh').slice(0, 80);
  const body = String(n?.body || '').slice(0, 200);
  const chat = Number(n?.chat_id) || 0;
  const { count } = notifPrefs();
  while (popups.length >= count) closePopup(popups[0]);
  const w = new BrowserWindow({
    width: 340, height: 88, frame: false, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
    transparent: true, hasShadow: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  const p = { win: w, timer: setTimeout(() => closePopup(p), 7000), chat };
  popups.push(p);
  p.win.on('closed', () => { const i = popups.indexOf(p); if (i >= 0) popups.splice(i, 1); layoutPopups(); });
  w.loadFile(path.join(__dirname, 'notif.html'), { query: { title, body, chat: String(chat) } });
  w.once('ready-to-show', () => { layoutPopups(); w.showInactive(); });
  return true;
});
ipcMain.handle('suhbat:notif-click', (e, chatId) => {
  const p = popups.find((x) => x.win.webContents === e.sender);
  if (p) closePopup(p);
  showWindow();
  if (chatId && win) win.webContents.send('suhbat:open-chat', chatId);
});
ipcMain.handle('suhbat:notif-close', (e) => {
  const p = popups.find((x) => x.win.webContents === e.sender);
  if (p) closePopup(p);
});
ipcMain.handle('suhbat:notif-get', () => notifPrefs());
ipcMain.handle('suhbat:notif-set', (_e, p) => {
  const cur = notifPrefs();
  const next = { corner: CORNERS.includes(p?.corner) ? p.corner : cur.corner, count: Math.min(5, Math.max(1, Number(p?.count) || cur.count)) };
  writeConfig({ ...readConfig(), notifCorner: next.corner, notifCount: next.count });
  layoutPopups();
  return next;
});

// "Open" a received file in the program the system associates with it (Word, Excel, PDF reader ...)
ipcMain.handle('suhbat:open-file', async (_e, url, name) => {
  const u = new URL(String(url));
  if (!serverOrigin || u.origin !== serverOrigin) throw new Error('foreign origin');
  const res = await net.fetch(u.href, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-open-'));
  const safe = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const file = path.join(dir, safe);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  return true;
});

ipcMain.handle('suhbat:get-default', () => serverOrigin || DEFAULT_SERVER);
ipcMain.handle('suhbat:set-server', async (_e, input) => {
  const origin = normalizeServer(input);
  // reachability probe before saving: /healthz is unauthenticated. A slow tunnel must not block the
  // user, so: up to 3 tries of 15 s, and a timeout / network error is not fatal for https servers.
  let hardFail = null;
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${origin}/healthz`, { signal: ctl.signal });
      const j = await r.json();
      if (j.status !== 'ok') { hardFail = new Error('not a Suhbat-dosh server'); }
      else hardFail = null;
      break;
    } catch (e) {
      hardFail = origin.startsWith('https:') ? null : e; // https + timeout: open anyway, the page retries itself
    } finally {
      clearTimeout(timer);
    }
  }
  if (hardFail) throw hardFail;
  const needsFlag = origin.startsWith('http:') && origin !== serverOrigin;
  serverOrigin = origin;
  writeConfig({ ...readConfig(), server: origin });
  if (needsFlag) {
    // the secure-context exception is a start-up switch: restart once so calls and voice work
    app.relaunch();
    app.exit(0);
    return origin;
  }
  openServer();
  return origin;
});

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => { app.isQuitting = true; });
  app.whenReady().then(() => {
    // microphone (voice messages) and notifications are granted only to the configured server
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      let ok = false;
      try { ok = ['media', 'notifications', 'clipboard-sanitized-write'].includes(permission) && new URL(wc.getURL()).origin === serverOrigin; } catch { /* file:// */ }
      cb(ok);
    });
    buildMenu();
    createTray();
    applyAutostart();
    createWindow();
    // quiet background check shortly after start, then every 6 hours
    setTimeout(() => checkUpdates(), 15_000);
    setInterval(() => checkUpdates(), 6 * 3600 * 1000);
    app.on('activate', () => showWindow());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
void Notification; void dialog;
