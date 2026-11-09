// Thin wrapper around Yahoo Finance's public chart + search endpoints.
// No API key needed. Responses are normalised into a compact shape for the client.

const BASE = 'https://query1.finance.yahoo.com';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  Accept: 'application/json',
};

// Range presets exposed to the client -> Yahoo range/interval pairs.
export const RANGES = {
  '1d': { range: '1d', interval: '1m', prePost: true },
  '5d': { range: '5d', interval: '5m', prePost: false },
  '1mo': { range: '1mo', interval: '30m', prePost: false },
  '6mo': { range: '6mo', interval: '1d', prePost: false },
  '1y': { range: '1y', interval: '1d', prePost: false },
  '2y': { range: '2y', interval: '1d', prePost: false },
  '5y': { range: '5y', interval: '1wk', prePost: false },
};

// Longer fetch at the same interval, used only to warm up moving averages (EMA 150 needs
// 150+ earlier bars to be accurate from the first bar on screen).
const WARMUP = {
  '1d': { range: '5d', interval: '1m', prePost: true },
  '5d': { range: '1mo', interval: '5m', prePost: false },
  '1mo': { range: '3mo', interval: '30m', prePost: false },
  '6mo': { range: '2y', interval: '1d', prePost: false },
  '1y': { range: '2y', interval: '1d', prePost: false },
  '5y': { range: '10y', interval: '1wk', prePost: false },
};
// ~3x the longest EMA period so the seed has washed out. For 1-minute bars we send ~3 full
// sessions instead, because the volume-spike baseline needs earlier days at the same time of day.
const WARMUP_BARS = 450;
const WARMUP_BARS_1M = 3 * 390;

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,20}$/;
export const isValidSymbol = (s) => typeof s === 'string' && SYMBOL_RE.test(s);

// Tiny TTL cache so many clients / rapid range switches don't hammer Yahoo.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const err = new Error(res.status === 404 ? 'Symbol not found' : `Data source error (${res.status})`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  return res.json();
}

function marketState(meta, nowSec) {
  const p = meta.currentTradingPeriod;
  if (!p) return 'UNKNOWN';
  if (nowSec >= p.regular.start && nowSec < p.regular.end) return 'REGULAR';
  if (p.pre && nowSec >= p.pre.start && nowSec < p.pre.end) return 'PRE';
  if (p.post && nowSec >= p.post.start && nowSec < p.post.end) return 'POST';
  return 'CLOSED';
}

/**
 * Yahoo's intraday feed sometimes puts the running day total into a single minute bar
 * (e.g. 276M on a bar that really traded ~600k). Replace bars wildly above the median
 * of their neighbours with that median so the volume chart and RVOL stay meaningful.
 */
function sanitiseVolume(bars) {
  const W = 30;
  const vols = bars.map((b) => b.volume);
  for (let i = 0; i < bars.length; i++) {
    const v = vols[i];
    if (!v) continue;
    const win = vols.slice(Math.max(0, i - W), i + W + 1).filter((x, j) => x > 0 && j !== i - Math.max(0, i - W));
    if (win.length < 10) continue;
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    if (v > med * 60) bars[i].volume = med;
  }
}

