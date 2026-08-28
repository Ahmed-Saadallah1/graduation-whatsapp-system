const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USHERS_FILE = path.join(DATA_DIR, 'ushers.json');
const SENTLOG_FILE = path.join(DATA_DIR, 'sentlog.json');

const DEFAULT_SETTINGS = {
  sheetTabs: {
    L: { serialCol: 'A', idCol: 'B', nameCol: 'C', deptCol: 'D', phoneCol: 'E' },
    R: { serialCol: 'A', idCol: 'B', nameCol: 'C', deptCol: 'D', phoneCol: 'E' },
  },
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- Settings ---
function getSettings() {
  return readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
}
function saveSettings(settings) {
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

// --- Ushers ---
function getUshers() {
  return readJson(USHERS_FILE, []);
}
function saveUshers(ushers) {
  writeJson(USHERS_FILE, ushers);
  return ushers;
}

// --- Sent log (duplicate prevention + activity feed) ---
function getSentLog() {
  return readJson(SENTLOG_FILE, []);
}
function appendSentLog(entry) {
  const log = getSentLog();
  log.unshift({ ...entry, timestamp: new Date().toISOString() }); // newest first
  // Keep the log from growing forever - last 1000 entries is plenty
  writeJson(SENTLOG_FILE, log.slice(0, 1000));
}
function wasAlreadySent(tab, row) {
  const log = getSentLog();
  return log.some(e => e.tab === tab && e.row === row && e.status === 'sent');
}

module.exports = {
  getSettings,
  saveSettings,
  getUshers,
  saveUshers,
  getSentLog,
  appendSentLog,
  wasAlreadySent,
};
