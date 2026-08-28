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

const path = require('path');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const store = require('./store');
const logic = require('./logic');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

let sock;
let isReady = false;

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
        console.log('\nScan this QR code with WhatsApp > Linked Devices:\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        isReady = true;
        console.log('✅ WhatsApp connected and ready.');
      }
      if (connection === 'close') {
        isReady = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed.', shouldReconnect ? 'Reconnecting...' : 'Logged out - delete ./auth and restart to relink.');
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
// DASHBOARD API - Import (drag-and-drop sheet preview)
// ============================================================
// Parses an uploaded .xlsx or .csv file so the dashboard can preview its
// structure and suggest a column mapping - this never touches the live
// Google Sheet. It's purely a convenience to fill in Settings correctly.
app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const detectedTabs = {};
    const otherSheetNames = [];

    workbook.SheetNames.forEach(sheetName => {
      const normalized = sheetName.trim().toUpperCase();
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
      if (!rows.length) return;

      if (normalized === 'L' || normalized === 'R') {
        const headers = rows[0];
        const sampleRows = rows.slice(1, 6);
        const suggestedMapping = {};
        headers.forEach((header, i) => {
          const field = logic.guessFieldForHeader(header);
          if (field && !suggestedMapping[field]) {
            suggestedMapping[field] = logic.indexToColumnLetter(i);
          }
        });
        detectedTabs[normalized] = { headers, sampleRows, suggestedMapping, rowCount: rows.length - 1 };
      } else {
        otherSheetNames.push(sheetName);
      }
    });

    res.json({ detectedTabs, otherSheetNames, fileName: req.file.originalname });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not read that file. Make sure it is a valid .xlsx or .csv file.' });
  }
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
    const tabConfig = settings.sheetTabs[tab];
    if (!tabConfig) {
      return res.json({ status: 'ignored', message: `No settings configured for tab "${tab}"` });
    }

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

    if (store.wasAlreadySent(tab, row)) {
      return res.json({ status: 'sent', message: 'Already sent previously' });
    }

    const serialRaw = values[tabConfig.serialCol];
    const serial = logic.parseSerial(serialRaw, tab);
    if (!serial) {
      return res.json({ status: 'error', message: `Could not read serial from column ${tabConfig.serialCol}` });
    }

    const ushers = store.getUshers();
    const usher = logic.findUsherForSerial(serial, ushers);
    if (!usher) {
      return res.json({ status: 'no-usher', message: `No usher range covers ${tab}${serial.num}` });
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
      tab,
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
