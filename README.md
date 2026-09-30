# Life Maxxing Protocol

A self-contained personal tracking app for three domains — **Gym**, **Health**, and **Career** — wrapped in a Vite + React shell for dev/build convenience. The app itself is a single HTML file with vanilla JS, styled as a dark, mobile-first "tactical" dashboard.

## Features

### 🏋️ Gym (GRIND)
- Pre-built Push/Pull/Legs (PPL) weekly split with rest day
- Workout mode: per-set tracking, rest timer, cooldown checklist
- **Edit Plan**: edit day titles, exercises, sets/reps, add/delete exercises, and change each day's emoji via a picker
- History with session details, progress stats, and streak tracking

### 🫀 Health
- **Diet**: meal plan with ingredients, variant switching (e.g. Paneer/Soya), supplement checklist
- **Wellness**: daily habits, sleep and water tracking

### 🧠 Career
- Daily task list with statuses (pending / done / partial / skipped)
- **YAML import**: bulk-import tasks for multiple dates from a pasted YAML config
- History, progress, and a reference guide tab

All three domains share the same pattern: Home / History / Progress tabs, top-level domain switcher, and a bottom nav.

## Tech Stack

- [Vite](https://vitejs.dev/) + React — serves/iframes the legacy HTML app (`src/App.jsx` wraps `lifemaxxing-v1.html`)
- Vanilla JS, single-file app (`lifemaxxing-v1.html`) — no framework, no build step for the app logic itself
- **Persistence**: browser `localStorage` only (keys: `lm_gym_plan`, `lm_gym_history`, `lm_health_diet_log`, `lm_health_wellness_log`, `lm_career_history`, `lm_career_history_by_date`)

> ⚠️ Your data lives in the browser's localStorage — it does **not** sync between devices or browsers, and clearing site data erases it.

## Getting Started

```bash
git clone https://github.com/Soham-2/Life-Maxxing-Protocol.git
cd Life-Maxxing-Protocol
npm install
npm run dev
```

Open **http://localhost:5174** (port is fixed in `vite.config.js`).

### Production build

```bash
npm run build     # outputs to dist/
npm run preview   # serve the built app locally
```

## Project Structure

```
├── index.html              # Vite entry
├── lifemaxxing-v1.html     # The entire app (HTML + CSS + JS, single file)
├── src/
│   ├── App.jsx             # React shell that iframes the legacy app
│   ├── main.jsx
│   └── lib/ , styles/      # Small helpers / token styles
├── update_text.py          # One-off text/format tweak script for the legacy file
├── vite.config.js
└── package.json
```

## Notes

- The canonical app file is `lifemaxxing-v1.html`; editing it is enough — no framework recompile needed, Vite hot-reloads the iframe.
- `update_text.py` is a standalone utility that rewrites certain strings (greeting casing, date format, font weights) in the legacy file. Run it only if you want those transformations applied.
