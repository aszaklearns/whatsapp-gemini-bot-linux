# 📘 WhatsApp Gemini Bot — User Manual (Linux)

## What this bot does
A 24/7 WhatsApp AI assistant for a university class section. It:
- Answers questions using an **Official Class Database** (admin-only) + **Student Chatter** (rumor mill).
- Fetches live DIU notices via `!notice`.
- Remembers class/schedule inputs in a persistent **SQLite table** (`class_memory`).
- Rotates across **Gemini → OpenAI (ChatGPT) → Gemma** providers with per-provider key rotation.

## Files that matter
- `config.json` — `apiKeys` (Gemini), `openaiApiKeys` (ChatGPT), `openaiModel`, admin number, browser path.
- `class_data.db` — SQLite: `class_info` (official), `student_chatter` (24h rumors), `class_memory` (persistent class/schedule inputs).
- `.wwebjs_auth/` — WhatsApp session (don't delete unless re-pairing).

## Commands
Send these in WhatsApp (to the bot's number):

| Command | Who | What it does |
|---|---|---|
| `!notice` | Anyone | Scrapes latest notices from daffodilvarsity.edu.bd and replies with top 5. |
| `!save [CATEGORY] [info]` | Admin only | Saves verified info to Official DB + memory file. Example: `!save ROUTINE Monday 9AM CSE-201 Room 301` |
| `!memory` | Anyone | Prints the persistent class/schedule memory (SQLite). |
| `!memory clear` | Admin only | Clears the class_memory table. |
| `!chatter clear` | Admin only | Wipes the unverified student chatter. |
| (any text) | Anyone | Bot reads DB + chatter + memory and replies (concise, in your language). |

## How to save something to the bot's memory

### Option A — Admin official save (recommended for verified facts)
```
!save ROUTINE Monday 9AM-10AM CSE-201 Room 301 Sir. Rahim
!save EXAM Mid-term on 15 Nov, Room 205
!save LINK Drive: https://drive.google.com/...
!save SYLLABUS CSE-201: Ch 1-5, mid covers 1-3
```
- Only the admin number (set in config) or the bot's own account can use `!save`.
- Saved to SQLite (permanent) **and** appended to `class_memory` table.

### Option B — Automatic memory (anyone)
Any normal message containing class/schedule keywords (class, schedule, routine, exam, assignment, lab, semester, course, time, room, teacher, sir, madam, or Bangla equivalents) is **automatically appended** to the `class_memory` SQLite table with sender + timestamp.

Example: "Tomorrow's class is at 10 AM in room 302" → saved to memory.

### Option C — View / clear memory
- `!memory` → view the memory file.
- `!memory clear` → (admin only) wipe it.

## Dynamic personas
- Normal students → strict, concise Class Rep AI.
- The Co-CR number (set in code as `CO_CR_NUMBER`) → affectionate "girlfriend" persona (still answers accurately).

## Adding friends
Edit `FRIENDS_LIST` in `index.js` to map phone numbers → names so the bot cites them by name.

## Running on Linux
```bash
cd /home/fahim/whatsapp-gemini-bot-linux
node index.js
```
- First run: setup wizard asks for API keys, phone, browser path (use `/usr/bin/brave-browser` or `/usr/bin/chromium`).
- Session is saved in `.wwebjs_auth/` — no QR re-scan needed after first pairing.
- If "browser already running" error: `rm -f .wwebjs_auth/session/SingletonLock` then restart.
- Logs: redirect with `node index.js > bot.log 2>&1`.

## Troubleshooting
- **"cooling down" / error reply** → check `bot.log`. Usually a key rotation; bot auto-retries next key.
- **QR not showing** → delete `.wwebjs_auth/` and restart to re-pair.
- **403/404 on a key** → that key's project lacks access; bot skips it and uses working keys.
- **Scraper fails** → DIU site changed layout; notices command returns fallback message.

## Memory storage location
`class_data.db` → table `class_memory` (SQLite). View with `!memory` or query with any SQLite client. Last 5000 chars injected into AI context.
