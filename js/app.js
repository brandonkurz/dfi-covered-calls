/* DiversiFi Capital - Covered Call Analyzer
   Live quote + option chain via local Yahoo proxy (server.js).
   Strikes auto-selected by Black-Scholes delta (call probability). */
'use strict';

/* ================= config ================= */
const TARGETS = [40, 30, 20, 15, 10]; // call probability targets, %
const STRATS = [
  { key: 'aggressive',   label: 'Aggressive',   batches: [{ pct: 25, prob: 40 }, { pct: 30, prob: 30 }, { pct: 45, prob: 20 }] },
  { key: 'moderate',     label: 'Moderate',     batches: [{ pct: 30, prob: 30 }, { pct: 35, prob: 20 }, { pct: 35, prob: 10 }] },
  { key: 'conservative', label: 'Conservative', batches: [{ pct: 15, prob: 20 }, { pct: 30, prob: 15 }, { pct: 55, prob: 10 }] },
];
const LS_KEY = 'dfi-cc-clients';

const state = {
  quote: null,            // { price, prevClose, name, time }
  earningsTs: null,       // unix seconds
  divYield: 0,            // continuous dividend yield for greeks
  expirations: [],        // unix seconds list
  selectedExp: null,
  calls: [],              // raw calls for selected expiration
  ladder: {},             // targetProb -> {strike,bid,delta,iv,oi}
  quoteAtLoad: null,      // "stock price at quote" snapshot
  strat: {},              // key -> [{prob, sharesOverride|null}]
  timer: null,
  loading: false,
};
STRATS.forEach(s => { state.strat[s.key] = s.batches.map(b => ({ prob: b.prob, shares: null })); });

/* ================= helpers ================= */
const $ = id => document.getElementById(id);
const fmt$ = (x, d = 2) => (x == null || !isFinite(x)) ? '-' : x.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (x, d = 2) => (x == null || !isFinite(x)) ? '-' : (x * 100).toFixed(d) + '%';
const fmtN = x => (x == null || !isFinite(x)) ? '-' : x.toLocaleString('en-US');
const dstr = ts => new Date(ts * 1000).toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' });

function daysTo(expTs) {
  const t = new Date(); const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.max(1, Math.round((expTs * 1000 - today) / 86400000));
}
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return s * y;
}
const normCdf = x => 0.5 * (1 + erf(x / Math.SQRT2));
function bsCall(S, K, T, sigma, r, q) {
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return { price: S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2),
           delta: Math.exp(-q * T) * normCdf(d1) };
}
/* Back out IV from the bid/ask midpoint (Barchart derives its greeks the same
   way), then take delta from that IV. Returns null if the price is unattainable. */
