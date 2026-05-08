const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

let db;
let dbPath;

// ── Database init ─────────────────────────────────────────────────
async function initDatabase() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules/sql.js/dist', file),
  });

  dbPath = path.join(app.getPath('userData'), 'stonemtn.db');

  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS store (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// Write the in-memory db back to disk after every change
function persistDb() {
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

// ── Window ────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  1024,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    title: 'Stone MTN Device Repair',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
}

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  await initDatabase();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: load all ─────────────────────────────────────────────────
ipcMain.handle('db-load-all', () => {
  const results = db.exec('SELECT key, value FROM store');
  if (!results.length) return {};
  const out = {};
  for (const [key, value] of results[0].values) {
    try { out[key] = JSON.parse(value); }
    catch { out[key] = value; }
  }
  return out;
});

// ── IPC: save all ─────────────────────────────────────────────────
ipcMain.handle('db-save-all', (_, data) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(data)) {
    stmt.run([k, JSON.stringify(v)]);
  }
  stmt.free();
  persistDb();
  return true;
});

// ── IPC: clear all ────────────────────────────────────────────────
ipcMain.handle('db-clear-all', () => {
  db.run('DELETE FROM store');
  persistDb();
  return true;
});

// ── IPC: export file (json backup or csv) ─────────────────────────
ipcMain.handle('db-export', async (_, content, suggestedName) => {
  const win  = BrowserWindow.getFocusedWindow();
  const isCSV = suggestedName && suggestedName.endsWith('.csv');
  const defaultPath = suggestedName || `stonemtn-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const filters = isCSV
    ? [{ name: 'CSV Spreadsheet', extensions: ['csv'] }]
    : [{ name: 'JSON Backup',     extensions: ['json'] }];
  const result = await dialog.showSaveDialog(win, { title: 'Save File', defaultPath, filters });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return true;
});

// ── IPC: import backup ────────────────────────────────────────────
ipcMain.handle('db-import', async () => {
  const win    = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title:      'Open Backup',
    filters:    [{ name: 'JSON Backup', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return fs.readFileSync(result.filePaths[0], 'utf8');
});