function normalise(json, { intraday = false } = {}) {
  const result = json?.chart?.result?.[0];
  if (!result) {
    const err = new Error(json?.chart?.error?.description || 'Symbol not found');
    err.status = 404;
    throw err;
  }
  const { meta, timestamp = [], indicators } = result;
  const q = indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < timestamp.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue; // Yahoo pads gaps with nulls
    bars.push({ time: timestamp[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }

  if (intraday) sanitiseVolume(bars);

  const nowSec = Math.floor(Date.now() / 1000);
  const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
  const price = meta.regularMarketPrice ?? bars.at(-1)?.close ?? null;
  const state = marketState(meta, nowSec);
  const lastBar = bars.at(-1);
  // Outside regular hours the latest 1m bar carries the extended-hours price.
  const extPrice =
    (state === 'PRE' || state === 'POST') && lastBar && lastBar.time > (meta.regularMarketTime ?? 0)
      ? lastBar.close
      : null;

  return {
    quote: {
      symbol: meta.symbol,
      name: meta.longName || meta.shortName || meta.symbol,
      exchange: meta.fullExchangeName || meta.exchangeName,
      currency: meta.currency,
      instrumentType: meta.instrumentType,
      timezone: meta.exchangeTimezoneName,
      gmtOffset: meta.gmtoffset ?? 0,
      price,
      prevClose,
      change: price != null && prevClose != null ? price - prevClose : null,
      changePct: price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
      dayHigh: meta.regularMarketDayHigh ?? null,
      dayLow: meta.regularMarketDayLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      extPrice,
      marketState: state,
      // Regular-session window (unix sec) for the current/most recent trading day.
      session: meta.currentTradingPeriod?.regular
        ? { start: meta.currentTradingPeriod.regular.start, end: meta.currentTradingPeriod.regular.end }
        : null,
      marketTime: meta.regularMarketTime ?? null,
      updatedAt: Date.now(),
    },
    bars,
  };
}

const chartUrl = (symbol, p) =>
  `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}` +
  `?range=${p.range}&interval=${p.interval}&includePrePost=${p.prePost}`;

/**
 * Bars immediately before `firstTime` at the same interval as `rangeKey`, for warming up
 * indicators. Cached for 10 minutes (the history doesn't change). Never throws.
 */
export async function getWarmup(symbol, rangeKey, firstTime) {
  const p = WARMUP[rangeKey];
  if (!p || firstTime == null) return [];
  try {
    const data = await cached(`warmup:${symbol}:${rangeKey}`, 10 * 60_000, async () =>
      normalise(await getJson(chartUrl(symbol, p)), { intraday: /m$/.test(p.interval) }),
    );
    const keep = p.interval === '1m' ? WARMUP_BARS_1M : WARMUP_BARS;
    // 1m: regular-session bars only (pre/post volume would distort the time-of-day baseline).
    const rows = data.bars.filter((b) => b.time < firstTime);
    const regular = p.interval === '1m' ? rows.filter((b) => b.volume > 0) : rows;
    return regular.slice(-keep);
  } catch {
    return [];
  }
}

export async function getChart(symbol, rangeKey = '1d', { ttlMs = 4000 } = {}) {
  const preset = RANGES[rangeKey] || RANGES['1d'];
  const url = chartUrl(symbol, preset);
  return cached(`chart:${symbol}:${rangeKey}`, ttlMs, async () => {
    const data = normalise(await getJson(url), { intraday: /m$/.test(preset.interval) });
    // For multi-day ranges Yahoo's "previous close" is the close before the range starts,
    // so the quote header (price, day change, day range) always comes from the 1d feed.
    if (rangeKey !== '1d') {
      try {
        data.quote = (await getChart(symbol, '1d', { ttlMs })).quote;
      } catch {
        /* keep range-derived quote */
      }
    }
    return data;
  });
}

// ---------------------------------------------------------------------------
// Analyst data (quoteSummary) needs a session cookie + "crumb" token.
// ---------------------------------------------------------------------------
let session = null; // { cookie, crumb, at }
let sessionFailedAt = 0; // back off after a failure so every request doesn't retry the handshake
export const sessionStatus = { ok: null, error: null, at: null };

const cookiesFrom = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);

/**
 * Yahoo hands out a cookie + "crumb" token for its authenticated endpoints. Some hosting
 * IPs (e.g. cloud providers) get no cookie from fc.yahoo.com, so try a couple of sources
 * and both query hosts before giving up. Callers must treat failure as "feature unavailable".
 */
async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < 30 * 60_000) return session;
  if (!force && Date.now() - sessionFailedAt < 5 * 60_000) throw new Error(sessionStatus.error || 'Yahoo session unavailable');

  const ua = { 'User-Agent': HEADERS['User-Agent'] };
  const attempts = [];
  const cookieSources = [
    () => fetch('https://fc.yahoo.com', { headers: ua, redirect: 'manual' }),
    () => fetch('https://login.yahoo.com/', { headers: { ...ua, Accept: 'text/html' }, redirect: 'manual' }),
  ];
  for (const src of cookieSources) {
    let cookie = '';
    try {
      cookie = cookiesFrom(await src()).join('; ');
    } catch (e) {
      attempts.push(`cookie: ${e.message}`);
      continue;
    }
    if (!cookie) {
      attempts.push('no cookie');
      continue;
    }
    for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
      try {
        // getcrumb returns text/plain and rejects `Accept: application/json` with 406.
        const r = await fetch(`${host}/v1/test/getcrumb`, { headers: { ...ua, Accept: '*/*', Cookie: cookie } });
        const crumb = (await r.text()).trim();
        if (r.ok && crumb && !crumb.includes('<') && !crumb.includes('{')) {
          session = { cookie, crumb, at: Date.now() };
          Object.assign(sessionStatus, { ok: true, error: null, at: Date.now() });
          return session;
        }
        attempts.push(`crumb ${r.status}`);
      } catch (e) {
        attempts.push(`crumb: ${e.message}`);
      }
    }
  }
  sessionFailedAt = Date.now();
  const error = `Could not obtain Yahoo session (${attempts.join(', ')})`;
  Object.assign(sessionStatus, { ok: false, error, at: Date.now() });
  throw new Error(error);
}