function midImpliedVol(S, K, T, price, r, q) {
  if (T <= 0 || price <= 0 || price <= Math.max(0, S * Math.exp(-q * T) - K * Math.exp(-r * T))) return null;
  let lo = 0.01, hi = 3;
  if (bsCall(S, K, T, hi, r, q).price < price) return null;
  for (let i = 0; i < 80; i++) {
    const m = (lo + hi) / 2;
    if (bsCall(S, K, T, m, r, q).price < price) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}
async function api(path) {
  const r = await fetch(path);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function showErr(msg) { const e = $('err'); if (!msg) { e.classList.add('hidden'); return; } e.textContent = msg; e.classList.remove('hidden'); }

/* ================= data loading ================= */
async function fetchQuote(sym) {
  const j = await api('/api/quote?symbol=' + encodeURIComponent(sym));
  const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || m.regularMarketPrice == null) throw new Error('No quote for ' + sym);
  return { price: m.regularMarketPrice, prevClose: m.chartPreviousClose, name: m.longName || m.shortName || sym, time: m.regularMarketTime };
}
async function fetchEarnings(sym) {
  try {
    const j = await api('/api/earnings?symbol=' + encodeURIComponent(sym));
    const r = j.quoteSummary.result[0];
    const e = r.calendarEvents && r.calendarEvents.earnings && r.calendarEvents.earnings.earningsDate;
    const dy = r.summaryDetail && r.summaryDetail.dividendYield && r.summaryDetail.dividendYield.raw;
    return { earnTs: (e && e.length) ? e[0].raw : null, divYield: dy || 0 };
  } catch (_) { return { earnTs: null, divYield: 0 }; }
}
async function fetchChain(sym, date) {
  const j = await api('/api/options?symbol=' + encodeURIComponent(sym) + (date ? '&date=' + date : ''));
  const r = j.optionChain && j.optionChain.result && j.optionChain.result[0];
  if (!r) throw new Error('No option chain for ' + sym);
  return { expirations: r.expirationDates || [], calls: (r.options[0] && r.options[0].calls) || [] };
}
function pickExpiration(exps, earnTs) {
  // Closest expiration strictly before next earnings, at least 21 days out
  // (per desk policy: 1-2 months, prior to earnings). If earnings are too
  // close, fall back to ~45 days and let the thru-earnings badge warn.
  const beforeEarn = exps.filter(e => earnTs && e <= earnTs - 86400 && daysTo(e) >= 21);
  if (beforeEarn.length) return beforeEarn[beforeEarn.length - 1];
  let best = null;
  for (const e of exps) if (best == null || Math.abs(daysTo(e) - 45) < Math.abs(daysTo(best) - 45)) best = e;
  return best;
}

async function loadAll() {
  const sym = $('symbol').value.trim().toUpperCase();
  if (!sym) return;
  $('symbol').value = sym;
  state.loading = true; $('loadBtn').disabled = true; showErr(null);
  try {
    const [quote, meta, chain0] = await Promise.all([fetchQuote(sym), fetchEarnings(sym), fetchChain(sym)]);
    const earnTs = meta.earnTs;
    state.quote = quote; state.earningsTs = earnTs; state.divYield = meta.divYield;
    state.expirations = chain0.expirations;
    if (!state.expirations.length) throw new Error(sym + ' has no listed options.');
    if (!state.selectedExp || !state.expirations.includes(state.selectedExp)) {
      state.selectedExp = pickExpiration(state.expirations, earnTs);
    }
    const chain = state.selectedExp === chain0.expirations[0] && chain0.calls.length
      ? chain0 : await fetchChain(sym, state.selectedExp);
    state.calls = chain.calls;
    state.quoteAtLoad = quote.price;
    buildLadder(); renderAll();
    $('stamp').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    showErr('Could not load live data: ' + e.message);
  } finally {
    state.loading = false; $('loadBtn').disabled = false;
  }
}

async function refresh() {
  if (state.loading || !state.quote) return;
  // Don't clobber an in-progress advisor edit with a re-render
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT') && $('strategies').contains(ae)) return;
  const sym = $('symbol').value.trim().toUpperCase();
  try {
    const [quote, chain] = await Promise.all([fetchQuote(sym), fetchChain(sym, state.selectedExp)]);
    state.quote = quote; state.calls = chain.calls; state.quoteAtLoad = quote.price;
    buildLadder(); renderAll();
    $('stamp').textContent = 'Updated ' + new Date().toLocaleTimeString();
    showErr(null);
  } catch (e) { showErr('Refresh failed: ' + e.message); }
}

/* ================= ladder ================= */
function buildLadder() {
  const S = state.quote.price;
  const T = daysTo(state.selectedExp) / 365;
  const r = (parseFloat($('rf').value) || 0) / 100;
  const q = state.divYield || 0;
  const cands = state.calls
    .filter(c => c.strike > S && c.bid > 0)
    .map(c => {
      const mid = (c.ask > c.bid) ? (c.bid + c.ask) / 2 : c.bid;
      // IV from the midpoint (Barchart's greeks methodology); fall back to Yahoo's IV
      const iv = midImpliedVol(S, c.strike, T, mid, r, q) || c.impliedVolatility || 0;
      if (iv <= 0.01) return null;
      return { strike: c.strike, bid: c.bid, iv, oi: c.openInterest || 0,
               delta: bsCall(S, c.strike, T, iv, r, q).delta };
    })
    .filter(Boolean);
  state.ladder = {};
  for (const t of TARGETS) {
    let best = null;
    for (const c of cands) if (!best || Math.abs(c.delta - t / 100) < Math.abs(best.delta - t / 100)) best = c;
    state.ladder[t] = best;
  }
}

/* ================= math per strategy ================= */
function defaultSplit(total, pcts) {
  const out = pcts.map(p => Math.round(total * p / 100 / 100) * 100);
  out[out.length - 1] = total - out.slice(0, -1).reduce((a, b) => a + b, 0);
  return out.map(x => Math.max(0, x));
}
function computeStrategy(def) {
  const total = Math.max(0, parseInt($('shares').value, 10) || 0);
  const fee = parseFloat($('fee').value) || 0;
  const spot = state.quoteAtLoad;
  const days = daysTo(state.selectedExp);
  const defaults = defaultSplit(total, def.batches.map(b => b.pct));
  const rows = state.strat[def.key].map((b, i) => {
    const shares = b.shares != null ? b.shares : defaults[i];
    const pick = state.ladder[b.prob];
    const contracts = Math.floor(shares / 100);
    const gross = pick ? contracts * 100 * pick.bid : null;
    const net = pick ? gross - contracts * fee : null;
    const roi = (pick && shares > 0 && spot) ? net / (shares * spot) : null;
    const ann = roi != null ? roi * 365 / days : null;
    return { i, shares, prob: b.prob, pick, contracts, gross, net, roi, ann,
             valueIfSold: pick ? shares * pick.strike : null };
  });
  const sumShares = rows.reduce((a, r) => a + r.shares, 0);
  const totalNet = rows.reduce((a, r) => a + (r.net || 0), 0);
  const overallAnn = sumShares > 0 ? rows.reduce((a, r) => a + (r.ann || 0) * r.shares, 0) / sumShares : null;
  const monthly = totalNet * (365 / 12) / days;
  const wProb = sumShares > 0 ? rows.reduce((a, r) => a + r.prob * r.shares, 0) / sumShares : null;
  return { rows, sumShares, total, totalNet, overallAnn, monthly, wProb, days };
}

/* ================= rendering ================= */
function renderKpis() {
  const q = state.quote;
  $('kPrice').textContent = fmt$(q.price);
  const chg = q.price - q.prevClose, chgP = chg / q.prevClose;
  const kc = $('kChange');
  kc.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + ' (' + (chg >= 0 ? '+' : '') + (chgP * 100).toFixed(2) + '%) vs prior close';
  kc.className = 'k-sub ' + (chg >= 0 ? 'pos' : 'neg');
  const shares = parseInt($('shares').value, 10) || 0;
  $('kPos').textContent = fmt$(shares * q.price, 0);
  $('kShares').textContent = fmtN(shares) + ' shares of ' + $('symbol').value.trim().toUpperCase();
  $('kEarn').textContent = state.earningsTs ? dstr(state.earningsTs) : 'n/a';
  $('kEarnSub').innerHTML = state.earningsTs ? Math.round((state.earningsTs - Date.now() / 1000) / 86400) + ' days away' : '&nbsp;';

  const sel = $('expSelect');
  sel.innerHTML = state.expirations.map(e =>
    `<option value="${e}" ${e === state.selectedExp ? 'selected' : ''}>${dstr(e)}</option>`).join('');
  $('kExpSub').textContent = daysTo(state.selectedExp) + ' days to expiration';
  const thru = state.earningsTs && state.selectedExp > state.earningsTs;
  $('thruEarn').classList.toggle('hidden', !thru);

  const link = $('bcLink');
  link.href = barchartUrl($('symbol').value.trim().toUpperCase(), state.selectedExp);
  link.classList.remove('hidden');
}

/* Barchart deep link for the selected expiration. Monthlies (3rd Friday)
   use the -m suffix, everything else -w. */
function barchartUrl(sym, expTs) {
  const d = new Date(expTs * 1000);
  const iso = d.toISOString().slice(0, 10);
  const monthly = d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
  return `https://www.barchart.com/stocks/quotes/${encodeURIComponent(sym)}/options?expiration=${iso}-${monthly ? 'm' : 'w'}&moneyness=allRows`;
}

function renderLadder() {
  const tb = $('ladderTbl').querySelector('tbody');
  tb.innerHTML = TARGETS.map(t => {
    const p = state.ladder[t];
    if (!p) return `<tr><td class="prob">${t}%</td><td colspan="5" class="mut">no matching contract</td></tr>`;
    return `<tr><td class="prob">${t}%</td><td class="big">${fmt$(p.strike)}</td><td class="big">${fmt$(p.bid)}</td>
      <td>${(p.delta * 100).toFixed(1)}%</td><td>${(p.iv * 100).toFixed(1)}%</td><td>${fmtN(p.oi)}</td></tr>`;
  }).join('');
}

function renderStrategies() {
  const expStr = dstr(state.selectedExp);
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  $('strategies').innerHTML = STRATS.map(def => {
    const c = computeStrategy(def);
    const rows = c.rows.map(r => `
      <tr>
        <td>${r.i + 1}</td>
        <td class="editcell"><input type="number" class="shares" data-strat="${def.key}" data-i="${r.i}" value="${r.shares}" step="100" min="0"></td>
        <td>${c.total > 0 ? (r.shares / c.total * 100).toFixed(1) + '%' : '-'}</td>
        <td class="editcell"><select class="prob" data-strat="${def.key}" data-i="${r.i}">
          ${TARGETS.map(t => `<option value="${t}" ${t === r.prob ? 'selected' : ''}>${t}%</option>`).join('')}
        </select></td>
        <td>${r.pick ? fmt$(r.pick.strike) : '-'}</td>
        <td>${r.pick ? fmt$(r.pick.bid) : '-'}</td>
        <td>${fmt$(state.quoteAtLoad)}</td>
        <td>${expStr}</td>
        <td>${r.contracts}</td>
        <td>${fmt$(r.gross)}</td>
        <td>${fmt$(r.net)}</td>
        <td>${fmtPct(r.roi)}</td>
        <td>${fmtPct(r.ann)}</td>
        <td>${fmt$(r.valueIfSold, 0)}</td>
        <td>${c.days}</td>
      </tr>`).join('');
    const mismatch = c.sumShares !== c.total ? ` <span class="badge warn">splits total ${fmtN(c.sumShares)} of ${fmtN(c.total)}</span>` : '';
    return `
    <section class="panel strat ${def.key}">
      <div class="panel-h">${def.label}<span class="spacer"></span>
        <button data-reset="${def.key}">Reset splits</button></div>
      <div class="scrollx"><table class="tbl">
        <thead><tr><th>Batch</th><th>No. of shares (advisor edit)</th><th>Tranche %</th><th>Call prob.</th>
          <th>Strike</th><th>Premium</th><th>Stock at quote</th><th>Expiration</th><th>Contracts</th>
          <th>Gross premiums</th><th>Net premiums</th><th>ROI</th><th>Annualized</th><th>Value if sold</th><th>Days</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td>${fmtN(c.sumShares)}${mismatch}</td><td colspan="7"></td>
          <td>${fmt$(c.rows.reduce((a, r) => a + (r.gross || 0), 0))}</td><td>${fmt$(c.totalNet)}</td><td colspan="4"></td></tr></tfoot>
      </table></div>
      <div class="sumline">
        <div><div class="s-lab">Net premiums</div><div class="s-val grn">${fmt$(c.totalNet)}</div></div>
        <div><div class="s-lab">Overall annualized return</div><div class="s-val">${fmtPct(c.overallAnn)}</div></div>
        <div><div class="s-lab">Potential cash flow / month (net)</div><div class="s-val grn">${fmt$(c.monthly)}</div></div>
        <div><div class="s-lab">Weighted call probability</div><div class="s-val">${c.wProb != null ? c.wProb.toFixed(1) + '%' : '-'}</div></div>
        <div><div class="s-lab">Analysis date</div><div class="s-val">${today}</div></div>
      </div>
    </section>`;
  }).join('');
}

function renderPrintHead() {
  const el = document.querySelector('.printhead');
  el.innerHTML = `<img src="assets/dfi_logo.png" alt="DiversiFi Capital">
    <div style="font-weight:800;font-size:16px;margin-top:6px">Covered Call Analysis - ${$('clientName').value || 'Client'} (${$('symbol').value.trim().toUpperCase()})</div>
    <div class="mut" style="font-size:12px">${state.quote ? state.quote.name + ' at ' + fmt$(state.quote.price) + ' | ' : ''}Prepared ${new Date().toLocaleDateString()} | DiversiFi Capital | Equity Compensation. Simplified.</div>`;
}

function renderAll() {
  if (!state.quote || !state.selectedExp) return;
  renderKpis(); renderLadder(); renderStrategies(); renderPrintHead();
}

/* ================= saved clients ================= */
function getClients() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { return {}; } }
function renderClientList() {
  const names = Object.keys(getClients()).sort();
  $('clientList').innerHTML = '<option value="">Saved clients...</option>' +
    names.map(n => `<option>${n.replace(/</g, '&lt;')}</option>`).join('');
}
function saveClient() {
  const name = $('clientName').value.trim();
  if (!name) { showErr('Enter a client name before saving.'); return; }
  const all = getClients();
  all[name] = { symbol: $('symbol').value.trim().toUpperCase(), shares: parseInt($('shares').value, 10) || 0, fee: parseFloat($('fee').value) || 0.65 };
  localStorage.setItem(LS_KEY, JSON.stringify(all));
  renderClientList(); $('clientList').value = name;
}
function loadClient(name) {
  const c = getClients()[name]; if (!c) return;
  $('clientName').value = name; $('symbol').value = c.symbol; $('shares').value = c.shares; $('fee').value = c.fee;
  state.selectedExp = null;
  Object.keys(state.strat).forEach(k => state.strat[k].forEach(b => { b.shares = null; }));
  loadAll();
}

