/**
 * Normalizes a phone number that may have lost its leading zero
 * (a common Google Sheets behavior when a cell is formatted as a number).
 * If we see exactly 10 digits starting with "1" (e.g. "1012345678"),
 * we assume the leading 0 was stripped and restore it.
 */
function normalizePhone(raw) {
  let cleaned = String(raw == null ? '' : raw).replace(/[\s-]/g, '');
  if (/^1\d{9}$/.test(cleaned)) {
    cleaned = '0' + cleaned;
  }
  return cleaned;
}

/** Exactly 11 digits, starts with "01" (Egyptian mobile format). */
function isValidPhone(phone) {
  return /^01\d{9}$/.test(phone);
}

/** Converts "01012345678" into WhatsApp JID format "201012345678@s.whatsapp.net" */
function phoneToJid(phone) {
  return '20' + phone.substring(1) + '@s.whatsapp.net';
}

/**
 * Parses a serial value which may be a bare number ("108") or include a
 * side letter ("L108"). If it includes a letter, that takes precedence;
 * otherwise the sheet tab name ('L' or 'R') is used as the side.
 */
function parseSerial(serialRaw, tabName) {
  const str = String(serialRaw == null ? '' : serialRaw).trim();
  const withLetter = str.match(/^([LR])\s*(\d+)$/i);
  if (withLetter) {
    return { side: withLetter[1].toUpperCase(), num: parseInt(withLetter[2], 10) };
  }
  const bareNumber = str.match(/^(\d+)$/);
  if (bareNumber && (tabName === 'L' || tabName === 'R')) {
    return { side: tabName, num: parseInt(bareNumber[1], 10) };
  }
  return null;
}

/** Parses a range string like "L108-L112" or "108-112" into { side, start, end } */
function parseRange(rangeStr, side) {
  const str = String(rangeStr || '').trim();
  const withLetters = str.match(/^([LR])\s*(\d+)\s*-\s*[LR]?\s*(\d+)$/i);
  if (withLetters) {
    return {
      side: withLetters[1].toUpperCase(),
      start: parseInt(withLetters[2], 10),
      end: parseInt(withLetters[3], 10),
    };
  }
  const bareRange = str.match(/^(\d+)\s*-\s*(\d+)$/);
  if (bareRange && side) {
    return { side, start: parseInt(bareRange[1], 10), end: parseInt(bareRange[2], 10) };
  }
  return null;
}

/** Finds which usher (from the ushers list) covers a given serial. */
function findUsherForSerial(serial, ushers) {
  if (!serial) return null;
  return ushers.find(u => u.side === serial.side && serial.num >= u.start && serial.num <= u.end) || null;
}

/** Converts a 0-based column index into its spreadsheet letter (0 -> A, 26 -> AA). */
function indexToColumnLetter(index0based) {
  let col = index0based + 1;
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

/**
 * Guesses which field a column header refers to, based on keyword matching.
 * Returns one of 'serialCol' | 'idCol' | 'nameCol' | 'deptCol' | 'phoneCol' | null
 */
function guessFieldForHeader(header) {
  const h = String(header || '').toLowerCase().trim();
  if (!h) return null;
  if (/(serial|seat|^l\/r$|^side$)/.test(h)) return 'serialCol';
  if (/(phone|mobile|whatsapp|contact)/.test(h)) return 'phoneCol';
  if (/(department|dept|major|faculty|program)/.test(h)) return 'deptCol';
  if (/(^id$|graduate id|student id|^no$|number)/.test(h)) return 'idCol';
  if (/(name)/.test(h)) return 'nameCol';
  return null;
}

/** Pulls the spreadsheet ID out of any Google Sheets URL, or returns null. */
function extractSheetId(url) {
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

/**
 * Minimal CSV parser (handles quoted fields, escaped quotes, commas/newlines
 * inside quotes). Good enough for reading a sheet's gviz CSV export - we
 * don't want to pull in a whole dependency just for this.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore, \n handles the line break
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}

module.exports = {
  normalizePhone,
  isValidPhone,
  phoneToJid,
  parseSerial,
  parseRange,
  findUsherForSerial,
  indexToColumnLetter,
  guessFieldForHeader,
  extractSheetId,
  parseCsv,
};