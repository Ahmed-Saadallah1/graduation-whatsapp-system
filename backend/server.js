/**
 * GRADUATION SEATING -> WHATSAPP NOTIFIER
 * Backend service (v2 - config lives here, not in the Sheet)
 * ------------------------------------------------------------
 * - Serves a local dashboard (Settings + Ushers + Activity) at "/"
 * - Receives edit events from the Google Sheet's Apps Script at /api/sheet-edit
 * - Sends WhatsApp messages via Baileys, using your own linked number
 *
 * First run: a QR code prints in the terminal - scan it once with
 * WhatsApp > Linked Devices. The session is saved in ./auth afterward.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const store = require('./store');
const logic = require('./logic');

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'auth');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock;
let isReady = false;
let currentQR = null;      // raw QR payload string while waiting to be scanned
let linkedNumber = null;   // the WhatsApp number currently linked, once connected
let relinking = false;     // true while we've intentionally logged out to force a fresh QR

// --- Send queue: paces messages so bursts don't look like spam ---
const queue = [];
let processing = false;
const GAP_MS = 700;

function enqueueMessage(jid, text) {
  queue.push({ jid, text });
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const { jid, text } = queue.shift();
    try {
      await sock.sendMessage(jid, { text });
      console.log('Sent to', jid);
    } catch (err) {
      console.error('Failed to send to', jid, err.message);
    }
    if (queue.length > 0) await new Promise(r => setTimeout(r, GAP_MS));
  }
  processing = false;
}

function formatMessage({ usherName, graduateId, graduateName, department, serial }) {
  let msg = `🎓 New graduate for you, ${usherName}:\n\n`;
  msg += `Serial: ${serial}\n`;
  msg += `ID: ${graduateId}\n`;
  msg += `Name: ${graduateName}\n`;
  if (department) msg += `Department: ${department}\n`;
  return msg;
}

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        currentQR = qr;
        console.log('\nScan this QR code with WhatsApp > Linked Devices (or use the "WhatsApp" tab in the dashboard):\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        isReady = true;
        relinking = false;
        currentQR = null;
        linkedNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
        console.log('✅ WhatsApp connected and ready.' + (linkedNumber ? ` (linked number: +${linkedNumber})` : ''));
      }
      if (connection === 'close') {
        isReady = false;
        linkedNumber = null;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed.', shouldReconnect ? 'Reconnecting...' : 'Logged out - scan a new QR code (dashboard "WhatsApp" tab) to relink.');
        if (shouldReconnect) setTimeout(startWhatsApp, 3000);
      }
    });
  } catch (err) {
    // Never let a WhatsApp connection failure take down the dashboard/API -
    // the rest of the backend (Settings, Ushers, Activity) should keep working
    // even if WhatsApp itself can't connect right now. Retry in the background.
    isReady = false;
    console.error('WhatsApp connection error:', err.message);
    console.log('Retrying in 5 seconds... (dashboard and API remain available)');
    setTimeout(startWhatsApp, 5000);
  }
}

/**
 * Forces a fresh QR code, e.g. to link a different number as a Plan B during
 * the event, or if the current session gets logged out unexpectedly.
 * Logs out the current session (if any), wipes the saved auth, and restarts
 * the connection so a brand-new QR is generated.
 */
async function relinkWhatsApp() {
  relinking = true;
  isReady = false;
  currentQR = null;
  linkedNumber = null;
  try {
    if (sock) await sock.logout().catch(() => {});
  } catch { /* ignore - we're wiping the session anyway */ }
  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error('Could not clear auth folder:', err.message);
  }
  startWhatsApp();
}

// ============================================================
// DASHBOARD API - Settings
// ============================================================
app.get('/api/settings', (req, res) => {
  res.json(store.getSettings());
});

app.post('/api/settings', (req, res) => {
  const saved = store.saveSettings(req.body);
  res.json(saved);
});

// ============================================================
// DASHBOARD API - Ushers
// ============================================================
app.get('/api/ushers', (req, res) => {
  res.json(store.getUshers());
});