const raw = (v) => (v && typeof v === 'object' ? v.raw ?? null : v ?? null);

/** Analyst consensus + price targets. Resolves to null when unavailable (ETFs, crypto, …). */
export async function getAnalyst(symbol) {
  try {
    return await fetchAnalyst(symbol);
  } catch {
    return null; // transient failure: not cached, retried on the next request
  }
}

function fetchAnalyst(symbol) {
  return cached(`analyst:${symbol}`, 30 * 60_000, async () => {
    const fetchOnce = async (force) => {
      const s = await getSession(force);
      const url =
        `${BASE}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
        `?modules=financialData,recommendationTrend,calendarEvents&crumb=${encodeURIComponent(s.crumb)}`;
      return fetch(url, { headers: { ...HEADERS, Cookie: s.cookie } });
    };
    {
      let res = await fetchOnce(false);
      if (res.status === 401 || res.status === 403) res = await fetchOnce(true);
      if (res.status === 404) return null; // genuinely no coverage — cache that
      if (!res.ok) throw new Error(`quoteSummary ${res.status}`);
      const r = (await res.json())?.quoteSummary?.result?.[0];
      if (!r) return null;
      const fd = r.financialData || {};
      const trend = r.recommendationTrend?.trend?.find((t) => t.period === '0m') || null;
      const earnings = r.calendarEvents?.earnings?.earningsDate?.map(raw).filter(Boolean) || [];
      const out = {
        nextEarnings: earnings.find((t) => t * 1000 > Date.now() - 86400_000) ?? null,
        recommendationMean: raw(fd.recommendationMean), // 1 = strong buy … 5 = strong sell
        recommendationKey: fd.recommendationKey || null,
        analystCount: raw(fd.numberOfAnalystOpinions),
        targetMean: raw(fd.targetMeanPrice),
        targetHigh: raw(fd.targetHighPrice),
        targetLow: raw(fd.targetLowPrice),
        trend: trend && {
          strongBuy: trend.strongBuy,
          buy: trend.buy,
          hold: trend.hold,
          sell: trend.sell,
          strongSell: trend.strongSell,
        },
      };
      return out.recommendationMean == null && !out.trend && !out.nextEarnings ? null : out;
    }
  });
}

// ---------------------------------------------------------------------------
// Top movers: today's biggest gainers that are trading on unusually high volume.
// ---------------------------------------------------------------------------
// Main US listing venues (Yahoo codes): Nasdaq GS/GM/CM, NYSE, NYSE American, Cboe BZX, NYSE Arca.
// Excludes OTC / pink sheets, where sub-penny "gainers" of +1000% are noise.
const US_EXCHANGES = ['NMS', 'NGM', 'NCM', 'NYQ', 'ASE', 'BTS', 'PCX'];

const MOVER_RULES = {
  minPrice: 1, // no sub-$1 stocks
  minVolume: 500_000, // shares traded today
  minMarketCap: 50e6, // drops shells / near-delisted names
  minRvol: 1.5, // today's volume vs 3-month average
  smallCap: 300e6, // flagged as higher-risk in the UI
};

/**
 * Yahoo's full equity screener (the one behind finance.yahoo.com's Gainers page), sorted by
 * % change. The predefined "day_gainers" list only covers ~$2B+ companies, so it misses
 * small caps that lead the real gainers board.
 */
async function gainersScreener(size = 100) {
  const body = {
    size,
    offset: 0,
    sortField: 'percentchange',
    sortType: 'DESC',
    quoteType: 'EQUITY',
    query: {
      operator: 'AND',
      operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'or', operands: US_EXCHANGES.map((e) => ({ operator: 'eq', operands: ['exchange', e] })) },
        { operator: 'gt', operands: ['percentchange', 0] },
        { operator: 'gte', operands: ['intradayprice', MOVER_RULES.minPrice] },
        { operator: 'gt', operands: ['dayvolume', MOVER_RULES.minVolume] },
      ],
    },
    userId: '',
    userIdType: 'guid',
  };
  const fetchOnce = async (force) => {
    const s = await getSession(force);
    return fetch(`${BASE}/v1/finance/screener?crumb=${encodeURIComponent(s.crumb)}`, {
      method: 'POST',
      headers: { ...HEADERS, Cookie: s.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  let res = await fetchOnce(false);
  if (res.status === 401 || res.status === 403) res = await fetchOnce(true);
  if (!res.ok) throw Object.assign(new Error(`Screener error (${res.status})`), { status: 502 });
  return (await res.json())?.finance?.result?.[0]?.quotes || [];
}

/** Yahoo's predefined screeners. These work without a session (unlike the full screener). */
async function predefinedScreener(scrId, count = 100) {
  for (const host of ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com']) {
    try {
      const r = await fetch(`${host}/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}`, { headers: HEADERS });
      if (r.ok) return (await r.json())?.finance?.result?.[0]?.quotes || [];
    } catch {
      /* try next host */
    }
  }
  return [];
}

const NASDAQ_HEADERS = {
  'User-Agent': HEADERS['User-Agent'],
  Accept: 'application/json',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

/** Nasdaq.com's public "most advanced" list (all US exchanges, includes small caps). */
async function nasdaqAdvancers() {
  const r = await fetch('https://api.nasdaq.com/api/marketmovers?assetclass=stocks&limit=50', { headers: NASDAQ_HEADERS });
  if (!r.ok) throw new Error(`Nasdaq movers ${r.status}`);
  const rows = (await r.json())?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const num = (s) => Number(String(s ?? '').replace(/[$,%+]/g, ''));
  return rows
    .map((x) => ({ symbol: x.symbol, name: x.name, price: num(x.lastSalePrice), changePct: num(x.change) }))
    .filter((x) => /^[A-Z.]{1,6}$/.test(x.symbol) && x.price >= MOVER_RULES.minPrice && x.changePct > 0);
}

/** Market cap from Nasdaq's quote summary (used when Yahoo's screener data is unavailable). */
async function nasdaqMarketCap(symbol) {
  return cached(`nasdaqcap:${symbol}`, 30 * 60_000, async () => {
    const r = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`, {
      headers: NASDAQ_HEADERS,
    });
    if (!r.ok) return null;
    const v = Number(String((await r.json())?.data?.summaryData?.MarketCap?.value ?? '').replace(/[^0-9.]/g, ''));
    return v > 0 ? v : null;
  });
}

