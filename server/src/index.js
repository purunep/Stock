import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
// Load secrets from the repo-root .env in development (git-ignored). On Render/other hosts,
// set them in the dashboard's environment settings instead; a missing file is fine.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch {
  /* no .env file */
}

import { getChart, getWarmup, search, getTopMovers, diagnose, isValidSymbol, RANGES } from './yahoo.js';
import { analyse } from './analysis.js';
import { getNews, getCatalyst, getNewsFeed, newsEnabled, CORE_SYMBOLS } from './news.js';

const IS_PROD = process.env.NODE_ENV === 'production';
// In production hosts (Render, Fly, Heroku…) assign the port via PORT. In dev we use API_PORT
// instead, because tools that preview the frontend set PORT for *it* and would collide.
const PORT = Number(process.env.API_PORT) || (IS_PROD ? Number(process.env.PORT) : 0) || 4000;
// How often each live feed re-polls the upstream source.
const POLL_MS = { '1d': 5_000, '5d': 15_000, default: 60_000 };
const MAX_WS_CLIENTS = 200; // protects the free instance's memory and Yahoo's goodwill

const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
const SERVE_CLIENT = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));

const app = express();
app.set('trust proxy', 1); // behind the host's load balancer: use the real client IP
// In production the UI is served from this same origin, so CORS is only needed for local dev.
if (!IS_PROD) app.use(cors());

// Health check (used by the host to know the service is up) — before the rate limiter.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Reports which upstream data sources are reachable from this server (handy on a new host,
// where cloud IPs are sometimes treated differently by Yahoo). Cached so it can't be abused.
let diagCache = { at: 0, value: null };
app.get('/api/diagnostics', async (_req, res) => {
  if (Date.now() - diagCache.at > 60_000) diagCache = { at: Date.now(), value: await diagnose() };
  res.json({
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    news: newsEnabled() ? 'enabled (FINNHUB_API_KEY set)' : 'disabled (FINNHUB_API_KEY not set)',
    checks: diagCache.value,
  });
});

