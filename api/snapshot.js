// /api/snapshot.js
// =============================================================================
//  BTC Live Snapshot v3 · Vercel Edge Function
// =============================================================================
//  Penambahan vs v2:
//   • Multi-timeframe klines (1h/4h/1d) untuk confluence higher-TF
//   • Open Interest history (24 candle 1h)
//   • Long/Short ratio (top trader + global retail) → smart money divergence
//   • Taker buy/sell volume (aggressor pressure)
//   • Pre-computed TA indicators: RSI, MACD, Bollinger, EMA, trend
//
//  Total endpoint fetch: 16 (semua paralel via Promise.allSettled)
//  Target latency: < 3 detik di Vercel Edge
// =============================================================================

export const config = { runtime: 'edge' };

// ─────────────────────────────────────────────────────────────────────────────
//  Fetch helpers (with timeout)
// ─────────────────────────────────────────────────────────────────────────────
const TIMEOUT_DEFAULT = 5000;
const TIMEOUT_SLOW    = 9000;   // ← untuk CoinGecko & sumber yang sering lambat

// ── Retry sekali untuk sumber yang sering transient-fail ─────────────────────
async function fetchJSONRetry(url, timeout = TIMEOUT_SLOW) {
  try {
    return await fetchJSON(url, timeout);
  } catch (e) {
    // Tunggu sebentar lalu coba sekali lagi
    await new Promise(r => setTimeout(r, 800));
    return fetchJSON(url, timeout);
  }
}

async function fetchJSON(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'accept': 'application/json', 'user-agent': 'btc-bandarmologi/3.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.json();
  } finally {
    clearTimeout(tid);
  }
}

async function fetchText(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.text();
  } finally {
    clearTimeout(tid);
  }
}

// =============================================================================
//  TA INDICATOR COMPUTATIONS (pure functions)
// =============================================================================

/** Exponential Moving Average — array result */
function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** EMA last value only */
function ema(values, period) {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Relative Strength Index (Wilder's smoothing) */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  // Initial averages from first `period` diffs
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  // Wilder smoothing for remaining
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

/** MACD(12,26,9) → { macd, signal, histogram, bullish } */
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const sigSeries = emaSeries(macdLine.slice(slow - 1), signalPeriod);
  const macdNow = macdLine[macdLine.length - 1];
  const sigNow = sigSeries[sigSeries.length - 1];
  const hist = macdNow - sigNow;
  // Previous hist untuk lihat momentum direction
  const prevSig = sigSeries[sigSeries.length - 2];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevHist = prevMacd - prevSig;
  return {
    macd: macdNow,
    signal: sigNow,
    histogram: hist,
    bullish: hist > 0,
    momentum: hist > prevHist ? 'RISING' : 'FALLING',
  };
}

/** Bollinger Bands(20, 2σ) */
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + mult * sd;
  const lower = mean - mult * sd;
  const current = closes[closes.length - 1];
  return {
    upper, middle: mean, lower,
    widthPct: ((upper - lower) / mean) * 100,  // squeeze: < 4% = sangat sempit
    position: (current - lower) / (upper - lower),  // 0 = at lower, 1 = at upper
  };
}

/** Trend classification dari EMA21/55/200 alignment */
function trendFromEMA(price, ema21, ema55, ema200) {
  if (ema21 == null || ema55 == null) return 'NEUTRAL';
  const bullStack = ema21 > ema55 && (ema200 == null || ema55 > ema200);
  const bearStack = ema21 < ema55 && (ema200 == null || ema55 < ema200);
  if (bullStack && price > ema21) return 'BULLISH';
  if (bearStack && price < ema21) return 'BEARISH';
  return 'NEUTRAL';
}

