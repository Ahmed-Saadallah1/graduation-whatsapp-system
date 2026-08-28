/**
 * GRADUATION SEATING -> WHATSAPP NOTIFIER
 * Apps Script (v2 - thin forwarder)
 * ------------------------------------------------------------
 * This script holds NO configuration and adds NOTHING visible to your
 * Sheet - no extra tabs, no formatting rules. It only:
 *   1. Watches for edits on tabs named exactly "L" or "R"
 *   2. Forwards the edited row's data to your backend dashboard
 *   3. Colors the edited cell based on the backend's response
 *
 * All real configuration (column mapping, usher list) lives in your
 * backend's dashboard (open http://localhost:3000 or your tunnel URL
 * in a browser).
 *
 * SETUP (do this once):
 *   1. Open the Sheet -> Extensions -> Apps Script
 *   2. Paste this whole file in, replacing any starter code
 *   3. Run `setupTrigger` once from the toolbar (it will ask for
 *      authorization, and then ask you to paste in your backend's URL)
 */

const BACKEND_URL_PROPERTY = 'BACKEND_URL';

/**
 * One-time setup: installs the onEdit trigger and asks for your backend URL.
 * Simple onEdit triggers can't call external URLs, so we need this
 * installable trigger instead.
 */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'handleEdit') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('handleEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  getBackendUrl_(true); // prompt for URL if not already set
  SpreadsheetApp.getUi().alert('Setup complete. Nothing was added to this Sheet - all configuration lives in your dashboard.');
}

/** Lets you change the backend URL later (e.g. after restarting the tunnel). */
function setBackendUrl() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Backend URL', 'Enter your backend/tunnel URL (no trailing slash), e.g.\nhttps://your-tunnel.trycloudflare.com', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() === ui.Button.OK) {
    const url = resp.getResponseText().trim().replace(/\/$/, '');
    PropertiesService.getScriptProperties().setProperty(BACKEND_URL_PROPERTY, url);
    ui.alert('Backend URL updated to:\n' + url);
  }
}

function getBackendUrl_(promptIfMissing) {
  const props = PropertiesService.getScriptProperties();
  let url = props.getProperty(BACKEND_URL_PROPERTY);
  if (!url && promptIfMissing) {
    const ui = SpreadsheetApp.getUi();
    const resp = ui.prompt('Backend URL', 'Enter your backend/tunnel URL (no trailing slash), e.g.\nhttps://your-tunnel.trycloudflare.com', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() === ui.Button.OK) {
      url = resp.getResponseText().trim().replace(/\/$/, '');
      props.setProperty(BACKEND_URL_PROPERTY, url);
    }
  }
  return url;
}

/** Converts a 1-based column index into its letter (1 -> A, 27 -> AA, etc). */
function columnToLetter_(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

/**
 * Main entry point - fires on every edit to the spreadsheet.
 * Only acts on single-cell edits within tabs literally named "L" or "R".
 */
function handleEdit(e) {
  try {
    const sheet = e.range.getSheet();
    const tabName = sheet.getName();
    // No hardcoded tab names here - the backend dashboard's "Sheet" tab holds
    // the real tab names you type in, and matches this edit against them.
    // Any tab that doesn't match either configured name is simply ignored.
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

    const row = e.range.getRow();
    if (row === 1) return; // ignore header row edits

    const editedColumn = columnToLetter_(e.range.getColumn());

    // Grab the whole row (up to column J, generous headroom) so the backend
    // has whatever it needs regardless of which columns are configured.
    const lastCol = Math.max(sheet.getLastColumn(), 10);
    const rowValues = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
    const values = {};
    rowValues.forEach((v, i) => { values[columnToLetter_(i + 1)] = v; });

    const backendUrl = getBackendUrl_(false);
    if (!backendUrl) {
      flagCell_(e.range, 'Backend URL not set - run "Update Backend URL" from the menu');
      return;
    }

    const response = UrlFetchApp.fetch(backendUrl + '/api/sheet-edit', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ tab: tabName, row: row, editedColumn: editedColumn, values: values }),
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() >= 500 || response.getResponseCode() === 0) {
      flagCell_(e.range, 'Backend unreachable (HTTP ' + response.getResponseCode() + ')');
      return;
    }

    const result = JSON.parse(response.getContentText());

    if (result.status === 'sent') {
      clearFlag_(e.range);
      e.range.setBackground('#d9ead3'); // light green
    } else if (result.status === 'ignored') {
      // Edited a column the backend doesn't care about - leave it alone
      clearFlag_(e.range);
    } else {
      // invalid, no-usher, error
      flagCell_(e.range, result.message || result.status);
    }
  } catch (err) {
    if (e && e.range) flagCell_(e.range, 'Error: ' + err.message);
  }
}

function flagCell_(range, note) {
  range.setBackground('#f4cccc'); // light red
  range.setNote(note);
}

function clearFlag_(range) {
  range.setNote('');
}

/** Adds a menu so setup/URL changes don't require opening the script editor. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Graduation Notifier')
    .addItem('Run Setup', 'setupTrigger')
    .addItem('Update Backend URL', 'setBackendUrl')
    .addToUi();
}