/**
 * Volume/market data for one symbol from the chart endpoint (no session needed):
 * today's volume, 3-month average daily volume, exchange, and an approximate market cap.
 */
async function moverDetails(symbol) {
  return cached(`moverdetail:${symbol}`, 60_000, async () => {
    const j = await getJson(chartUrl(symbol, { range: '3mo', interval: '1d', prePost: false }));
    const res = j?.chart?.result?.[0];
    const m = res?.meta;
    const vols = (res?.indicators?.quote?.[0]?.volume || []).filter((v) => v > 0);
    if (!m || vols.length < 10) return null;
    const prior = vols.slice(0, -1);
    return {
      symbol: m.symbol,
      name: m.longName || m.shortName || m.symbol,
      exchangeCode: m.exchangeName,
      exchange: m.fullExchangeName || m.exchangeName,
      type: m.instrumentType,
      price: m.regularMarketPrice,
      prevClose: m.chartPreviousClose ?? m.previousClose,
      volume: m.regularMarketVolume ?? vols.at(-1),
      avgVolume: prior.reduce((a, b) => a + b, 0) / prior.length,
    };
  });
}

// Yahoo exchange codes as reported by the chart endpoint for the same venues as US_EXCHANGES.
const CHART_EXCHANGES = new Set([...US_EXCHANGES, 'NYS', 'NAS', 'NGS', 'NIM', 'NSQ', 'AMEX', 'NYSEArca']);

