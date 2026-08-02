# ⛰️ 14ers Tracker

A lightweight, free web app that reads a shared **Google Sheet** live and shows:

- **🏆 Leaderboard** — hikers ranked by **unique 14ers** summited and **total summits** (including repeats), with a CMC-official-only toggle.
- **🗺️ Planning Map** — pick one or more hikers and see every peak colored by progress:
  - 🟢 **green** — all selected hikers have summited it
  - 🟡 **yellow** — some but not all have
  - 🔴 **red** — none of them have
  - ⚪ **gray** — no one selected

No build step, no API key, no server — just static files on GitHub Pages.

## How it works

The page fetches each sheet tab as CSV directly from the public Google Sheet using
Google's `gviz` endpoint (which returns permissive CORS headers), then computes
everything in the browser:

- **`14ers` tab** → the peak universe: name, state, range, elevation, CMC-list flag,
  and `Coordinates` (e.g. `39.1503°N 107.0829°W`). This is the source of truth for
  what appears on the map.
- **`Hike Register` tab** → the log of `Person, Peak, Date, Summited?, Notes`. All
  leaderboard and map progress is derived from here (rows where `Summited? = Yes`).

Peak names are normalized when joining the two tabs, so `Mt. Whitney` in the register
still matches `Mount Whitney` in the peak list.

Data is **live**: edit the sheet and reload the page. (Google caches the `gviz`
response for a few minutes.)

## Editing the data

Everything is driven by the sheet — you never touch code to update summits or hikers.

- **Log a summit:** add a row to `Hike Register` (`Person`, `Peak`, `Date`, `Summited? = Yes`).
- **Add a hiker:** they appear automatically the first time they show up in the register.
- **Add / fix a peak:** edit the `14ers` tab. Give every peak a `Coordinates` value in
  the `DD°N DD°W` format so it can be mapped.

Tips for clean data:

- Keep peak names identical between the `Hike Register` and `14ers` tabs (a dropdown /
  data-validation column in the register that references the `14ers` peak list prevents
  typos and broken joins).
- `Summited? = No` rows are treated as attempts and don't count toward totals.

## Configuration

Both settings live at the top of [`app.js`](app.js):

```js
const SHEET_ID = '…';        // the Google Sheet id
const DEFAULT_HIKER = 'Ben'; // whose progress the map shows on first load
```

The sheet must be shared as **"Anyone with the link – Viewer"** for the app to read it.

## Local development

```bash
python3 -m http.server 8731
# then open http://localhost:8731
```

## Deploying

Pushed to `main`, GitHub Pages serves the site automatically via the workflow in
[`.github/workflows/pages.yml`](.github/workflows/pages.yml).

## Built with

[Leaflet](https://leafletjs.com/) + [OpenStreetMap](https://www.openstreetmap.org/)
tiles, [Bootstrap](https://getbootstrap.com/), and
[PapaParse](https://www.papaparse.com/) — all free and loaded from a CDN.
