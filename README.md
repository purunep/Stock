# Live Stock Chart

React + Node app for live price charts of any stock, ETF, index or crypto, with a buy/sell signal for each one.

- **Live chart.** Prices stream over a WebSocket: every 5 s on the 1D view, every 15 s on 5D, every 60 s on the longer ranges.
- **Ranges and views.** Opens on 1D with 1-minute candlesticks, including pre/post-market. Other ranges: 5D, 1M, 6M, 1Y, 5Y. Candlestick or line chart, with volume and an OHLC readout under the crosshair.
- **Chart overlays.** VWAP (solid blue), EMA 90 (dashed yellow) and EMA 150 (dotted pink) on the chart, each labelled on the price axis. A legend above the chart shows each value, whether price is above or below it, and a one-line trend read. Click a legend item to hide or show its line; the choice is remembered.
- **Trade levels on the chart.** The signal's entry, target and stop are drawn as labelled lines, with the reward zone shaded green and the risk zone shaded red.
- **Volume tools.** Volume bars at 2× or more the normal volume for that time of day are shown in full colour. A volume profile on the right edge shows how much traded at each price, with the busiest price (POC) marked. An OBV (on-balance volume) panel sits under the chart, with a read of whether it confirms or diverges from price.
- **Trend alignment.** A strip above the chart shows the trend on the 1-minute, 5-minute, daily and weekly timeframes, the S&P 500's direction, how the stock is doing against the market today, and which probability checks passed.
- **News and catalysts.** Company news for the last 7 days from Finnhub, under the chart. Each headline is tagged by type (earnings, share offering, FDA, M&A, analyst rating, legal…) and tone. A one-line "why it's moving" summary sits under the price, each top gainer shows its catalyst or "No news", and the probability rating checks the news. Needs a free Finnhub API key (see below).
- **Search.** Look up symbols by ticker or company name, for example `AAPL`, `tesla` or `BTC-USD`.
- **Buy / Sell signal.** Seven daily technical indicators, five intraday indicators at the live price, and the Wall Street analyst consensus, combined into one live score from −100 to +100.
- **Probability.** A back-test over two years of the stock's own history shows how often similar setups actually worked, rated High, Moderate or Low.
- **Top gainers on high volume.** The right-hand rail lists the 3 liquid US stocks with the biggest gain today that are trading well above their normal volume. Click one to open it.
- Light and dark themes. The chosen symbol is kept in the URL (`?symbol=NVDA`).

Data comes from Yahoo Finance's public endpoints, so no API key is needed. Some exchanges' quotes may be delayed.

## Run it

Requires Node 20 or later.

```bash
npm install
```

```bash
npm run install:all
```

```bash
npm run dev
```

