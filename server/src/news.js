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
  // Whole-word match on the name, allowing a possessive ("Intel's"), so "Intel" doesn't
  // match "Intelligence" and "Meta" doesn't match "Metals".
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phraseRe = phrase.length >= 3 ? new RegExp(`(^|[^a-z0-9])${esc(phrase)}(['’]s)?([^a-z0-9]|$)`, 'i') : null;
  return {
    tickerRe: new RegExp(`(^|[^A-Za-z])${symbol.replace('.', '\\.')}([^A-Za-z]|$)`),
    phrase,
    // headline/summary "names this company"
    names: (text) => {
      const t = String(text || '');
      return new RegExp(`(^|[^A-Za-z])${symbol.replace('.', '\\.')}([^A-Za-z]|$)`).test(t) || (phraseRe ? phraseRe.test(t) : false);
    },
  };
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
  const { names } = identifiers(symbol, name);

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
    const inHeadline = names(headline);
    const relevant = inHeadline || names(summary);
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

// ---- Yahoo news (no key, minutes fresher than Finnhub's company-news) ------------------
// Two Yahoo sources, both free:
//   - RSS headline feed: one call covers many symbols (newest first), but items don't say
//     which symbol they belong to -> matched to a symbol by name in the headline.
//   - search endpoint: per symbol, each item lists its related tickers.
// Both are CDN-cacheable for ~10 min, so every request carries a cache-buster.
const YH = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&amp;nbsp;/g, ' ')
    .trim();

async function yahooRss(symbols) {
  const out = [];
  // The RSS endpoint takes a comma list; keep batches modest so each stays complete.
  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);
    try {
      const r = await fetch(
        `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${batch.map(encodeURIComponent).join(',')}&region=US&lang=en-US&_=${Date.now()}`,
        { headers: { ...YH, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) },
      );
      if (!r.ok) continue;
      const xml = await r.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const f = (tag) => decode((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1]);
        const time = Math.floor(Date.parse(f('pubDate')) / 1000);
        if (!f('title') || !time) continue;
        out.push({ id: f('guid') || f('link'), headline: f('title'), summary: f('description'), url: f('link'), time, source: 'Yahoo Finance', related: null });
      }
    } catch {
      /* next batch */
    }
  }
  return out;
}

