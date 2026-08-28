# Apps Script Setup (Google Sheet side) — v2

Your Sheet stays completely untouched by this system. No extra tabs, no
formatting, no restrictions. This script only watches for edits and forwards
them to your backend dashboard, which holds all the real configuration.

**Requirement:** your two data tabs must be named exactly **`L`** and **`R`**
(the tab names at the bottom of the sheet). The script only watches those two.

## 1. Install the script
1. Open your Google Sheet.
2. Go to **Extensions -> Apps Script**.
3. Delete any starter code in `Code.gs` and paste in the full contents of `Code.gs` from this folder.
4. Click **Save**.

## 2. Run setup once
1. In the Apps Script toolbar, select `setupTrigger` from the function dropdown.
2. Click **Run**.
3. Authorize it the first time: **Review permissions -> (your account) -> Advanced -> Go to project (unsafe) -> Allow**. This is expected for your own scripts.
4. It will then ask you to paste in your **backend URL** (e.g. `https://your-tunnel.trycloudflare.com`) — this is the same tunnel URL from the backend setup.
5. You'll see: **"Setup complete. Nothing was added to this Sheet."**

## 3. Do all real configuration in the dashboard
Open your backend URL in a browser (e.g. `https://your-tunnel.trycloudflare.com` or `http://localhost:3000` if you're on the same machine). There you'll manage:
- **Settings tab** — which column holds Serial / ID / Name / Department / Phone, separately for the `L` tab and the `R` tab (they can differ).
- **Ushers tab** — name, phone, and range (e.g. `L108-L112`) for each usher. Add, edit, or remove any time.
- **Activity tab** — a live feed of every message sent, for monitoring during the event.

Nothing here needs to touch the Sheet again once it's set up.

## 4. Test it
1. Make sure the backend and tunnel are running (see `/backend/README.md`).
2. In the Sheet, on tab `L` or `R`, type a phone number into the row's configured phone column.
3. The cell should turn **light green** within a couple seconds once the message is confirmed sent.
4. If something's wrong, the cell turns **light red** with a note explaining why — hover over it to read the note.

## If the tunnel URL changes
Free Cloudflare tunnels get a new URL every time they restart. If that happens:
1. Open the **Graduation Notifier** menu in your Sheet (auto-added to the menu bar).
2. Click **Update Backend URL**.
3. Paste in the new URL.

No need to re-run full setup for this.
