# Backend Setup — v2 (with Dashboard)

This is the piece that sends WhatsApp messages and now also hosts your
configuration dashboard. It needs to run on a computer with a stable
internet connection during the event.

## 1. Install
Requires [Node.js](https://nodejs.org) (v18+).

```bash
cd backend
npm install
```

## 2. First run — link your WhatsApp
```bash
npm start
```
A QR code prints in the terminal. On your phone:
**WhatsApp -> Settings -> Linked Devices -> Link a Device**, then scan it.

Once linked, you'll see `✅ WhatsApp connected and ready.`. The session is
saved in `auth/` so you won't need to scan again on future runs, as long as
you don't log the linked device out from your phone.

**Do this a few days before the event, not for the first time on the day.**

## 3. Open the dashboard
With the backend running, open in a browser:
```
http://localhost:3000
```
You'll see five tabs:
- **Sheet** — paste the live Google Sheet link and the exact names of its two tabs (you can type these in once you know them, shortly before the event). "Test connection" confirms the sheet is reachable and previews a suggested column mapping.
- **Settings** — column mapping (Serial, ID, Name, Department, Phone) for each side. Fill these in to match your real sheet, or apply the suggestion from the Sheet tab's test.
- **Ushers** — add each usher's name, phone number, and range (e.g. `L108-L112`). Editable any time.
- **WhatsApp** — shows the number currently linked (this is your default — it stays linked between runs). Use "Relink a different number" here as Plan B if you need to switch numbers or recover from a disconnect during the event, without touching the terminal.
- **Activity** — a live feed of every message sent, refreshing automatically. This is what you'll watch during the event.

The status dot in the top-right shows whether WhatsApp is currently connected.

## 4. Expose it to your Google Sheet (Cloudflare Tunnel — free, no credit card)
The Sheet needs a public URL to reach this backend. In a second terminal:

```bash
# One-time install
npm install -g cloudflared
# or download from https://github.com/cloudflare/cloudflared/releases

# Run this alongside the backend:
cloudflared tunnel --url http://localhost:3000
```

It prints a URL like `https://random-words-here.trycloudflare.com`. That's
both:
- Your **dashboard address** (open it in a browser from any device)
- The URL you paste into Apps Script when it asks for your backend URL

⚠️ This free tunnel URL changes every time `cloudflared` restarts. If that
happens, update it via the Sheet's **Graduation Notifier -> Update Backend URL** menu.

## 5. On event day
- Start the backend (`npm start`) and the tunnel well before graduates arrive.
- Keep the dashboard's **Activity** tab open on a screen to monitor sends live.
- Keep WhatsApp Web open on a browser tab as a manual backup in case the automation drops.
- Don't log the linked device out of WhatsApp on your phone.

## How phone number formatting is handled
Since the Sheet can't have formatting restrictions applied, numbers that lose
their leading zero (a common Google Sheets quirk when a cell is treated as a
number) are automatically detected and fixed: any 10-digit number starting
with `1` is assumed to be missing its `0` and gets it restored before
validation. No manual formatting needed on the Sheet.

## How sending works
- Each request from the Sheet is processed immediately and queued for sending,
  with a short (0.7 second) gap between messages if several land close
  together — keeps things fast while avoiding a burst pattern that could look
  like spam.
- Duplicate sends are prevented automatically — the backend keeps track of
  which row/tab combinations have already been sent.