function toMover(q) {
  const rvol = q.volume / q.avgVolume;
  return {
    symbol: q.symbol,
    name: q.name,
    exchange: q.exchange,
    price: q.price,
    change: q.change,
    changePct: q.changePct,
    volume: q.volume,
    avgVolume: q.avgVolume,
    rvol,
    marketCap: q.marketCap ?? null,
    smallCap: q.marketCap != null ? q.marketCap < MOVER_RULES.smallCap : null,
  };
}

const passesRules = (q) =>
  q.symbol &&
  q.changePct > 0 &&
  q.price >= MOVER_RULES.minPrice &&
  q.volume >= MOVER_RULES.minVolume &&
  q.avgVolume > 0 &&
  q.volume / q.avgVolume >= MOVER_RULES.minRvol &&
  (q.marketCap == null || q.marketCap >= MOVER_RULES.minMarketCap);

/** Source 1: Yahoo full screener (needs a session). Same data as finance.yahoo.com Gainers. */
async function moversFromYahooScreener() {
  const quotes = await gainersScreener(100);
  return quotes
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      exchange: q.fullExchangeName || q.exchange,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
      // 3-month average is the "normal" baseline; the 10-day one is inflated by recent spikes.
      avgVolume: q.averageDailyVolume3Month || q.averageDailyVolume10Day,
      marketCap: q.marketCap ?? 0,
    }))
    .filter(passesRules);
}

/**
 * Source 2 (no session needed): candidates from Nasdaq's advancers plus Yahoo's predefined
 * gainer lists, each verified via the chart endpoint for exchange, volume and average volume.
 */
