// Company news from Finnhub, tagged by catalyst type and tone.
//
// The API key is read from the FINNHUB_API_KEY environment variable (a local .env file in
// development, the host's environment settings in production). It never leaves the server.
// Free plan: 60 calls/minute, so every call is cached and a local limiter keeps us well under.

const BASE = 'https://finnhub.io/api/v1';
const key = () => process.env.FINNHUB_API_KEY || '';
export const newsEnabled = () => Boolean(key());

// ---- tiny cache + rate limiter -------------------------------------------------------
const cache = new Map();
const calls = []; // timestamps of recent calls
const MAX_PER_MIN = 45; // stay under Finnhub's 60/min

/** Calls left in the current minute (the live feed leaves headroom for the per-stock panel). */
function callsLastMinute() {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  return calls.length;
}

async function finnhub(path, ttlMs) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= MAX_PER_MIN) {
    if (hit) return hit.value; // serve stale rather than fail
    throw Object.assign(new Error('News rate limit reached, try again in a minute'), { status: 429 });
  }
  calls.push(now);
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}token=${encodeURIComponent(key())}`, { signal: AbortSignal.timeout(8000) });
  if (r.status === 429) {
    if (hit) return hit.value;
    throw Object.assign(new Error('News rate limit reached, try again in a minute'), { status: 429 });
  }
  if (!r.ok) throw Object.assign(new Error(`News source error (${r.status})`), { status: 502 });
  const value = await r.json();
  cache.set(path, { at: Date.now(), value });
  return value;
}

// ---- catalyst tagging ----------------------------------------------------------------
// Transparent keyword rules, checked in priority order. Each tag says what kind of news it is
// and which way such news usually pushes the price. Headlines are noisy, so treat it as a hint.
const TAGS = [
  { key: 'bankruptcy', label: 'Bankruptcy / delisting', tone: -1, re: /\b(bankrupt\w*|chapter 11|delist\w*|going concern)\b/ },
  { key: 'offering', label: 'Share offering', tone: -1, re: /\b(public offering|registered direct|private placement|at-the-market|atm offering|priced .{0,40}offering|offering of .{0,30}shares|dilut\w*)\b/ },
  { key: 'reverse-split', label: 'Reverse split', tone: -1, re: /\breverse (stock )?split\b/ },
  { key: 'fda', label: 'FDA / clinical', tone: 0, re: /\b(fda|clinical (trial|data|hold)|phase (1|2|3|i{1,3})\b|topline|breakthrough therapy|approval)\b/ },
  { key: 'earnings', label: 'Earnings', tone: 0, re: /\b(earnings|eps|quarterly results|q[1-4] (results|revenue|sales)|fiscal (q[1-4]|quarter)|reports? (q[1-4]|quarter)|revenue (beat|miss))\b/ },
  { key: 'guidance', label: 'Guidance', tone: 0, re: /\b(guidance|outlook|forecast)\b/ },
  { key: 'mna', label: 'M&A', tone: 1, re: /\b(acqui(re|res|red|sition)|merger|to be acquired|buyout|takeover|tender offer|go(ing)? private)\b/ },
  { key: 'analyst', label: 'Analyst rating', tone: 0, re: /\b(upgrade[sd]?|downgrade[sd]?|price target|initiat(es|ed) coverage|outperform|underperform|overweight|underweight)\b/ },
  { key: 'contract', label: 'Contract / partnership', tone: 1, re: /\b(contract|partnership|agreement with|collaborat\w*|awarded|wins? .{0,20}deal)\b/ },
  { key: 'legal', label: 'Legal / regulatory', tone: -1, re: /\b(lawsuit|class action|sec (charges|probe|investigation)|investigation|subpoena|fraud|indict\w*)\b/ },
];
const BULL = /\b(soar\w*|surg\w*|jump\w*|rall(y|ies|ied)|beat[s]?|tops?|record|raise[sd]?|upgrade[sd]?|strong(er)?|gain[s]?|climb\w*|approv\w*|wins?|boost\w*|outperform)\b/g;
const BEAR = /\b(plung\w*|sink\w*|sank|fall[s]?|fell|drop\w*|tumbl\w*|miss(es|ed)?|cut[s]?|downgrade[sd]?|weak\w*|loss(es)?|slump\w*|lower|warn\w*|halt\w*|underperform|slash\w*|decline\w*)\b/g;

function classify(text) {
  const t = text.toLowerCase();
  const tags = TAGS.filter((x) => x.re.test(t)).map(({ key: k, label, tone }) => ({ key: k, label, tone }));
  const bull = (t.match(BULL) || []).length;
  const bear = (t.match(BEAR) || []).length;
  let tone = Math.sign(bull - bear);
  // Some news types are one-directional however they're worded.
  const forced = tags.find((x) => x.tone === -1);
  if (forced) tone = -1;
  else if (tone === 0 && tags.some((x) => x.tone === 1)) tone = 1;
  // Analyst tag direction from the wording.
  for (const tg of tags) if (tg.tone === 0) tg.tone = tone;
  return { tags, tone };
}

/** Words that identify the company in a headline: ticker + its name without legal suffixes. */
function identifiers(symbol, name) {
  const clean = String(name || '')
    .replace(/[,.]/g, ' ')
    .replace(/\b(the|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|sa|nv|ag|class [a-z]|common stock|ordinary shares)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = clean.split(' ').filter(Boolean);
  const phrase = words.slice(0, words[0]?.length <= 3 ? 2 : 1).join(' ').toLowerCase();
  return { tickerRe: new RegExp(`(^|[^A-Za-z])${symbol.replace('.', '\\.')}([^A-Za-z]|$)`), phrase };
}

const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? u : null);

/**
 * Recent news for a symbol, newest first, each tagged; plus a catalyst summary of the last 24 h.
 * Returns { available: false, reason } when there's no API key.
 */
// Same 7-day window for the per-stock panel and the live feed, so they share one cache entry.
function companyNewsPath(symbol) {
  const day = (d) => d.toISOString().slice(0, 10);
  return `/company-news?symbol=${encodeURIComponent(symbol)}&from=${day(new Date(Date.now() - 7 * 86400_000))}&to=${day(new Date())}`;
}

export async function getNews(symbol, name) {
  if (!newsEnabled()) return { available: false, reason: 'News is off: set FINNHUB_API_KEY on the server.' };
  if (!/^[A-Z.]{1,6}$/.test(symbol)) return { available: false, reason: 'News covers US-listed stocks only.' };
  const raw = await finnhub(companyNewsPath(symbol), 3 * 60_000);
  const { tickerRe, phrase } = identifiers(symbol, name);

  const seen = new Set();
  const items = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    const headline = String(a.headline || '').trim();
    if (!headline) continue;
    const dedupe = headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 80);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const summary = String(a.summary || '').trim();
    // "About this company" = named in the headline. A name in the summary only is usually a
    // market roundup that mentions it in passing (and its tags describe other companies).
    const inHeadline = tickerRe.test(headline) || (phrase.length >= 3 && headline.toLowerCase().includes(phrase));
    const relevant = inHeadline || tickerRe.test(summary) || (phrase.length >= 3 && summary.toLowerCase().includes(phrase));
    // Tag from the headline; the summary only adds tone. Roundup summaries list other
    // companies' earnings, offerings etc., which would mis-tag this one.
    const { tags } = classify(headline);
    const { tone } = classify(`${headline}. ${summary}`);
    items.push({
      id: a.id,
      time: a.datetime,
      headline,
      summary: summary.length > 280 ? `${summary.slice(0, 277)}…` : summary,
      source: a.source || '',
      url: safeUrl(a.url),
      relevant,
      inHeadline,
      tags,
      tone,
    });
  }
  items.sort((a, b) => b.time - a.time || Number(b.relevant) - Number(a.relevant));
  // Show articles about this company first; fill up with other mentions.
  const list = [...items.filter((i) => i.relevant), ...items.filter((i) => !i.relevant)].slice(0, 12);

  return { available: true, symbol, items: list, catalyst: summarise(items), updatedAt: Date.now() };
}

/** What, if anything, is driving the stock: the last 24 hours of relevant news. */
function summarise(items) {
  const now = Date.now() / 1000;
  const fresh = items.filter((i) => i.relevant && now - i.time < 86400);
  if (!fresh.length) {
    return { fresh: 0, tone: 0, label: 'No company news in the last 24 h', key: 'none', latest: null };
  }
  // Main catalyst: the most common tag in the last 24 h (ties -> higher-priority tag), so a
  // stray "earnings" mention in one opinion piece doesn't outrank the real story.
  const order = TAGS.map((t) => t.key);
  const counts = new Map();
  // Only headlines that name the company decide the catalyst.
  for (const i of fresh.filter((x) => x.inHeadline)) for (const t of i.tags) counts.set(t.key, { ...t, n: (counts.get(t.key)?.n || 0) + 1 });
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n || order.indexOf(a.key) - order.indexOf(b.key));
  // Negative structural news (offering, bankruptcy…) always wins: it changes the trade.
  const main = ranked.find((t) => TAGS.find((x) => x.key === t.key)?.tone === -1) || ranked[0];
  // Newer news counts more (halves every 6 h).
  const score = fresh.reduce((s, i) => s + i.tone * Math.pow(0.5, (now - i.time) / 21600), 0);
  const tone = score > 0.3 ? 1 : score < -0.3 ? -1 : 0;
  return {
    fresh: fresh.length,
    tone,
    score: Math.round(score * 100) / 100,
    key: main?.key || 'news',
    label: main ? main.label : `${fresh.length} news item${fresh.length === 1 ? '' : 's'}, no clear catalyst`,
    latest: { headline: fresh[0].headline, time: fresh[0].time, source: fresh[0].source, url: fresh[0].url },
  };
}

// ---- live market news feed ---------------------------------------------------------
// Finnhub's free "general" and "merger" feeds carry no stock symbols, so the feed is built
// from company news for a set of symbols (the user's watchlist + viewed stock, the current top
// gainers, and the biggest US companies), keeping only headlines that name the company.
//
// Budget: each request refreshes at most FEED_REFRESH_PER_CALL symbols (oldest data first),
// and only while fewer than FEED_BUDGET calls were made in the last minute, so the per-stock
// news panel always has headroom. Everything else is served from cache.
export const CORE_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'JPM', 'SPY'];
const FEED_TTL_MS = 2 * 60_000; // re-check a symbol's news at most every 2 min
const FEED_REFRESH_PER_CALL = 6;
const FEED_BUDGET = 30; // of the 45/min local cap

/**
 * @param entries  [{ symbol, name, reason }] reason = 'watch' | 'mover' | 'core'
 * @returns newest symbol-tagged headlines from the last 24 h, deduplicated across symbols
 */
export async function getNewsFeed(entries, { limit = 10 } = {}) {
  if (!newsEnabled()) return { available: false, reason: 'News is off: set FINNHUB_API_KEY on the server.' };

  // Refresh the stalest symbols within budget; serve the rest from cache.
  const withAge = entries.map((e) => {
    const hit = cache.get(companyNewsPath(e.symbol));
    return { ...e, at: hit?.at ?? 0 };
  });
  const stale = withAge.filter((e) => Date.now() - e.at > FEED_TTL_MS).sort((a, b) => a.at - b.at);
  const room = Math.max(0, Math.min(FEED_REFRESH_PER_CALL, FEED_BUDGET - callsLastMinute()));
  await Promise.all(
    stale.slice(0, room).map((e) => finnhub(companyNewsPath(e.symbol), FEED_TTL_MS).catch(() => null)),
  );

  const now = Date.now() / 1000;
  const merged = new Map(); // normalised headline -> item
  let checked = 0;
  for (const e of entries) {
    const hit = cache.get(companyNewsPath(e.symbol));
    if (!hit) continue;
    checked++;
    const { tickerRe, phrase } = identifiers(e.symbol, e.name);
    for (const a of Array.isArray(hit.value) ? hit.value : []) {
      const headline = String(a.headline || '').trim();
      if (!headline || now - a.datetime > 86400) continue;
      // Must name this company in the headline, so the symbol chip is accurate.
      const named = tickerRe.test(headline) || (phrase.length >= 3 && headline.toLowerCase().includes(phrase));
      if (!named) continue;
      const k = headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
      const cur = merged.get(k);
      if (cur) {
        if (!cur.symbols.includes(e.symbol)) cur.symbols.push(e.symbol);
        if (e.reason === 'mover') cur.mover = true;
        if (e.reason === 'watch') cur.watch = true;
        continue;
      }
      const { tags } = classify(headline);
      const { tone } = classify(`${headline}. ${a.summary || ''}`);
      merged.set(k, {
        id: a.id ?? k,
        time: a.datetime,
        headline,
        source: a.source || '',
        url: safeUrl(a.url),
        symbols: [e.symbol],
        tags,
        tone,
        mover: e.reason === 'mover',
        watch: e.reason === 'watch',
      });
    }
  }
  const items = [...merged.values()].sort((a, b) => b.time - a.time).slice(0, limit);
  return { available: true, items, symbolsChecked: checked, symbolsTotal: entries.length, updatedAt: Date.now() };
}

/** Compact catalyst for lists (top movers); never throws. */
export async function getCatalyst(symbol, name) {
  try {
    const n = await getNews(symbol, name);
    return n.available ? n.catalyst : null;
  } catch {
    return null;
  }
}
