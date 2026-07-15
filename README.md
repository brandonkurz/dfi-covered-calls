# DFi Covered Call Analyzer

Self-updating version of the covered call analysis sheet, with DiversiFi Capital branding.
Replaces the manual Barchart workflow: type a ticker, and the app pulls live data and
rebuilds the Aggressive / Moderate / Conservative tables automatically.

## Run it

- Double-click `start.command` (starts the local server and opens the browser), or
- `node server.js` then open http://127.0.0.1:8771

## What it does

- Live quote, next earnings date, and full option chain via a local Yahoo Finance proxy
  (`server.js`, no dependencies; Yahoo requires a cookie + crumb handshake that browsers
  can't do cross-origin).
- Computes Black-Scholes delta using implied volatility derived from each contract's
  bid/ask midpoint (the same methodology Barchart uses for its delta column; verified to
  match Barchart's published deltas within ~0.2 points) and auto-matches strikes to the
  target call probabilities (40 / 30 / 20 / 15 / 10 percent). Premium = live bid.
- "Verify on Barchart" link next to the strike ladder deep-links to the same ticker and
  expiration on barchart.com for a side-by-side check.
- Expiration auto-selects the closest date prior to next earnings (minimum 21 days out).
  If earnings are too close it falls back to ~45 days and shows a red
  "writes thru earnings" badge. Override via the Expiration dropdown.
- Three strategies with the standard tranche splits (Aggressive 25/30/45 at 40/30/20 delta,
  Moderate 30/35/35 at 30/20/10, Conservative 15/30/55 at 20/15/10). Share counts and
  call probabilities are editable per batch; "Reset splits" restores defaults.
- Net premiums assume $0.65 per contract (editable). ROI, annualized return, monthly cash
  flow, and weighted call probability follow the original sheet's formulas.
- Auto-refreshes every 60 seconds (toggle in the top bar). Save/load clients (localStorage).
  Print / PDF gives a branded one-pager for the file.

## Disclosures

For informational and illustrative purposes only. Not investment, tax, or legal advice,
and not an offer or solicitation. Options involve substantial risk and are not suitable
for all investors. All figures are hypothetical calculations from delayed data. Read
[DISCLOSURES.md](DISCLOSURES.md) in full before using or sharing output from this tool.

## Notes

- Data is delayed (Yahoo). Always verify against the broker platform before execution.
- Yahoo rate-limits some browser User-Agent strings; the proxy sends a minimal UA and
  retries on 429 with a query2 host fallback.