app.post('/api/ushers', (req, res) => {
  const { name, phone, range } = req.body || {};
  if (!name || !phone || !range) {
    return res.status(400).json({ error: 'name, phone, and range are all required' });
  }
  const parsedRange = logic.parseRange(range);
  if (!parsedRange) {
    return res.status(400).json({ error: 'Range must look like "L108-L112" or "R1-R10"' });
  }
  const ushers = store.getUshers();
  const newUsher = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    phone: logic.normalizePhone(phone),
    range,
    side: parsedRange.side,
    start: parsedRange.start,
    end: parsedRange.end,
  };
  ushers.push(newUsher);
  store.saveUshers(ushers);
  res.json(newUsher);
});

app.put('/api/ushers/:id', (req, res) => {
  const ushers = store.getUshers();
  const idx = ushers.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usher not found' });

  const { name, phone, range } = req.body || {};
  const parsedRange = logic.parseRange(range);
  if (!parsedRange) return res.status(400).json({ error: 'Range must look like "L108-L112" or "R1-R10"' });

  ushers[idx] = {
    ...ushers[idx],
    name,
    phone: logic.normalizePhone(phone),
    range,
    side: parsedRange.side,
    start: parsedRange.start,
    end: parsedRange.end,
  };
  store.saveUshers(ushers);
  res.json(ushers[idx]);
});

app.delete('/api/ushers/:id', (req, res) => {
  const ushers = store.getUshers().filter(u => u.id !== req.params.id);
  store.saveUshers(ushers);
  res.json({ ok: true });
});