/* ================= events ================= */
$('loadBtn').addEventListener('click', () => { state.selectedExp = null; loadAll(); });
$('symbol').addEventListener('keydown', e => { if (e.key === 'Enter') { state.selectedExp = null; loadAll(); } });
$('refreshBtn').addEventListener('click', refresh);
$('expSelect').addEventListener('change', e => { state.selectedExp = parseInt(e.target.value, 10); loadAll(); });
$('shares').addEventListener('change', () => {
  Object.keys(state.strat).forEach(k => state.strat[k].forEach(b => { b.shares = null; }));
  renderAll();
});
['fee', 'rf'].forEach(id => $(id).addEventListener('change', () => { if (state.quote) { buildLadder(); renderAll(); } }));
$('clientName').addEventListener('change', renderPrintHead);
$('printBtn').addEventListener('click', () => window.print());
$('saveClient').addEventListener('click', saveClient);
$('clientList').addEventListener('change', e => { if (e.target.value) loadClient(e.target.value); });

$('strategies').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.reset == null && t.dataset.strat == null) return;
  if (t.classList.contains('shares')) {
    state.strat[t.dataset.strat][+t.dataset.i].shares = Math.max(0, parseInt(t.value, 10) || 0);
    renderStrategies();
  } else if (t.classList.contains('prob')) {
    state.strat[t.dataset.strat][+t.dataset.i].prob = parseInt(t.value, 10);
    renderStrategies();
  }
});
$('strategies').addEventListener('click', e => {
  const key = e.target.dataset && e.target.dataset.reset;
  if (!key) return;
  state.strat[key].forEach((b, i) => { b.shares = null; b.prob = STRATS.find(s => s.key === key).batches[i].prob; });
  renderStrategies();
});

/* auto refresh */
function setAuto() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if ($('autoRef').checked) state.timer = setInterval(refresh, 60000);
}
$('autoRef').addEventListener('change', setAuto);
setAuto();

/* print header container + first load */
document.querySelector('main').insertAdjacentHTML('afterbegin', '<div class="printhead"></div>');
renderClientList();
loadAll();