async function yahooSearchNews(symbol) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=10&_=${Date.now()}`,
      { headers: { ...YH, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return [];
    return ((await r.json())?.news || []).map((x) => ({
      id: x.uuid,
      headline: decode(x.title),
      summary: '',
      url: x.link,
      time: x.providerPublishTime,
      source: x.publisher || 'Yahoo Finance',
      related: (x.relatedTickers || []).map((t) => String(t).toUpperCase()),
    }));
  } catch {
    return [];
  }
}

// ---- live feed poller ---------------------------------------------------------------
// While anyone is looking, a background loop keeps a merged pool of articles fresh:
//   every POLL_MS:          Yahoo RSS for all tracked symbols (1-2 calls)
//   every POLL_MS, rotating: Yahoo search for the next 2 symbols
//   when the budget allows: Finnhub company-news for the stalest symbols (2-min TTL)
// Requests just read the pool, so polling the endpoint every few seconds costs nothing.
const POLL_MS = 5_000;
const IDLE_MS = 60_000;
const feed = { entries: [], pool: new Map(), timer: null, lastAsked: 0, rot: 0, busy: false, lastPoll: 0 };

const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);

/** Add articles to the pool, tagging each with the tracked symbols it is about. */
function ingest(articles, entries, sourceSymbol = null) {
  const now = Date.now() / 1000;
  const ids = entries.map((e) => ({ e, ...identifiers(e.symbol, e.name) }));
  for (const a of articles) {
    const headline = String(a.headline || '').trim();
    if (!headline || !a.time || now - a.time > 86400 || a.time > now + 300) continue;
    // Symbols this headline is about: named in the headline. (Yahoo's relatedTickers are too
    // broad - a China tech-fair release lists NVDA, TSLA, AMZN… - so they only help when the
    // headline also names the company.)
    const syms = ids
      .filter(({ names }) => names(headline))
      .map(({ e }) => e.symbol);
    if (!syms.length) continue;
    const k = norm(headline);
    const cur = feed.pool.get(k);
    if (cur) {
      for (const s of syms) if (!cur.symbols.includes(s)) cur.symbols.push(s);
      cur.time = Math.min(cur.time, a.time); // earliest report time
      continue;
    }
    const { tags } = classify(headline);
    const { tone } = classify(`${headline}. ${a.summary || ''}`);
    feed.pool.set(k, {
      id: String(a.id || k),
      time: a.time,
      firstSeen: Date.now(),
      headline,
      source: a.source || '',
      url: safeUrl(a.url),
      symbols: syms,
      tags,
      tone,
    });
  }
  // Drop anything older than 24 h.
  for (const [k, v] of feed.pool) if (now - v.time > 86400) feed.pool.delete(k);
}

async function pollOnce() {
  if (feed.busy || !feed.entries.length) return;
  feed.busy = true;
  try {
    const entries = feed.entries;
    const symbols = entries.map((e) => e.symbol);
    // 1) Yahoo RSS, all symbols.
    const rss = yahooRss(symbols);
    // 2) Yahoo search, rotating 2 symbols per tick (movers first).
    const pick = [];
    for (let i = 0; i < 2 && i < entries.length; i++) pick.push(entries[(feed.rot + i) % entries.length]);
    feed.rot = (feed.rot + 2) % Math.max(1, entries.length);
    const search = Promise.all(pick.map((e) => yahooSearchNews(e.symbol)));
    // 3) Finnhub, stalest symbols within budget.
    let fin = Promise.resolve([]);
    if (newsEnabled()) {
      const stale = entries
        .map((e) => ({ e, at: cache.get(companyNewsPath(e.symbol))?.at ?? 0 }))
        .filter((x) => Date.now() - x.at > FEED_TTL_MS)
        .sort((a, b) => a.at - b.at);
      const room = Math.max(0, Math.min(2, FEED_BUDGET - callsLastMinute()));
      fin = Promise.all(stale.slice(0, room).map(({ e }) => finnhub(companyNewsPath(e.symbol), FEED_TTL_MS).catch(() => null)));
    }
    const [rssItems, searchItems] = await Promise.all([rss, search, fin]);
    ingest(rssItems, entries);
    ingest(searchItems.flat(), entries);
    // Finnhub items from cache (cheap; covers symbols the Yahoo calls missed).
    for (const e of entries) {
      const hit = cache.get(companyNewsPath(e.symbol));
      if (!hit || !Array.isArray(hit.value)) continue;
      ingest(
        hit.value.map((a) => ({ id: a.id, headline: a.headline, summary: a.summary, url: a.url, time: a.datetime, source: a.source })),
        [e],
      );
    }
    feed.lastPoll = Date.now();
  } finally {
    feed.busy = false;
  }
}

function startPoller() {
  if (feed.timer) return;
  feed.timer = setInterval(() => {
    if (Date.now() - feed.lastAsked > IDLE_MS) {
      clearInterval(feed.timer);
      feed.timer = null;
      return;
    }
    pollOnce().catch(() => {});
  }, POLL_MS);
  feed.timer.unref?.();
}

/**
 * @param entries  [{ symbol, name, reason }] reason = 'watch' | 'mover' | 'core'
 * @returns newest symbol-tagged headlines from the last 24 h, deduplicated across symbols
 */
export async function getNewsFeed(entries, { limit = 10 } = {}) {
  feed.lastAsked = Date.now();
  // Track the union of what's being asked for (latest request first), capped.
  const merged = [...entries, ...feed.entries.filter((e) => !entries.some((x) => x.symbol === e.symbol))].slice(0, 30);
  feed.entries = merged;
  startPoller();
  if (!feed.lastPoll) await pollOnce(); // first request waits for one round

  const reason = new Map(entries.map((e) => [e.symbol, e.reason]));
  const items = [...feed.pool.values()]
    .filter((it) => it.symbols.some((s) => reason.has(s)))
    .sort((a, b) => b.time - a.time)
    .slice(0, limit)
    .map((it) => ({
      ...it,
      symbols: [...it.symbols].sort((a, b) => Number(reason.has(b)) - Number(reason.has(a))),
      mover: it.symbols.some((s) => reason.get(s) === 'mover'),
      watch: it.symbols.some((s) => reason.get(s) === 'watch'),
    }));
  return {
    available: true,
    items,
    symbolsChecked: entries.length,
    symbolsTotal: entries.length,
    sources: newsEnabled() ? ['Yahoo Finance', 'Finnhub'] : ['Yahoo Finance'],
    lastPoll: feed.lastPoll,
    updatedAt: Date.now(),
  };
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
