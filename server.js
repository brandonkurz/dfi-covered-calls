/* DFi Covered Call Analyzer - static file server + Yahoo Finance proxy.
   No dependencies. Run:  node server.js  ->  http://127.0.0.1:8771
   The proxy exists because Yahoo's option-chain endpoints require a
   cookie + crumb handshake and block browser CORS requests. */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8771;
const ROOT = __dirname;
/* Yahoo rate-limits some full browser UA strings; the simple one passes. */
const UA = 'Mozilla/5.0';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

/* ---- Yahoo cookie + crumb, cached for 30 minutes ---- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let auth = { cookie: null, crumb: null, ts: 0 };
let authPromise = null; // serialize concurrent handshakes

async function doHandshake() {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt) await sleep(1200 * attempt);
      const r = await fetchRaw('https://fc.yahoo.com/');
      const cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      const cr = await fetchRaw('https://query1.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookie });
      if (cr.status !== 200 || !cr.body || cr.body.length > 40) {
        throw new Error('crumb handshake got status ' + cr.status);
      }
      auth = { cookie, crumb: cr.body.trim(), ts: Date.now() };
      return auth;
    } catch (e) { lastErr = e; }
  }
  throw new Error('Yahoo handshake failed after retries: ' + lastErr.message);
}
function getAuth(force = false) {
  if (!force && auth.crumb && Date.now() - auth.ts < 30 * 60 * 1000) return Promise.resolve(auth);
  if (!authPromise) authPromise = doHandshake().finally(() => { authPromise = null; });
  return authPromise;
}

/* Fetch with 429 retry + query1/query2 host fallback. */
async function fetchYahoo(url, headers) {
  let r = await fetchRaw(url, headers);
  if (r.status === 429) {
    await sleep(1500);
    r = await fetchRaw(url.replace('query1.', 'query2.'), headers);
  }
  return r;
}

async function yahooAuthed(makeUrl) {
  let a = await getAuth();
  let r = await fetchYahoo(makeUrl(encodeURIComponent(a.crumb)), { Cookie: a.cookie });
  if (r.status === 401 || r.status === 403) {
    a = await getAuth(true);
    r = await fetchYahoo(makeUrl(encodeURIComponent(a.crumb)), { Cookie: a.cookie });
  }
  return r;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
/* Pass upstream JSON through; wrap non-JSON bodies (rate-limit text etc.) as a JSON error. */
function sendUpstream(res, r) {
  const b = (r.body || '').trim();
  if (b.startsWith('{') || b.startsWith('[')) return sendJson(res, r.status, r.body);
  return sendJson(res, 502, { error: 'Yahoo returned ' + r.status + (b ? ': ' + b.slice(0, 120) : '') });
}

async function handleApi(req, res, urlPath, params) {
  const symbol = encodeURIComponent((params.get('symbol') || '').trim().toUpperCase());
  if (!symbol) return sendJson(res, 400, { error: 'symbol required' });
  try {
    if (urlPath === '/api/quote') {
      const r = await fetchYahoo(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`);
      return sendUpstream(res, r);
    }
    if (urlPath === '/api/options') {
      const date = params.get('date');
      const r = await yahooAuthed(crumb =>
        `https://query1.finance.yahoo.com/v7/finance/options/${symbol}?crumb=${crumb}` + (date ? `&date=${encodeURIComponent(date)}` : ''));
      return sendUpstream(res, r);
    }
    if (urlPath === '/api/earnings') {
      const r = await yahooAuthed(crumb =>
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents,summaryDetail&crumb=${crumb}`);
      return sendUpstream(res, r);
    }
    return sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return sendJson(res, 502, { error: String(e.message || e) });
  }
}

http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const urlPath = decodeURIComponent(u.pathname);
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath, u.searchParams);

  let filePath = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`DFi Covered Call Analyzer at http://127.0.0.1:${PORT}/  Ctrl+C to stop.`);
});