// Tiny per-IP rate limit for /api (no extra dependency). Cached upstream data makes most
// calls cheap, but search/analysis for unseen symbols hit Yahoo, so cap abusive clients.
const hits = new Map(); // ip -> { n, reset }
const LIMIT = 120; // requests per window
const WINDOW_MS = 60_000;
app.use('/api', (req, res, next) => {
  const now = Date.now();
  let h = hits.get(req.ip);
  if (!h || now > h.reset) hits.set(req.ip, (h = { n: 0, reset: now + WINDOW_MS }));
  if (++h.n > LIMIT) {
    res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests, slow down for a minute.' });
  }
  next();
});
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now > h.reset) hits.delete(ip);
}, WINDOW_MS).unref();

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    res.json(await search(q.slice(0, 50)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/chart/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const range = String(req.query.range || '1d');
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  if (!RANGES[range]) return res.status(400).json({ error: 'Invalid range' });
  try {
    res.json(await getChart(symbol.toUpperCase(), range));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/movers', async (req, res) => {
  // ?session=post|regular overrides the clock (handy for checking a session outside its hours).
  // A forced 'pre' outside pre-market hours returns an empty list, since no trades fall in it.
  const force = ['pre', 'post', 'regular'].includes(req.query.session) ? req.query.session : null;
  try {
    const data = await getTopMovers(3, force);
    // Tag each mover with its news catalyst ("Earnings", "Share offering", "No news"…).
    // Cached per symbol for 3 min, so this is ~3 Finnhub calls per 3 min at most.
    const movers = await Promise.all(
      (data.movers || []).map(async (m) => ({ ...m, catalyst: await getCatalyst(m.symbol, m.name) })),
    );
    res.json({ ...data, movers });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Live market news: newest symbol-tagged headlines across the user's watchlist, the current
// top gainers and the biggest US companies. ?symbols=AAPL,TSLA (max 15) = the user's list.
app.get('/api/news-feed', async (req, res) => {
  const watch = String(req.query.symbols || '')
    .toUpperCase()
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Z.]{1,6}$/.test(s))
    .slice(0, 15);
  try {
    // Top gainers: whatever the movers panel currently shows (cached/snapshot, cheap).
    const movers = await getTopMovers(3).then((d) => d.movers || []).catch(() => []);
    const entries = [];
    const add = (symbol, name, reason) => {
      if (!entries.some((e) => e.symbol === symbol)) entries.push({ symbol, name, reason });
    };
    movers.forEach((m) => add(m.symbol, m.name, 'mover'));
    watch.forEach((s) => add(s, '', 'watch'));
    CORE_SYMBOLS.forEach((s) => add(s, '', 'core'));
    // Company names make the "headline names this company" check work (cached quotes).
    await Promise.all(
      entries.filter((e) => !e.name).map(async (e) => {
        e.name = await getChart(e.symbol, '1d', { ttlMs: 10 * 60_000 }).then((d) => d.quote.name).catch(() => '');
      }),
    );
    res.json(await getNewsFeed(entries, { limit: 10 }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/news/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  try {
    const sym = symbol.toUpperCase();
    // Company name helps decide which articles are really about this company.
    const name = await getChart(sym, '1d').then((d) => d.quote.name).catch(() => '');
    res.json(await getNews(sym, name));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/analysis/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  try {
    res.json(await analyse(symbol.toUpperCase()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Serve the built React app (client/dist) when present: one service, one URL, no CORS.
if (SERVE_CLIENT) {
  // Hashed assets never change: cache them hard (registered first so it wins).
  app.use('/assets', express.static(path.join(CLIENT_DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  // SPA fallback for any non-API GET (e.g. /?symbol=AAPL, deep links).
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Live feed over WebSocket.
// One poller per (symbol, range) is shared by every client subscribed to it.
// Client -> {type:'subscribe', symbol, range} | {type:'unsubscribe'}
// Server -> {type:'snapshot', key, quote, bars, warmup} on subscribe (warmup = earlier bars for indicators)
//           {type:'tick', key, quote, bars:[last few bars]} on each poll
//           {type:'error', key, error}
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });
const feeds = new Map(); // key -> { symbol, range, clients:Set, timer, last }

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

async function poll(feed) {
  const key = `${feed.symbol}:${feed.range}`;
  try {
    const data = await getChart(feed.symbol, feed.range);
    feed.last = data;
    const msg = { type: 'tick', key, quote: data.quote, bars: data.bars.slice(-3) };
    for (const ws of feed.clients) send(ws, msg);
  } catch (e) {
    for (const ws of feed.clients) send(ws, { type: 'error', key, error: e.message });
  }
}

function leave(ws) {
  const key = ws.feedKey;
  if (!key) return;
  ws.feedKey = null;
  const feed = feeds.get(key);
  if (!feed) return;
  feed.clients.delete(ws);
  if (feed.clients.size === 0) {
    clearInterval(feed.timer);
    feeds.delete(key);
  }
}

async function join(ws, symbol, range) {
  leave(ws);
  const key = `${symbol}:${range}`;
  ws.feedKey = key;
  let feed = feeds.get(key);
  if (!feed) {
    feed = { symbol, range, clients: new Set(), last: null };
    feed.timer = setInterval(() => poll(feed), POLL_MS[range] ?? POLL_MS.default);
    feeds.set(key, feed);
  }
  feed.clients.add(ws);
  try {
    const data = await getChart(symbol, range);
    const warmup = await getWarmup(symbol, range, data.bars[0]?.time);
    if (ws.feedKey !== key) return; // client switched while we were fetching
    send(ws, { type: 'snapshot', key, quote: data.quote, bars: data.bars, warmup });
  } catch (e) {
    send(ws, { type: 'error', key, error: e.message });
  }
}

wss.on('connection', (ws) => {
  if (wss.clients.size > MAX_WS_CLIENTS) {
    ws.close(1013, 'Server busy'); // 1013 = try again later
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'subscribe') {
      const symbol = String(msg.symbol || '').toUpperCase();
      const range = RANGES[msg.range] ? msg.range : '1d';
      if (!isValidSymbol(symbol)) return send(ws, { type: 'error', error: 'Invalid symbol' });
      join(ws, symbol, range);
    } else if (msg.type === 'unsubscribe') {
      leave(ws);
    }
  });
  ws.on('close', () => leave(ws));
});

// Drop dead connections so their feeds can shut down.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(
    `Stock server listening on port ${PORT} (ws: /ws)${SERVE_CLIENT ? ', serving client/dist' : ', API only (no client build found)'}`,
  );
});

// Let the host stop us cleanly on deploys/restarts.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    wss.clients.forEach((c) => c.close(1001, 'Server restarting'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
