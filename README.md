# Live Stock Chart

React + Node app for live price charts of any stock, ETF, index or crypto, with a buy/sell signal for each one.

- **Live chart.** Prices stream over a WebSocket: every 5 s on the 1D view, every 15 s on 5D, every 60 s on the longer ranges.
- **Ranges and views.** Opens on 1D with 1-minute candlesticks, including pre/post-market. Other ranges: 5D, 1M, 6M, 1Y, 5Y. Candlestick or line chart, with volume and an OHLC readout under the crosshair.
- **Chart overlays.** VWAP (solid blue), EMA 90 (dashed yellow) and EMA 150 (dotted pink) on the chart, each labelled on the price axis. A legend above the chart shows each value, whether price is above or below it, and a one-line trend read. Click a legend item to hide or show its line; the choice is remembered.
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
3. **Wait for the first build** (a few minutes). Your app is then live at `https://stock-live-<suffix>.onrender.com`.

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
| `GET /api/diagnostics` | Which upstream data sources this server can reach |
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

The rating is **High** when the hit rate is at least 60%, at least 5 points better than an average day, *and* the intraday signals confirm the direction. It is **Moderate** at 53% or above with no negative edge. Otherwise it is **Low**, and in the Hold zone it is **No edge**. The rating is capped at Moderate when there are fewer than 25 comparable days or earnings are due within 7 days. It drops to Low when the intraday or daily view points the other way. Analyst ratings have no history, so they aren't part of the back-test.

### Top movers

The movers list uses Yahoo's full equity screener, the same data as the Gainers page on finance.yahoo.com, sorted by % gain. It is limited to Nasdaq, NYSE, NYSE American, Cboe BZX and NYSE Arca, so OTC penny stocks are excluded. It then keeps stocks priced at least $1, with at least 500k shares traded, a market cap of at least $50M, and at least **1.5× their 3-month average volume**. Stocks under $300M market cap get a "Small cap" tag, since they move more and are riskier. The list refreshes every 30 seconds.

(Yahoo's predefined `day_gainers` list only includes companies of about $2B and up, so it misses the small caps that usually top the real gainers board.)

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