async function moversWithoutSession() {
  const [nasdaq, dayGainers, smallGainers] = await Promise.all([
    nasdaqAdvancers().catch(() => []),
    predefinedScreener('day_gainers'),
    predefinedScreener('small_cap_gainers'),
  ]);
  const caps = new Map(); // market cap is known for Yahoo-listed candidates
  const candidates = new Map();
  for (const q of [...dayGainers, ...smallGainers]) {
    if (!q.symbol || !(q.regularMarketChangePercent > 0)) continue;
    caps.set(q.symbol, q.marketCap ?? null);
    candidates.set(q.symbol, q.regularMarketChangePercent);
  }
  for (const n of nasdaq) if (!candidates.has(n.symbol)) candidates.set(n.symbol, n.changePct);
  if (!candidates.size) throw new Error('No mover sources reachable');

  // Verify the biggest gainers first; 40 parallel chart calls is quick and cached for 60 s.
  const top = [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  const details = await Promise.all(top.map(([s]) => moverDetails(s).catch(() => null)));
  const prelim = details
    .filter((d) => d && d.type === 'EQUITY' && CHART_EXCHANGES.has(d.exchangeCode) && d.prevClose)
    .map((d) => ({
      ...d,
      change: d.price - d.prevClose,
      changePct: ((d.price - d.prevClose) / d.prevClose) * 100,
      marketCap: caps.get(d.symbol) ?? null,
    }))
    .filter(passesRules);

  // Fill in any missing market caps (only for the few that already pass), then re-apply the rules.
  await Promise.all(
    prelim
      .filter((q) => q.marketCap == null)
      .slice(0, 8)
      .map(async (q) => {
        q.marketCap = await nasdaqMarketCap(q.symbol).catch(() => null);
      }),
  );
  return prelim.filter(passesRules);
}

/**
 * Today's biggest US gainers (sorted by % gain, like Yahoo's Gainers page) that are also
 * trading on unusually high volume (>= 1.5x their 3-month average). Uses Yahoo's full
 * screener when a session is available, otherwise a session-free fallback.
 */
export async function getTopMovers(limit = 3) {
  return cached('movers', 30_000, async () => {
    let rows, source;
    try {
      rows = await moversFromYahooScreener();
      source = 'yahoo-screener';
    } catch (e) {
      rows = await moversWithoutSession();
      source = 'nasdaq+yahoo-chart';
    }
    rows.sort((a, b) => b.changePct - a.changePct);
    return {
      movers: rows.slice(0, limit).map(toMover),
      candidates: rows.length,
      source,
      rules: MOVER_RULES,
      updatedAt: Date.now(),
    };
  });
}

async function yahooSearch(query) {
  for (const host of ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com']) {
    try {
      const json = await getJson(
        `${host}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=true`,
      );
      const rows = (json.quotes || [])
        .filter((q) => q.symbol && q.isYahooFinance !== false)
        .map((q) => ({
          symbol: q.symbol,
          name: q.longname || q.shortname || q.symbol,
          exchange: q.exchDisp || q.exchange,
          type: q.typeDisp || q.quoteType,
        }));
      if (rows.length) return rows;
    } catch {
      /* try the next host */
    }
  }
  return [];
}

/** Fallback: Nasdaq's symbol lookup (US stocks and ETFs only). */
async function nasdaqSearch(query) {
  const r = await fetch(`https://api.nasdaq.com/api/autocomplete/slookup/8?search=${encodeURIComponent(query)}`, {
    headers: NASDAQ_HEADERS,
  });
  if (!r.ok) return [];
  return ((await r.json())?.data || [])
    .filter((x) => x.symbol && (x.asset === 'STOCKS' || x.asset === 'ETF') && /^[A-Z.]{1,6}$/.test(x.symbol))
    .map((x) => ({
      symbol: x.symbol,
      name: String(x.name || x.symbol).replace(/ (Common Stock|Common Shares|Ordinary Shares).*$/i, ''),
      exchange: x.exchange || 'US',
      type: x.asset === 'ETF' ? 'ETF' : 'Equity',
    }));
}

export async function search(query) {
  const key = `search:${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let rows = await yahooSearch(query);
  if (!rows.length) rows = await nasdaqSearch(query).catch(() => []);
  // Don't cache an empty result for long: it may be a temporary upstream problem.
  cache.set(key, { at: rows.length ? Date.now() : Date.now() - 50_000, value: rows });
  return rows;
}

/** Quick self-check of every upstream, for the /api/diagnostics endpoint. */
export async function diagnose() {
  const t = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      return { name, ok: true, ms: Date.now() - t0, detail };
    } catch (e) {
      return { name, ok: false, ms: Date.now() - t0, error: e.message };
    }
  };
  return Promise.all([
    t('yahoo chart', async () => (await getJson(chartUrl('AAPL', { range: '1d', interval: '1d', prePost: false }))).chart.result[0].meta.symbol),
    t('yahoo search', async () => (await yahooSearch('apple')).length + ' results'),
    t('yahoo session (crumb)', async () => ((await getSession(true)).crumb ? 'ok' : 'none')),
    t('yahoo predefined screener', async () => (await predefinedScreener('day_gainers', 5)).length + ' rows'),
    t('nasdaq movers', async () => (await nasdaqAdvancers()).length + ' rows'),
    t('nasdaq search', async () => (await nasdaqSearch('apple')).length + ' results'),
  ]);
}
