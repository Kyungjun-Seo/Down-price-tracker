# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page Korean down-feather (구스/덕다운) raw material price tracker. There is no build system, package manager, or test suite — this is hand-written static HTML/CSS/JS with two duplicate-content deployment targets and a JSON data mirror.

## Repository layout

- `down-sise.html` — the canonical page content, as a **body fragment**: it starts directly with `<title>...</title>`, followed by one `<style>` block, the page markup, and one `<script>` block at the end. It has **no** `<!doctype>`/`<html>`/`<head>`/`<body>` wrapper. This file is published as a Claude Artifact, whose viewer supplies the wrapper (and the `window.claude.*` runtime, e.g. `window.claude.downloads` for CSV export) at render time.
- `index.html` — the standalone version of the same page for GitHub Pages (served from the repo root on `main`). It is generated from `down-sise.html` by prepending a doctype/`<html lang="ko"><head>` block (with `<meta charset>` and a viewport tag) before the `<title>` tag, inserting `</head>\n<body>` right after the first `</style>`, and appending `</body></html>` at the end. **Its body and script content must stay byte-for-byte identical to `down-sise.html`** — never hand-edit `index.html` directly; regenerate it from `down-sise.html` instead. Because `saveCsv()` falls back to a Blob/anchor download when `window.claude.downloads` isn't present, the page also works standalone on GitHub Pages without the Artifact runtime.
- `data/cn-down-prices.json` — a plain-JSON mirror of the `CN_HISTORY` array embedded in `down-sise.html`/`index.html` (see below), with `_cny`-suffixed keys (`ggd9010_cny`, `gdd9010_cny`, `ggd8020_cny`, `gdd8020_cny`) instead of the bare keys used in the JS array. Same dates, same values, kept in lockstep with the HTML files' `CN_HISTORY`.

## Regenerating index.html from down-sise.html

Whenever `down-sise.html` changes, rebuild `index.html` to match:

```python
with open("down-sise.html", "r", encoding="utf-8") as f:
    content = f.read()

style_close_idx = content.find("</style>") + len("</style>")
prefix = '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
new_content = prefix + content[:style_close_idx] + "\n</head>\n<body>\n" + content[style_close_idx:] + "\n</body>\n</html>\n"

with open("index.html", "w", encoding="utf-8") as f:
    f.write(new_content)
```

The Claude Artifact copy is the source of truth for page structure/schema (it has changed shape multiple times), so when reconciling drift, prefer resyncing `down-sise.html` from the live artifact over trusting an older committed copy — then rebuild `index.html` from the freshly synced file.

## Data model (inside `down-sise.html`'s `<script>`)

Two independent price series, both hand-maintained as inline JS array literals — there is no backend or API:

- **`K2_SEED`** (표 1 — "K2 시세"): `{ date, goose, duck }` rows, USD/kg. This is the primary/proprietary series (RDS China Goose Down 80/20 Grey 650FP+, Duck Down 80/20 Grey 600FP+). Seeded from an Excel export; extendable at runtime two ways, both admin-gated (password `"0129"`, checked client-side in `tryPwConfirm` — this is a UI gate only, not real access control) and persisted only to `localStorage` (`downsise_k2_custom_v1`):
  - the `#k2-add-form` manual entry form, or
  - the "엑셀 업로드" button, which parses an uploaded `.xlsx` with a **hand-rolled ZIP/XML reader** (`readZipEntry`, `parseSharedStrings`, `parseSheetGrid`, `extractSpeciesSeries` — no library), locating rows by a `GOOSE`/`DUCK` keyword and matching them against the nearest date-serial header row above.
- **`CN_HISTORY`** (표 2 — "참고용 중국 시세"): `{ date, ggd9010, gdd9010, ggd8020, gdd8020 }` rows, **CNY/kg** (converted to USD for display via `FX.usdPerCny`). Reference-only Chinese market prices per GB/T 14272-2021, sourced from `en.cfd.com.cn` (China Feather & Down Industrial Association) — `cn-down.com` was deliberately dropped as a source and must not be reintroduced. Naming: `ggd`/`gdd` = grey goose/duck down; `9010`/`8020` = the 90/10 and 80/20 grades. This array is capped at 52 rows (`cnMergedRows`) and must be kept in sync with `data/cn-down-prices.json`.
- **`FX`**: `{ date, usdPerCny }`, the single exchange rate applied to every `CN_HISTORY` row for USD conversion.

Both series are rendered as hand-rolled inline SVG line/area charts (`renderK2Chart`, `renderCnChart` — no charting library), with crosshair hover tooltips, legend series toggles, mouse-wheel zoom, and preset/custom date-range filters. CSV export (`#k2-download-btn`, `#cn-download-btn`) goes through `saveCsv()`.

## Automated operation

- `DOWN 가격동향 계속~ - 복사본.xlsx` is tracked as the authoritative K2 source.
- Run `node scripts/update-site.mjs` for the complete update. It extracts K2 data, crawls the four GB/T 14272-2021 China series from `en.cfd.com.cn`, refreshes CNY-to-USD, rebuilds both mirrors, and validates the result before writing.
- Run `node scripts/update-site.mjs --dry-run --skip-network` to verify local consistency without network writes.
- Windows Task Scheduler runs `scripts/run-weekly-update.ps1` at 09:00 Asia/Seoul on Monday, Tuesday, Wednesday, and Friday. It retries until one run succeeds, skips later runs in that week, and starts a new cycle the following Monday.
- `.github/workflows/weekly-update.yml` runs at 09:30 Asia/Seoul as a fallback using the latest workbook committed to the repository.

## Update workflow

The commit history (`chore: weekly down price update <date>`) reflects a recurring process, run outside this repo, that: resyncs `down-sise.html` from the live Claude Artifact, crawls `en.cfd.com.cn` for a new as-of-dated row, appends it to both `CN_HISTORY` and `data/cn-down-prices.json` when present, refreshes `FX` to the current rate, trims history to 52 rows, rebuilds `index.html`, commits both files plus the JSON mirror together, and republishes the Artifact. When making manual data edits, follow the same invariants: keep `CN_HISTORY` and `data/cn-down-prices.json` identical in content, keep `index.html`'s body/script byte-for-byte identical to `down-sise.html`'s, and never touch `cn-down.com`.
