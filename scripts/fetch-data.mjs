/* Fetches quotes, earnings, and option chains for every ticker in tickers.json
   and writes trimmed JSON payloads to data/<SYMBOL>.json.
   Run by GitHub Actions on a schedule so the GitHub Pages build of the app
   has data without a live proxy. Node 18+, no dependencies. */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0';
const MAX_DTE = 130; // cache chains this far out; covers auto-pick + overrides
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cookie = '', crumb = '';
async function handshake() {
  const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  crumb = (await cr.text()).trim();
  if (!cr.ok || !crumb || crumb.length > 40) throw new Error('crumb handshake failed: ' + cr.status);
}

async function getJson(url, attempt = 0) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });
  if ((r.status === 429 || r.status === 401 || r.status === 403) && attempt < 3) {
    await sleep(1500 * (attempt + 1));
    if (r.status !== 429) await handshake();
    return getJson(url.replace(/query[12]\./, attempt % 2 ? 'query1.' : 'query2.'), attempt + 1);
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.json();
}

async function fetchSymbol(sym) {
  const enc = encodeURIComponent(sym);
  const chart = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${enc}?range=1d&interval=1d`);
  const m = chart.chart.result[0].meta;
  const quote = { price: m.regularMarketPrice, prevClose: m.chartPreviousClose,
                  name: m.longName || m.shortName || sym, time: m.regularMarketTime };

  let earnTs = null, divYield = 0;
  try {
    const qs = await getJson(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${enc}?modules=calendarEvents,summaryDetail&crumb=${encodeURIComponent(crumb)}`);
    const res = qs.quoteSummary.result[0];
    const e = res.calendarEvents && res.calendarEvents.earnings && res.calendarEvents.earnings.earningsDate;
    earnTs = (e && e.length) ? e[0].raw : null;
    divYield = (res.summaryDetail && res.summaryDetail.dividendYield && res.summaryDetail.dividendYield.raw) || 0;
  } catch (e) { console.log(`  ${sym}: earnings lookup failed (${e.message}), continuing`); }

  const root = await getJson(`https://query1.finance.yahoo.com/v7/finance/options/${enc}?crumb=${encodeURIComponent(crumb)}`);
  const all = root.optionChain.result[0].expirationDates || [];
  const now = Date.now() / 1000;
  const wanted = all.filter(e => e > now && (e - now) / 86400 <= MAX_DTE);

  const chains = {};
  for (const exp of wanted) {
    await sleep(400);
    const c = await getJson(`https://query1.finance.yahoo.com/v7/finance/options/${enc}?crumb=${encodeURIComponent(crumb)}&date=${exp}`);
    const calls = (c.optionChain.result[0].options[0] || {}).calls || [];
    chains[exp] = calls.map(x => ({ strike: x.strike, bid: x.bid || 0, ask: x.ask || 0,
      impliedVolatility: x.impliedVolatility || 0, openInterest: x.openInterest || 0 }));
  }
  return { symbol: sym, fetchedAt: new Date().toISOString(), quote, earnTs, divYield, chains };
}

const tickers = JSON.parse(readFileSync(join(ROOT, 'tickers.json'), 'utf8'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
await handshake();

let ok = 0;
for (const sym of tickers) {
  try {
    const payload = await fetchSymbol(sym);
    writeFileSync(join(ROOT, 'data', sym + '.json'), JSON.stringify(payload));
    ok++;
    console.log(`${sym}: ${Object.keys(payload.chains).length} expirations @ ${payload.quote.price}`);
  } catch (e) {
    console.log(`${sym}: FAILED - ${e.message} (keeping previous data if any)`);
  }
  await sleep(600);
}
console.log(`Done: ${ok}/${tickers.length} tickers updated.`);
if (ok === 0) process.exit(1);