// ============================================================
// DASHBOARD API - Live Google Sheet test/preview
// ============================================================
// Reads the *live* Google Sheet directly (no upload, no file) so the
// dashboard can confirm the link + tab names are right and suggest a column
// mapping, just before the event when you finally know the real tab names.
// Requires the Sheet's sharing to be set to "Anyone with the link - Viewer".
app.post('/api/sheet/test', async (req, res) => {
  try {
    const { sheetUrl, tabs } = req.body || {};
    const sheetId = logic.extractSheetId(sheetUrl);
    if (!sheetId) {
      return res.status(400).json({ error: 'That does not look like a Google Sheets link. Copy the full URL from your browser\'s address bar.' });
    }

    const sides = ['L', 'R'];
    const results = {};

    for (const side of sides) {
      const tabName = (tabs && tabs[side] && tabs[side].sheetTabName || '').trim();
      if (!tabName) {
        results[side] = { ok: false, error: 'No tab name entered yet for this side.' };
        continue;
      }
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
      try {
        const resp = await fetch(csvUrl);
        if (!resp.ok) {
          results[side] = {
            ok: false,
            error: resp.status === 400
              ? `No tab named "${tabName}" was found in this sheet.`
              : `Could not reach the sheet (HTTP ${resp.status}). Make sure sharing is set to "Anyone with the link - Viewer".`,
          };
          continue;
        }
        const text = await resp.text();
        // A private/unreachable sheet still returns 200 with an HTML error page.
        if (/^\s*<HTML/i.test(text)) {
          results[side] = { ok: false, error: 'Sheet is not accessible. Set sharing to "Anyone with the link - Viewer" and try again.' };
          continue;
        }
        const rows = logic.parseCsv(text);
        if (!rows.length) {
          results[side] = { ok: false, error: `Tab "${tabName}" was found but looks empty.` };
          continue;
        }
        const headers = rows[0];
        const sampleRows = rows.slice(1, 6);
        const suggestedMapping = {};
        headers.forEach((header, i) => {
          const field = logic.guessFieldForHeader(header);
          if (field && !suggestedMapping[field]) {
            suggestedMapping[field] = logic.indexToColumnLetter(i);
          }
        });
        results[side] = { ok: true, tabName, headers, sampleRows, suggestedMapping, rowCount: rows.length - 1 };
      } catch (err) {
        results[side] = { ok: false, error: `Could not reach Google Sheets: ${err.message}` };
      }
    }

    res.json({ sheetId, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected error testing the sheet.' });
  }
});

// ============================================================
// DASHBOARD API - WhatsApp linking (QR + Plan B relink)
// ============================================================
app.get('/api/whatsapp/status', (req, res) => {
  res.json({ connected: isReady, linkedNumber, qr: currentQR, relinking });
});

// Forces a brand-new QR code - use this to link a different number during
// the event (Plan B) or to recover from an unexpected logout.
app.post('/api/whatsapp/relink', async (req, res) => {
  relinkWhatsApp();
  res.json({ status: 'relinking' });
});

// ============================================================
// DASHBOARD API - Activity log
// ============================================================
app.get('/api/activity', (req, res) => {
  res.json(store.getSentLog().slice(0, 100));
});

app.get('/api/status', (req, res) => {
  res.json({ whatsappReady: isReady, queueLength: queue.length });
});

// ============================================================
// MAIN ENTRY POINT - called by Apps Script on every sheet edit
// ============================================================
app.post('/api/sheet-edit', (req, res) => {
  try {
    const { tab, row, editedColumn, values } = req.body || {};
    if (!tab || !row || !editedColumn || !values) {
      return res.status(400).json({ status: 'error', message: 'Malformed request' });
    }

    const settings = store.getSettings();
    const incomingTab = String(tab).trim().toLowerCase();
    const side = ['L', 'R'].find(s => (settings.sheetTabs[s].sheetTabName || '').trim().toLowerCase() === incomingTab);
    if (!side) {
      return res.json({ status: 'ignored', message: `"${tab}" doesn't match either configured tab name (check the Sheet tab in the dashboard)` });
    }
    const tabConfig = settings.sheetTabs[side];

    // Only act when the edited cell is the configured phone column
    if (editedColumn.toUpperCase() !== tabConfig.phoneCol.toUpperCase()) {
      return res.json({ status: 'ignored' });
    }

    const rawPhone = values[tabConfig.phoneCol];
    if (!rawPhone) {
      return res.json({ status: 'ignored', message: 'Phone cell cleared' });
    }

    const phone = logic.normalizePhone(rawPhone);
    if (!logic.isValidPhone(phone)) {
      return res.json({ status: 'invalid', message: 'Invalid phone: must be 11 digits starting with 01' });
    }

    if (store.wasAlreadySent(side, row)) {
      return res.json({ status: 'sent', message: 'Already sent previously' });
    }

    const serialRaw = values[tabConfig.serialCol];
    const serial = logic.parseSerial(serialRaw, side);
    if (!serial) {
      return res.json({ status: 'error', message: `Could not read serial from column ${tabConfig.serialCol}` });
    }

    const ushers = store.getUshers();
    const usher = logic.findUsherForSerial(serial, ushers);
    if (!usher) {
      return res.json({ status: 'no-usher', message: `No usher range covers ${side}${serial.num}` });
    }
    if (!logic.isValidPhone(usher.phone)) {
      return res.json({ status: 'error', message: `Usher phone for ${usher.name} looks invalid` });
    }

    if (!isReady) {
      return res.status(503).json({ status: 'error', message: 'WhatsApp is not connected right now' });
    }

    const graduateId = values[tabConfig.idCol];
    const graduateName = values[tabConfig.nameCol];
    const department = tabConfig.deptCol ? values[tabConfig.deptCol] : '';
    const serialLabel = `${serial.side}${serial.num}`;

    const text = formatMessage({ usherName: usher.name, graduateId, graduateName, department, serial: serialLabel });
    enqueueMessage(logic.phoneToJid(usher.phone), text);

    store.appendSentLog({
      tab: side,
      sheetTabName: tab,
      row,
      serial: serialLabel,
      graduateId,
      graduateName,
      usherName: usher.name,
      usherPhone: usher.phone,
      status: 'sent',
    });

    res.json({ status: 'sent', message: `Sent to ${usher.name}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Manual test endpoint - lets you send a one-off message without the Sheet
app.post('/send', (req, res) => {
  const { usherPhone, usherName, graduateId, graduateName, department, serial } = req.body || {};
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not connected yet' });
  if (!usherPhone || !usherName || !graduateId || !graduateName || !serial) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const jid = usherPhone.includes('@s.whatsapp.net') ? usherPhone : `${usherPhone}@s.whatsapp.net`;
  enqueueMessage(jid, formatMessage({ usherName, graduateId, graduateName, department, serial }));
  res.status(200).json({ status: 'queued' });
});

app.get('/health', (req, res) => res.json({ whatsappReady: isReady, queueLength: queue.length }));

// Safety net: log unexpected errors instead of letting the whole server
// crash mid-event. The dashboard and API stay up even if something in the
// WhatsApp connection misbehaves unexpectedly.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server stays running):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays running):', err);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  startWhatsApp();
});