/** Compute semua indicator untuk satu timeframe */
function computeIndicators(closes) {
  if (!closes || closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const ema21v = ema(closes, 21);
  const ema55v = ema(closes, 55);
  const ema200v = closes.length >= 200 ? ema(closes, 200) : null;
  return {
    rsi: rsi(closes, 14),
    macd: macd(closes),
    bb: bollinger(closes),
    ema21: ema21v,
    ema55: ema55v,
    ema200: ema200v,
    trend: trendFromEMA(last, ema21v, ema55v, ema200v),
  };
}

// =============================================================================
//  DATA SOURCES
// =============================================================================

async function sourceTicker() {
  const d = await fetchJSON('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
  return {
    price: +d.lastPrice,
    change24h: +d.priceChangePercent,
    volume24h: +d.quoteVolume,
    high24h: +d.highPrice,
    low24h: +d.lowPrice,
  };
}

async function sourceOrderBook() {
  const d = await fetchJSON('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=500');
  const toWall = arr => arr
    .map(r => ({ price: +r[0], qty: +r[1], total: +r[0] * +r[1] }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const bids = toWall(d.bids);
  const asks = toWall(d.asks);
  const bidWall = bids.reduce((s, b) => s + b.total, 0);
  const askWall = asks.reduce((s, a) => s + a.total, 0);
  return { bids, asks, bidWall, askWall, ratio: bidWall / (bidWall + askWall) };
}

async function sourceFunding() {
  const d = await fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
  return {
    fundingRate: +d.lastFundingRate * 100,
    markPrice: +d.markPrice,
    nextFundingTime: d.nextFundingTime,
  };
}

async function sourceKlinesMulti() {
  // Fetch 3 timeframe paralel
  const [r1h, r4h, r1d] = await Promise.all([
    fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200'),
    fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=100'),
    fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=100'),
  ]);
  // Binance kline format: [openTime, open, high, low, close, volume, ...]
  const closes = r => r.map(k => +k[4]);
  const volumes = r => r.map(k => +k[5]);
  return {
    h1: { closes: closes(r1h), volumes: volumes(r1h) },
    h4: { closes: closes(r4h), volumes: volumes(r4h) },
    d1: { closes: closes(r1d), volumes: volumes(r1d) },
  };
}

// ──────────────────────────────────────────────────────────────
//  NEW v3: Derivatives intelligence (Binance Futures public API)
// ──────────────────────────────────────────────────────────────

async function sourceOpenInterestHist() {
  const d = await fetchJSON(
    'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=24'
  );
  if (!d || !d.length) return null;
  // d[i] = { timestamp, sumOpenInterest, sumOpenInterestValue }
  const oiValues = d.map(x => +x.sumOpenInterestValue); // dalam USD
  const oiNow = oiValues[oiValues.length - 1];
  const oi24hAgo = oiValues[0];
  const changePct = ((oiNow - oi24hAgo) / oi24hAgo) * 100;
  return {
    current: oiNow,
    change24h: changePct,
    history: oiValues,                          // untuk visual nanti
    timestamps: d.map(x => +x.timestamp),
  };
}

async function sourceLongShortRatios() {
  // Dua endpoint paralel: top trader vs global retail
  const [top, global] = await Promise.all([
    fetchJSON('https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=24'),
    fetchJSON('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=24'),
  ]);
  if (!top?.length || !global?.length) return null;
  const lastTop    = +top[top.length - 1].longShortRatio;
  const lastGlobal = +global[global.length - 1].longShortRatio;
  const prevTop    = +top[0].longShortRatio;
  const prevGlobal = +global[0].longShortRatio;
  // Divergence: top trader vs retail
  const divergence = lastTop - lastGlobal;
  let smartMoneyBias = 'NEUTRAL';
  if (lastTop > 1.5 && lastGlobal < 1.5) smartMoneyBias = 'LONG';
  else if (lastTop < 0.7 && lastGlobal > 1.0) smartMoneyBias = 'SHORT';
  else if (divergence > 0.5) smartMoneyBias = 'SMART_LONG_RETAIL_SHORT';
  else if (divergence < -0.5) smartMoneyBias = 'SMART_SHORT_RETAIL_LONG';

  return {
    topTrader: { current: lastTop, prev24h: prevTop, trend: lastTop > prevTop ? 'RISING' : 'FALLING' },
    global:    { current: lastGlobal, prev24h: prevGlobal, trend: lastGlobal > prevGlobal ? 'RISING' : 'FALLING' },
    divergence,
    smartMoneyBias,
    topHistory:    top.map(x => +x.longShortRatio),
    globalHistory: global.map(x => +x.longShortRatio),
  };
}

async function sourceTakerVolume() {
  const d = await fetchJSON(
    'https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1h&limit=24'
  );
  if (!d || !d.length) return null;
  // d[i] = { buySellRatio, buyVol, sellVol, timestamp }
  const ratios = d.map(x => +x.buySellRatio);
  const ratioNow = ratios[ratios.length - 1];
  const avg24h = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // Trend: rata-rata 6 jam terakhir vs 18 jam sebelumnya
  const recent6 = ratios.slice(-6).reduce((a, b) => a + b, 0) / 6;
  const earlier18 = ratios.slice(0, -6).reduce((a, b) => a + b, 0) / Math.max(ratios.length - 6, 1);
  let trend = 'NEUTRAL';
  if (recent6 > earlier18 * 1.05 && recent6 > 1) trend = 'RISING_BUY';
  else if (recent6 < earlier18 * 0.95 && recent6 < 1) trend = 'RISING_SELL';
  return {
    current: ratioNow,
    avg24h,
    trend,
    history: ratios,
  };
}

async function sourceFearGreed() {
  const d = await fetchJSON('https://api.alternative.me/fng/?limit=30');
  return {
    value: +d.data[0].value,
    label: d.data[0].value_classification,
    history: d.data.slice().reverse().map(x => ({ ts: +x.timestamp * 1000, v: +x.value })),
  };
}

async function sourceCoinGecko() {
  const d = await fetchJSONRetry(
    'https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false'
  );
  const m = d.market_data;
  return {
    change7d: m.price_change_percentage_7d,
    change30d: m.price_change_percentage_30d,
    marketCap: m.market_cap.usd,
    ath: m.ath.usd,
    athDistance: m.ath_change_percentage.usd,
  };
}

async function sourceGlobal() {
  const d = await fetchJSONRetry('https://api.coingecko.com/api/v3/global');
  return {
    btcDominance: d.data.market_cap_percentage.btc,
    totalMcap: d.data.total_market_cap.usd,
  };
}

async function sourceMempool() {
  return fetchJSON('https://mempool.space/api/v1/fees/recommended');
}

async function sourceNetwork() {
  const [hashrate, difficulty, height] = await Promise.all([
    fetchText('https://blockchain.info/q/hashrate'),
    fetchText('https://blockchain.info/q/getdifficulty'),
    fetchText('https://blockchain.info/q/getblockcount'),
  ]);
  return { hashrate: +hashrate, difficulty: +difficulty, blockHeight: +height };
}

async function sourceNews() {
  const d = await fetchJSONRetry(
    'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC&sortOrder=popular&limit=8'
  );
  return (d.Data || []).slice(0, 8).map(n => ({
    title: n.title,
    source: n.source_info?.name || n.source || 'unknown',
    ts: n.published_on * 1000,
    url: n.url,
  }));
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: Options flow (Deribit public API)
// ──────────────────────────────────────────────────────────────────────────

async function sourceDeribitOptions() {
  // Deribit returns ALL BTC options summary in one call (~300 instruments)
  const d = await fetchJSON(
    'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
    6000
  );
  if (!d?.result?.length) return null;
  const opts = d.result;

  // Parse instrument_name: "BTC-25APR25-90000-C" → expiry, strike, type
  const parsed = opts.map(o => {
    const parts = o.instrument_name.split('-');
    if (parts.length !== 4) return null;
    const [, expiryStr, strikeStr, typeChar] = parts;
    const strike = +strikeStr;
    const type = typeChar; // 'C' or 'P'
    // Parse expiry like "25APR25" → date
    const m = expiryStr.match(/^(\d+)([A-Z]+)(\d+)$/);
    if (!m) return null;
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    const monthNum = months[m[2]];
    if (monthNum === undefined) return null;
    const day = +m[1];
    const year = 2000 + +m[3];
    const expiry = new Date(Date.UTC(year, monthNum, day, 8, 0, 0)).getTime();
    return {
      strike,
      type,
      expiry,
      volume: +o.volume || 0,             // 24h volume
      openInterest: +o.open_interest || 0,// OI in contracts
      markPrice: +o.mark_price || 0,
      underlying: +o.underlying_price || 0,
    };
  }).filter(Boolean);

  if (!parsed.length) return null;
  const underlying = parsed[0].underlying;

  // ── Aggregate PCR (volume + OI) ───────────────────────────────────────
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const o of parsed) {
    if (o.type === 'C') { callVol += o.volume; callOI += o.openInterest; }
    else                { putVol  += o.volume; putOI  += o.openInterest; }
  }
  const pcrVolume = callVol > 0 ? putVol / callVol : null;
  const pcrOI     = callOI > 0 ? putOI / callOI : null;

  // ── Max pain untuk expiry terdekat ────────────────────────────────────
  // Group by expiry, ambil expiry terdekat dari now
  const now = Date.now();
  const futureExpiries = [...new Set(parsed.map(o => o.expiry))].filter(e => e > now).sort();
  const nearestExpiry = futureExpiries[0];
  const nearExpiryOpts = parsed.filter(o => o.expiry === nearestExpiry && o.openInterest > 0);

  let maxPain = null, maxPainStrikes = null;
  if (nearExpiryOpts.length > 5) {
    const strikes = [...new Set(nearExpiryOpts.map(o => o.strike))].sort((a, b) => a - b);
    // Untuk tiap strike candidate, hitung total dollar loss ke option holders
    // (= total cash payout dari penjual ke pembeli kalau settle di strike itu)
    let bestStrike = strikes[0], minLoss = Infinity;
    for (const s of strikes) {
      let loss = 0;
      for (const o of nearExpiryOpts) {
        if (o.type === 'C' && s > o.strike) loss += (s - o.strike) * o.openInterest;
        else if (o.type === 'P' && s < o.strike) loss += (o.strike - s) * o.openInterest;
      }
      if (loss < minLoss) { minLoss = loss; bestStrike = s; }
    }
    maxPain = bestStrike;
    maxPainStrikes = strikes.length;
  }

  // ── Bias signals ──────────────────────────────────────────────────────
  let pcrSignal = 'NEUTRAL';
  if (pcrOI != null) {
    if (pcrOI > 1.0) pcrSignal = 'BEARISH_HEAVY';   // too many puts vs calls
    else if (pcrOI > 0.7) pcrSignal = 'BEARISH';
    else if (pcrOI < 0.5) pcrSignal = 'BULLISH';    // calls dominant
    else if (pcrOI < 0.35) pcrSignal = 'BULLISH_HEAVY'; // extreme bullish (contrarian)
  }

  // Max pain magnetism: berapa % jarak harga sekarang vs max pain
  const maxPainGap = maxPain && underlying
    ? ((maxPain - underlying) / underlying) * 100
    : null;

  return {
    pcrVolume,
    pcrOI,
    pcrSignal,
    maxPain,
    maxPainGap,            // % gap dari spot
    nearestExpiry,
    callVol, putVol,
    callOI, putOI,
    underlying,
    optionsCount: parsed.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: On-chain metrics (CoinMetrics Community API - free, no key)
// ──────────────────────────────────────────────────────────────────────────

async function sourceCoinMetrics() {
  // Free Community API — daily data, last 30 days for context
  const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
    + '?assets=btc'
    + '&metrics=CapMVRVCur,SplyCur,PriceUSD'
    + '&page_size=30&pretty=false';
  const d = await fetchJSON(url, 6000);
  if (!d?.data?.length) return null;

  const rows = d.data.map(r => ({
    date: r.time,
    mvrv: r.CapMVRVCur ? +r.CapMVRVCur : null,
    price: r.PriceUSD ? +r.PriceUSD : null,
    supply: r.SplyCur ? +r.SplyCur : null,
  })).filter(r => r.mvrv != null);

  if (!rows.length) return null;

  const latest = rows[rows.length - 1];
  // Realized price approximation: market price / MVRV
  const realizedPrice = latest.price && latest.mvrv ? latest.price / latest.mvrv : null;

  // Historical context: persentil current MVRV terhadap last 30 days
  const mvrvValues = rows.map(r => r.mvrv).sort((a, b) => a - b);
  const idx = mvrvValues.findIndex(v => v >= latest.mvrv);
  const mvrvPercentile = idx === -1 ? 100 : (idx / mvrvValues.length) * 100;

  // MVRV signal classification (berdasarkan historical thresholds)
  let mvrvSignal = 'NEUTRAL';
  if (latest.mvrv >= 3.5)       mvrvSignal = 'CYCLE_TOP';     // historically overvalued
  else if (latest.mvrv >= 2.5)  mvrvSignal = 'OVERVALUED';
  else if (latest.mvrv >= 1.5)  mvrvSignal = 'BULLISH';
  else if (latest.mvrv >= 1.0)  mvrvSignal = 'FAIR_VALUE';
  else if (latest.mvrv >= 0.8)  mvrvSignal = 'UNDERVALUED';
  else                          mvrvSignal = 'CYCLE_BOTTOM';  // historically rare buy zone

  return {
    mvrv: latest.mvrv,
    realizedPrice,
    mvrvSignal,
    mvrvPercentile30d: mvrvPercentile,
    history: rows.map(r => ({ date: r.date, mvrv: r.mvrv, price: r.price })),
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: Macro context (Stooq CSV - free, no key)
// ──────────────────────────────────────────────────────────────────────────

function parseStooqCsv(text) {
  // Format: "Symbol,Date,Time,Open,High,Low,Close,Volume"
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const row = lines[1].split(',');
  if (row.length < 7) return null;
  return {
    date: row[1],
    open: +row[3],
    close: +row[6],
    changePct: row[3] && row[6] ? ((+row[6] - +row[3]) / +row[3]) * 100 : null,
  };
}

async function sourceMacro() {
  const [dxyTxt, goldTxt, spxTxt] = await Promise.all([
    fetchText('https://stooq.com/q/l/?s=dx.f&f=sd2t2ohlcv&h&e=csv', 5000).catch(() => null),
    fetchText('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv', 5000).catch(() => null),
    fetchText('https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv',   5000).catch(() => null),
  ]);
  const dxy  = dxyTxt  ? parseStooqCsv(dxyTxt)  : null;
  const gold = goldTxt ? parseStooqCsv(goldTxt) : null;
  const spx  = spxTxt  ? parseStooqCsv(spxTxt)  : null;
  if (!dxy && !gold && !spx) return null;

  // Risk environment classification
  // - DXY naik tajam (>0.5%) + SPX turun = risk-off (BTC tends to drop)
  // - DXY turun + SPX naik = risk-on (BTC tends to pump)
  let riskRegime = 'NEUTRAL';
  if (dxy && spx) {
    if (dxy.changePct > 0.3 && spx.changePct < -0.3)      riskRegime = 'RISK_OFF';
    else if (dxy.changePct < -0.3 && spx.changePct > 0.3) riskRegime = 'RISK_ON';
    else if (dxy.changePct > 0.5)                          riskRegime = 'DOLLAR_STRENGTH';
    else if (dxy.changePct < -0.5)                         riskRegime = 'DOLLAR_WEAKNESS';
  }

  return {
    dxy,
    gold,
    spx,
    riskRegime,
  };
}

// =============================================================================
//  HANDLER
// =============================================================================
const SOURCES = [
  ['ticker',        sourceTicker],
  ['orderBook',     sourceOrderBook],
  ['funding',       sourceFunding],
  ['klinesMulti',   sourceKlinesMulti],     // ← v3: 1h/4h/1d sekaligus
  ['openInterest',  sourceOpenInterestHist],// ← v3: OI history
  ['longShort',     sourceLongShortRatios], // ← v3: smart money divergence
  ['takerVolume',   sourceTakerVolume],     // ← v3: aggressor pressure
  ['options',       sourceDeribitOptions],  // ← NEW v4: PCR + max pain
  ['onChain',       sourceCoinMetrics],     // ← NEW v4: MVRV + cycle context
  ['macro',         sourceMacro],           // ← NEW v4: DXY + Gold + SPX
  ['fearGreed',     sourceFearGreed],
  ['coingecko',     sourceCoinGecko],
  ['global',        sourceGlobal],
  ['mempool',       sourceMempool],
  ['network',       sourceNetwork],
  ['news',          sourceNews],
];

export default async function handler() {
  const t0 = Date.now();
  const results = await Promise.allSettled(SOURCES.map(([, fn]) => fn()));

  const snapshot = { ts: Date.now(), version: 4 };
  const errors = [];

  results.forEach((r, i) => {
    const [label] = SOURCES[i];
    if (r.status === 'fulfilled') {
      snapshot[label] = r.value;
    } else {
      const msg = String(r.reason?.message || r.reason || 'unknown').slice(0, 200);
      errors.push({ source: label, msg });
    }
  });

  // ─── Backwards compat: simpan klines lama agar UI v2 tidak break ─────────
  // (sparkline chart pakai snapshot.klines = array closes)
  if (snapshot.klinesMulti?.h1?.closes) {
    snapshot.klines = snapshot.klinesMulti.h1.closes.slice(-168);
  }

  // ─── Compute TA indicators per timeframe ─────────────────────────────────
  if (snapshot.klinesMulti) {
    snapshot.indicators = {
      h1: computeIndicators(snapshot.klinesMulti.h1.closes),
      h4: computeIndicators(snapshot.klinesMulti.h4.closes),
      d1: computeIndicators(snapshot.klinesMulti.d1.closes),
    };

    // Higher-timeframe confluence: berapa banyak TF yang aligned same direction
    const trends = ['h1', 'h4', 'd1'].map(k => snapshot.indicators[k]?.trend).filter(Boolean);
    const bullCount = trends.filter(t => t === 'BULLISH').length;
    const bearCount = trends.filter(t => t === 'BEARISH').length;
    snapshot.confluence = {
      bullish: bullCount,
      bearish: bearCount,
      neutral: 3 - bullCount - bearCount,
      alignment: bullCount === 3 ? 'STRONG_BULL'
              : bearCount === 3 ? 'STRONG_BEAR'
              : bullCount === 2 ? 'BULL'
              : bearCount === 2 ? 'BEAR'
              : 'MIXED',
    };
  }

  // ─── Trim klinesMulti.h1.closes & volumes untuk hemat payload ────────────
  // (keep last 50 untuk visual, indikator sudah pre-computed)
  if (snapshot.klinesMulti) {
    snapshot.klinesMulti.h1.closes  = snapshot.klinesMulti.h1.closes.slice(-50);
    snapshot.klinesMulti.h1.volumes = snapshot.klinesMulti.h1.volumes.slice(-50);
    snapshot.klinesMulti.h4.closes  = snapshot.klinesMulti.h4.closes.slice(-50);
    snapshot.klinesMulti.h4.volumes = snapshot.klinesMulti.h4.volumes.slice(-50);
    snapshot.klinesMulti.d1.closes  = snapshot.klinesMulti.d1.closes.slice(-30);
    snapshot.klinesMulti.d1.volumes = snapshot.klinesMulti.d1.volumes.slice(-30);
  }

  snapshot.errors = errors;
  snapshot.fetchMs = Date.now() - t0;

  return new Response(JSON.stringify(snapshot), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 's-maxage=10, stale-while-revalidate=30',
      'access-control-allow-origin': '*',
    },
  });
}
