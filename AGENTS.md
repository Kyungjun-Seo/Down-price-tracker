# Down Price Tracker operations

`CLAUDE.md` describes the original page and data model. Follow it together with these automation rules.

## Source files

- `DOWN 가격동향 계속~ - 복사본.xlsx` is the authoritative K2 price source. The user edits it periodically.
- `https://en.cfd.com.cn/` is the only China price source. Never use `cn-down.com`.
- `down-sise.html` is the canonical page fragment.
- `index.html` and `data/cn-down-prices.json` are generated mirrors.

## Standard update

Run `node scripts/update-site.mjs` from the repository root. It must:

1. Replace `K2_SEED` with the paired GOOSE/DUCK series extracted from sheet 1 of the workbook.
2. Fetch GGD/GDD 90% and 80% prices under GB/T 14272-2021 from en.cfd.com.cn.
3. Refresh CNY to USD from the Frankfurter ECB-backed API.
4. Keep at most 52 China rows.
5. Regenerate `index.html` and the JSON mirror.
6. Fail before writing if parsing or validation is unsafe.

After any manual change, run `node scripts/update-site.mjs --dry-run --skip-network`. A clean generated state reports `"changed": false`.

The local scheduled task runs at 09:00 on Monday, Tuesday, Wednesday, and Friday. `scripts/run-weekly-update.ps1` records a successful week in `logs/last-success.json`; later triggers in the same week must skip. A failure does not write the marker, so the next trigger retries. The following Monday starts a new weekly cycle.

Do not edit `index.html` or `data/cn-down-prices.json` directly.