**News (optional):** get a free API key at [finnhub.io](https://finnhub.io/register), copy `.env.example` to `.env` in the project root, and set `FINNHUB_API_KEY=` in it. `.env` is git-ignored, and the key is only used by the server, never sent to the browser. Without a key, everything else works and the news panel says news is off.

Then open http://localhost:5173. `npm run dev` starts both processes:

| Process | Port | What it does |
|---|---|---|
| `server/` (Express + ws) | 4000 (`API_PORT` env var; in production it uses `PORT`) | Fetches from Yahoo, caches, shares one poller per symbol between clients, runs the analysis |
| `client/` (Vite + React) | 5173 | UI. Proxies `/api` and `/ws` to the server |

## Deploy for free on Render

In production one Node service does everything: it serves the built React app, the API and the WebSocket from a single URL, so there are no CORS or cross-domain settings. [render.yaml](render.yaml) describes the service.

1. **Put the project on GitHub.** In this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
   Then create an empty repository on github.com and follow its "push an existing repository" instructions. The `.gitignore` already excludes `node_modules`, the build output and `.env` files.
2. **Create the service.** In the [Render dashboard](https://dashboard.render.com), choose **New → Blueprint**, connect your GitHub account, and pick the repository. Render reads `render.yaml`, shows a free web service called `stock-live`, and you click **Apply**.
3. **Add the news key (optional):** in the service's **Environment** tab, add `FINNHUB_API_KEY` with your key, and save. Render restarts the service with it. `render.yaml` declares the variable but never stores its value.
4. **Wait for the first build** (a few minutes). Your app is then live at `https://stock-live-<suffix>.onrender.com`.

To try the production setup locally first:

```bash
npm run build
```

```bash
NODE_ENV=production PORT=8080 npm start
```

Then open http://localhost:8080.

**Free-tier behaviour on Render:**
- The service **sleeps after 15 minutes with no traffic** and takes about a minute to wake on the next visit. Open WebSocket connections count as traffic, so while someone has the page open it stays awake.
- Free instances have **750 hours a month**, which covers one always-on service for the whole month.
- Restarts happen occasionally. The browser reconnects by itself, and the app keeps no data on disk, so nothing is lost.

**Built-in protections for a public site:** `/api` is limited to 120 requests per minute per IP address (HTTP 429 after that), and the server accepts at most 200 simultaneous live connections. Both limits are constants at the top of `server/src/index.js`.

**Before sharing the link widely, know that** the data comes from Yahoo Finance's unofficial public endpoints. They are fine for personal use, but cloud servers can be rate-limited or blocked by Yahoo, and Yahoo's terms don't allow redistributing its data. For a real public product, replace `server/src/yahoo.js` with a licensed data provider.

## API

| Endpoint | Description |
|---|---|
| `GET /api/search?q=tesla` | Symbol search |
| `GET /api/chart/:symbol?range=1d` | Quote + OHLCV bars. Ranges: `1d 5d 1mo 6mo 1y 5y` |
| `GET /api/analysis/:symbol` | Buy/sell recommendation with per-signal breakdown, intraday signals and probability |
| `GET /api/movers` | Top 3 US gainers on high relative volume |
| `GET /api/news/:symbol` | Last 7 days of company news, tagged, with a 24-hour catalyst summary |
| `GET /api/news-feed?symbols=AAPL,TSLA` | Newest symbol-tagged headlines across those symbols, the top gainers and big caps |
| `GET /api/diagnostics` | Which upstream data sources this server can reach, and whether news is enabled |
| `WS /ws` | Send `{"type":"subscribe","symbol":"AAPL","range":"1d"}` to get a `snapshot`, then a `tick` on each poll |

## How the recommendation works

`server/src/analysis.js` scores each signal from −1 (bearish) to +1 (bullish). The weighted average × 100 is the overall score.

| Group | Signal | Weight | Logic |
|---|---|---|---|
| Technical | Price trend | 2 | Distance of price above or below the 50- and 200-day SMAs |
| Technical | 50/200-day cross | 1 | Golden or death cross in the last 30 days, else which SMA is on top |
| Technical | RSI (14) | 1.5 | >70 overbought (bearish), <30 oversold (bullish), else momentum |
| Technical | MACD (12,26,9) | 1.5 | Histogram size and direction, recent crossovers |
| Technical | Bollinger %B | 0.75 | Above the upper band = extended, below the lower band = oversold |
| Technical | Momentum | 1.25 | 1-month and 3-month rate of change |
| Technical | Volume | 0.5 | Whether 5-day volume against the 20-day average confirms the move |
| Analysts | Consensus | 2.5 | Yahoo's mean rating (1 strong buy … 5 strong sell) |
| Analysts | Price target | 2 | Upside or downside to the mean 12-month target |

### Pre-market and after-hours

US stocks trade in three sessions: **pre-market 4:00–9:30 AM**, **regular 9:30 AM–4:00 PM** and **after hours 4:00–8:00 PM** (Eastern Time). The app runs in all three:

- **Live price:** the 1D chart keeps streaming every 5 seconds outside regular hours, and the header shows the extended-hours price with its change. After hours it's compared with the 4:00 PM close; pre-market with the previous close.
- **Signal at the extended-hours price:** outside regular hours the intraday signals (VWAP, opening range, short-term trend) and the entry/target/stop levels use the current pre-market or after-hours price, not the 4:00 PM close. The badge says "After-hours signal at …" or "Pre-market signal at …". An extra **Pre-market / After-hours move** signal weighs the size of the move by its volume: a big move on heavy volume counts; a move on thin volume barely counts, because it often reverses at the open.
- **Volume:** Yahoo's free feed has extended-hours *prices* but reports their volume as 0, so on 1D those volume bars are empty, and VWAP, the volume profile, spikes and OBV cover the regular session only. The session's total extended-hours volume comes from Nasdaq.com instead (US stocks and ETFs only) and is shown under the chart and in the signal.
- **Shading:** on 1D, pre-market and after-hours bars have a light grey background, so the regular session stands out.
- The daily technical indicators and back-test always use official closing prices, because daily bars run from close to close.

Crypto (for example `BTC-USD`) trades around the clock, so it is always treated as the regular session.

### Chart overlays

`client/src/overlays.js` computes the lines on the bars of whichever range is shown:

- **VWAP** = Σ(typical price × volume) / Σ volume, where typical price = (high + low + close) / 3. It resets each trading day, and on 1D it starts at the 9:30 open, not in pre-market. VWAP is a per-session indicator, so it is shown only on 1D, 5D and 1M.
- **EMA 90 / EMA 150** are exponential moving averages of closes at the chart's bar size: 90 one-minute bars on 1D, 90 days on 1Y. The server sends up to 450 earlier bars with each snapshot (`warmup`), so the EMAs are already accurate on the first visible bar instead of starting from zero.

The trend read above the chart uses the usual interpretation:

| Read | Condition |
|---|---|
| **Bullish stack** | Price above every line, and EMA 90 above EMA 150 |
| **Bearish stack** | Price below every line, and EMA 90 below EMA 150 |
| **Pullback** | Price below every line, but EMA 90 still above EMA 150 (dip in an uptrend) |
| **Bounce** | Price above every line, but EMA 90 still below EMA 150 (rally in a downtrend) |
| **Mixed** | Price between the lines |

The colours were checked for colour-blind separation and against the green/red candles. Each line also has its own dash style and axis label, so they can be told apart without colour.

### News and catalysts

`server/src/news.js` fetches the last 7 days of company news from Finnhub, cached per stock for 3 minutes. A local limiter keeps it under 45 calls a minute, below the free plan's 60. Each article is:

- **Matched to the company:** it counts as being about the stock only if the ticker or company name is in the headline. Articles that just mention it in the summary are listed after the rest, marked "mentions this stock".
- **Tagged from its headline** by keyword rules: Bankruptcy / delisting, Share offering, Reverse split, FDA / clinical, Earnings, Guidance, M&A, Analyst rating, Contract / partnership, Legal / regulatory.
- **Given a tone** (positive, negative, neutral) from bullish and bearish words such as "soars", "beat", "plunges" or "miss". Offerings, reverse splits, bankruptcy and legal news always count as negative.

The **catalyst** is the most common tag among the last 24 hours' headlines that name the company; a negative structural tag (offering, reverse split, bankruptcy) always wins. Its tone gives newer items more weight, halving every 6 hours. The panel adds a line of guidance for each catalyst type, for example "The company is selling new shares. That adds supply and often pulls the price back down."

**Effect on the probability rating.** News can only lower the rating, never raise it, because headline wording is too noisy to trust a setup more:
- a share offering, reverse split or bankruptcy against a Buy: at most **Low**
- news whose tone points against the call: at most **Moderate**
- a move of 8% or more today, or in extended hours, with no company news: at most **Moderate**, since unexplained moves reverse more often

The tags and tone come from keyword rules, so they can be wrong. Read the article before acting on it.

**Latest stock news (right rail, under the top gainers).** The 3 newest headlines from the last 24 hours that name a stock, each with a clickable symbol chip. Finnhub's free market-wide feeds don't say which stock a story is about, so the feed (`/api/news-feed`) is built from company news for:
- the stock you're viewing and the watchlist
- the current top gainers (marked "Top gainer")
- the biggest US companies (AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, AVGO, AMD, NFLX, JPM, SPY)

Only headlines that name the company are kept, so the symbol chip is accurate, and the same story under several symbols is merged into one item. The page checks every 45 seconds and marks headlines that arrived since the last check as **New** for a minute. To stay inside Finnhub's free 60 calls a minute, each check re-fetches at most 6 symbols, oldest first, and only while the server has made fewer than 30 calls in the last minute. Each symbol's news is re-checked at most every 2 minutes, so a brand-new story can take up to about 2–3 minutes to appear.

### Trade levels, volume tools and trend alignment

Each of these can be switched on or off from the second legend row above the chart, and the choice is remembered.

- **Trade levels** (`client/src/primitives.js`, `TradeZones`): the entry, target and stop from the Buy/Sell signal's plan, drawn as price lines with axis labels. The reward zone (entry to target) is shaded green and the risk zone (entry to stop) red, across the right 35% of the chart. The chart stretches its scale to include levels near the price, but not levels far away, so the candles don't get squashed.
- **Volume spikes** (`overlays.js`, `volumeSpikes`): a bar counts as a spike when its volume is at least 2× normal. On intraday ranges, "normal" is the median volume for the same 15 minutes of the day over the previous 3 sessions, so the naturally busy open and close aren't all flagged. On daily ranges, it's the median of the previous 20 bars.
- **Volume profile** (`primitives.js`, `buildProfile` / `VolumeProfile`): today's regular-session volume (or all visible bars on longer ranges) split into 32 price rows. Each bar's volume is spread evenly across the rows its high-low range covers. The darkest row is the **POC** (point of control, the price with the most volume). The middle shade is the **value area**, the rows holding 70% of the volume around the POC. Prices tend to react at the POC and at the value-area edges.
- **OBV** (on-balance volume, `obvLine`): adds a bar's volume when it closes higher than the previous bar and subtracts it when it closes lower. Shown in its own panel under the chart. The legend compares OBV's direction with the price's over the last 20% of bars: if both move the same way, the move is confirmed; if OBV moves the other way, that's a divergence, an early sign the move is weakening.
- **Trend alignment** (`server/src/alignment.js`): one rule on four timeframes, 1-minute (today), 5-minute (5 days), daily (2 years) and weekly (5 years). A timeframe is **up** when price > EMA 20 > EMA 50, **down** when price < EMA 20 < EMA 50, and **flat** otherwise. The **market** check applies the same rule to SPY (S&P 500) on 5-minute and daily bars: up when neither is down, down when both are, or when SPY trends down intraday, is below VWAP and is off more than 0.5% on the day. **vs market** is the stock's % change today minus SPY's.

These feed into the probability rating. **High** now also needs at least 3 of 4 timeframes trending the call's way, and the S&P 500 not trending against it. If 3 or more timeframes point the other way, the rating drops to **Low**. The **Checks** list shows which conditions passed (✓), failed (✗) or were neutral (–). Hover over it for the full reasoning.

### Intraday signals (at the live price)

`server/src/intraday.js` uses today's regular-session 1-minute bars:

| Signal | Weight | Logic |
|---|---|---|
| VWAP | 2 | Above VWAP = buyers in control. More than 2σ away = stretched, so the score is reduced |
| Relative volume | 1.5 | Today's volume so far vs the average of past sessions at the same minute of the day |
| Opening range | 1.5 | Breakout above or below the first 15 minutes' high/low |
| Short-term trend | 1 | EMA 9 vs EMA 21 on 1-minute closes |
| Intraday RSI (5m) | 0.75 | Overbought above 75, oversold below 25 |

The **live score** is 65% daily score (technical + analysts) and 35% intraday score. The verdict badge, price levels and probability all use it. Outside market hours only the daily score is used.

### Probability

`server/src/backtest.js` replays two years of daily bars. For each past day it recomputes the technical score using only data available that day, then records what happened next. For past days whose score was close to today's, it reports:

- how often price was higher (or lower, for a sell) **5 days later**, compared with an average day;
- how often price moved **1.5 ATR in the signal's direction before 1.5 ATR against it**, within 10 days.

The rating is **High** when the hit rate is at least 60%, at least 5 points better than an average day, the intraday signals confirm the direction, at least 3 of 4 timeframes agree, and the S&P 500 isn't trending against the call. It is **Moderate** at 53% or above with no negative edge. Otherwise it is **Low**, and in the Hold zone it is **No edge**. The rating is capped at Moderate when there are fewer than 25 comparable days or earnings are due within 7 days. It drops to Low when the intraday or daily view points the other way. Analyst ratings have no history, so they aren't part of the back-test.

### Top movers

The movers list uses Yahoo's full equity screener, the same data as the Gainers page on finance.yahoo.com, sorted by % gain. It is limited to Nasdaq, NYSE, NYSE American, Cboe BZX and NYSE Arca, so OTC penny stocks are excluded. It then keeps stocks priced at least $1, with at least 500k shares traded, a market cap of at least $50M, and at least **1.5× their 3-month average volume**. Stocks under $300M market cap get a "Small cap" tag, since they move more and are riskier. The list refreshes every 30 seconds.

(Yahoo's predefined `day_gainers` list only includes companies of about $2B and up, so it misses the small caps that usually top the real gainers board.)

**Pre-market and after-hours gainers.** The panel follows the US market clock: from 4:00 to 9:30 AM ET it shows **Pre-market gainers**, from 9:30 AM to 4:00 PM the regular-session list above, and from 4:00 to 8:00 PM **After-hours gainers**. Overnight and at weekends it shows the last after-hours session, marked as closed. Neither Yahoo nor Nasdaq has a free extended-hours gainers list, so the server builds one:
1. It scans every plain US stock symbol in Nasdaq's directory (about 5,600 with any recent trading).
2. Yahoo's batch price endpoint (20 symbols per call, no session needed) gives each one's latest extended-hours trade, today's close and today's volume.
3. Change is measured the way TradingView does: after hours vs today's 4:00 PM close; pre-market vs the previous close. Only stocks whose last trade falls inside the current session count.
4. The top 40 by % gain are checked on Nasdaq for real volume in this session. A stock is kept if it's on a main exchange, priced at least $1, and has traded at least **50k shares and $1M** in this extended session. Liquidity is judged on the extended session itself, not the regular day, because news-driven movers often trade little during the day and then take off after the bell. For example, TANH traded 183k shares all day, then $15M in its first hour after hours. Market cap is estimated live (shares outstanding × current price).

**Kept live by a background scanner.** While someone has the panel open, the server re-scans every stock every **20 seconds**, to catch new movers anywhere in the market, and re-prices the current top 40 every **2 seconds**, to keep the leaders' prices and order current. The page polls every 2 seconds in extended hours (every 30 seconds in the regular session) and just reads the latest result, so responses are instant. The scanner stops itself after a minute with nobody watching, and the page pauses polling while its tab is hidden. Yahoo's batch price responses are cacheable for up to 5 minutes, so each request carries a cache-buster; without it, a leader's price could be minutes old.

To check a session outside its hours, add `?session=post` or `?session=regular` to `/api/movers`.

**Fallback when Yahoo's session is blocked.** Yahoo's full screener and analyst data need a session cookie and "crumb" token. Yahoo often refuses to give these to cloud servers, including Render's. When that happens, the movers list is built without a session instead:
1. Candidates are taken from Nasdaq.com's "most advanced" list plus Yahoo's predefined `day_gainers` and `small_cap_gainers` lists.
2. The top 40 are each checked through Yahoo's chart endpoint (no session needed) for exchange, today's volume and 3-month average volume.
3. Market cap comes from Nasdaq's quote summary.

The same rules apply. The API response's `source` field says which path was used (`yahoo-screener` or `nasdaq+yahoo-chart`). Symbol search likewise falls back to Nasdaq's lookup when Yahoo search returns nothing.

On a host where the session is blocked, **analyst ratings and earnings dates are unavailable**: the signal falls back to technical and intraday data only, and the panel shows "No coverage".

**Diagnostics:** open `/api/diagnostics` on your deployed site to see which data sources the server can reach.

**Price levels.** The badge next to the symbol shows an entry, target and stop for the current price. These are sized by ATR(14), the average daily range: the stop is 1.5 ATR away, and the target is the nearest analyst target or 20-day high/low at least 1.5 ATR away, otherwise 3 ATR. The analysis refreshes every minute, so the levels follow the live price.

Verdict bands: **Strong Buy** ≥ 45, **Buy** ≥ 15, **Hold** −15 to 15, **Sell** ≤ −15, **Strong Sell** ≤ −45. Confidence is the share of signal weight that agrees with the verdict's direction. ETFs and crypto have no analyst coverage, so their score is technical only.

> This is a transparent rule-based heuristic for information only. It is **not financial advice**.
