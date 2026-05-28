// =============================================================================
//  BTC BANDARMOLOGI DASHBOARD · Gemini-only edition
// =============================================================================
//
//  Arsitektur (vs versi lama):
//    Lama: Browser → Vercel proxy → Anthropic/Gemini → balik
//          (sering 504 karena Vercel Hobby 60s + cold start dari Indonesia)
//    Baru: Browser → Gemini API langsung (Gemini support CORS)
//          + Vercel cuma untuk snapshot data (Binance dll yang block CORS)
//
//  Keuntungan:
//    • Tidak ada Vercel timeout — browser hold connection sendiri
//    • Latency lebih rendah (1 hop, bukan 2)
//    • Struktur JSON pasti valid (responseMimeType + responseSchema)
//    • Code 60% lebih ringkas (no Claude branch, no proxy parsing)
// =============================================================================

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'btc_bandarmologi_gemini_key';
const STORAGE_MODEL = 'btc_bandarmologi_gemini_model';
const STORAGE_GROUNDING = 'btc_bandarmologi_gemini_grounding';
const STORAGE_MODE = 'btc_bandarmologi_analysis_mode';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Model pilihan (urut dari paling efisien)
const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    cost: '~$0.001', latency: '5-12s',
    badge: 'Fast',
    badgeColor: 'text-blue-400',
    desc: 'Cepat & efisien. Cocok untuk Quick mode & Council harian.',
    default: true },
  { id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    cost: '~$0.01',  latency: '25-60s',
    badge: '★ Council Pro',
    badgeColor: 'text-purple-400',
    desc: 'Reasoning terdalam. Direkomendasikan untuk Agent Council — hasil lebih akurat.',
    default: false },
  { id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    cost: '~$0.0005', latency: '4-10s',
    badge: 'Hemat',
    badgeColor: 'text-zinc-400',
    desc: 'Paling murah & cepat. Cocok untuk Quick mode saja.',
    default: false },
];

// Timeout di browser (tidak ada batas Vercel di sini!)
const ANALYZE_TIMEOUT_MS = 90_000;   // 90 detik
const TEST_TIMEOUT_MS    = 20_000;   // 20 detik

// ─────────────────────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  // Data
  snapshot: null,
  analysis: null,
  // UX
  loading: false,
  analyzing: false,
  error: null,
  analyzeError: null,
  analyzeHint: null,
  // Timestamps
  lastFetch: null,
  lastAnalyze: null,
  // Config
  apiKey: '',
  model: 'gemini-2.5-flash',
  grounding: false,             // ← v4: Google Search grounding (off by default)
  analysisMode: 'council',      // ← v5: 'quick' (1 call) | 'council' (multi-agent)
  councilPhase: null,           // ← v5: 'debate' | 'judge' | 'final' | null
  // Settings panel
  showSettings: false,
  showKeyValue: false,
  testResult: null,
  testing: false,
  // Transient draft — preserve input value across re-renders
  // (null = pakai state.apiKey; string = user lagi ngetik)
  keyDraft: null,
};

// Hydrate dari localStorage
try {
  state.apiKey = localStorage.getItem(STORAGE_KEY) || '';
  state.model = localStorage.getItem(STORAGE_MODEL) || 'gemini-2.5-flash';
  state.grounding = localStorage.getItem(STORAGE_GROUNDING) === 'true';
  state.analysisMode = localStorage.getItem(STORAGE_MODE) || 'council';
} catch (_) { /* localStorage blocked → in-memory only */ }

// ─────────────────────────────────────────────────────────────────────────────
//  Formatters
// ─────────────────────────────────────────────────────────────────────────────
const fmt = {
  usd: (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }),
  pct: (n) => n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%',
  ago: (n) => {
    if (!n) return '';
    const s = Math.floor((Date.now() - n) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  },
  maskKey: (k) => {
    if (!k) return '';
    if (k.length < 12) return '••••';
    return k.slice(0, 6) + '••••••••' + k.slice(-4);
  },
};

const pctFrom = (from, to) => (!from || !to) ? null : ((to - from) / from) * 100;

// ─────────────────────────────────────────────────────────────────────────────
//  HTML escape (cegah XSS dari snapshot/AI output)
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render teks agent yang mengandung markdown sederhana (**bold**, \n).
 * Aman: esc() dulu baru convert ** → <strong>.
 */
function renderMd(s) {
  if (s == null) return '';
  return esc(s)
    // **bold** → <strong>
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-medium">$1</strong>')
    // *italic* → <em>
    .replace(/\*([^*\n]+?)\*/g, '<em class="text-zinc-200">$1</em>')
    // newline → <br>
    .replace(/\n/g, '<br>');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Gemini API client (DIRECT dari browser, no Vercel proxy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema untuk structured JSON output — Gemini akan memaksa output sesuai
 * format ini. Tidak perlu lagi parsing regex/markdown.
 */
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    tradeAction: {
      type: 'object',
      properties: {
        direction:          { type: 'string', enum: ['LONG', 'SHORT', 'WAIT'] },
        horizon:            { type: 'string' },
        confidence:         { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        entryLow:           { type: 'number' },
        entryHigh:          { type: 'number' },
        stopLoss:           { type: 'number' },
        takeProfit1:        { type: 'number' },
        takeProfit2:        { type: 'number' },
        riskRewardRatio:    { type: 'number' },
        positionSize:       { type: 'string' },
        invalidationReason: { type: 'string' },
        actionReasoning:    { type: 'string' },
      },
      required: ['direction', 'horizon', 'confidence', 'entryLow', 'entryHigh',
                 'stopLoss', 'takeProfit1', 'takeProfit2', 'riskRewardRatio',
                 'positionSize', 'invalidationReason', 'actionReasoning'],
    },
    signal:           { type: 'string', enum: ['STRONG_BUY', 'BUY', 'NEUTRAL', 'CAUTION', 'AVOID'] },
    signalReasoning:  { type: 'array', items: { type: 'string' } },
    supportLevel:     { type: 'number' },
    resistanceLevel:  { type: 'number' },
    whaleSummary:     { type: 'string' },
    newsHeadlines:    { type: 'array', items: { type: 'string' } },
    riskWarning:      { type: 'string' },

    // ─── v3 additions ────────────────────────────────────────────────────
    derivativesView: { type: 'string' },   // 1-2 kalimat: apa kata OI/LS/taker
    technicalView:   { type: 'string' },   // 1-2 kalimat: apa kata RSI/MACD/BB
    timeframeAlignment: {
      type: 'object',
      properties: {
        h1: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
        h4: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
        d1: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
      },
      required: ['h1', 'h4', 'd1'],
    },

    // ─── v4 additions ────────────────────────────────────────────────────
    optionsView:   { type: 'string' },   // PCR + max pain interpretation
    onChainView:   { type: 'string' },   // MVRV cycle context
    macroView:     { type: 'string' },   // DXY/Gold/SPX correlation
    cycleStage:    { type: 'string', enum: ['ACCUMULATION', 'MARKUP', 'DISTRIBUTION', 'MARKDOWN', 'UNCLEAR'] },
  },
  required: ['tradeAction', 'signal', 'signalReasoning', 'supportLevel',
             'resistanceLevel', 'whaleSummary', 'newsHeadlines', 'riskWarning',
             'derivativesView', 'technicalView', 'timeframeAlignment',
             'optionsView', 'onChainView', 'macroView', 'cycleStage'],
};

/**
 * Build prompt yang concise tapi lengkap. Tidak perlu ulangi struktur JSON
 * di prompt karena responseSchema sudah memaksa output.
 */
/**
 * Build data section saja (dipakai bersama oleh quick mode & semua agent council).
 * Mengembalikan blok teks berisi seluruh snapshot data terformat.
 */
function buildDataSection(s) {
  const num = (v, decimals = 2) => v == null ? 'N/A' : Number(v).toFixed(decimals);
  const big = (v, divisor = 1e9, suffix = 'B') =>
    v == null ? 'N/A' : '$' + (v / divisor).toFixed(2) + suffix;

  const newsLines = (s.news && s.news.length > 0)
    ? s.news.slice(0, 8).map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join('\n')
    : '(berita tidak tersedia)';

  const oi = s.openInterest, ls = s.longShort, tv = s.takerVolume;

  const oiLine = oi
    ? `• Open Interest: ${big(oi.current, 1e9)} (${num(oi.change24h)}% 24h) ${
        oi.change24h > 2 && s.ticker?.change24h > 0 ? '→ NEW MONEY masuk (trend valid)' :
        oi.change24h < -2 && s.ticker?.change24h > 0 ? '→ SHORT COVER rally (lemah)' :
        oi.change24h > 2 && s.ticker?.change24h < 0 ? '→ NEW SHORTS open (bearish confirm)' :
        oi.change24h < -2 && s.ticker?.change24h < 0 ? '→ LONG capitulation (selling pressure)' :
        '→ neutral flow'
      }`
    : '• Open Interest: data tidak tersedia';

  const lsLine = ls
    ? `• Long/Short ratio TOP TRADER (smart money): ${num(ls.topTrader.current, 2)} (24h ago ${num(ls.topTrader.prev24h, 2)}, ${ls.topTrader.trend})
• Long/Short ratio RETAIL (global): ${num(ls.global.current, 2)} (24h ago ${num(ls.global.prev24h, 2)}, ${ls.global.trend})
• Smart money bias: ${ls.smartMoneyBias}${ls.smartMoneyBias.includes('SMART_LONG_RETAIL_SHORT') ? ' ⚠ contrarian setup' : ls.smartMoneyBias.includes('SMART_SHORT_RETAIL_LONG') ? ' ⚠ contrarian setup' : ''}`
    : '• Long/Short: data tidak tersedia';

  const tvLine = tv
    ? `• Taker buy/sell ratio: ${num(tv.current, 2)} (24h avg ${num(tv.avg24h, 2)}, trend ${tv.trend}) ${
        tv.current > 1.1 ? '→ buyer aggression' : tv.current < 0.9 ? '→ seller aggression' : '→ balanced'
      }`
    : '• Taker volume: data tidak tersedia';

  const ind = s.indicators || {};
  const conf = s.confluence;

  const fmtInd = (tf, label) => {
    const i = ind[tf];
    if (!i) return `• ${label}: data tidak tersedia`;
    const rsiTag = i.rsi == null ? '' :
      i.rsi >= 70 ? ' (OVERBOUGHT)' :
      i.rsi <= 30 ? ' (OVERSOLD)' :
      i.rsi >= 60 ? ' (bullish bias)' :
      i.rsi <= 40 ? ' (bearish bias)' : ' (neutral)';
    const macdTag = i.macd ? `MACD ${i.macd.bullish ? 'BULL' : 'BEAR'} (${i.macd.momentum.toLowerCase()})` : 'MACD N/A';
    const bbTag = i.bb ? `BB pos ${(i.bb.position * 100).toFixed(0)}%${i.bb.widthPct < 4 ? ' (SQUEEZE)' : ''}` : 'BB N/A';
    return `• ${label}: trend ${i.trend} · RSI ${num(i.rsi, 1)}${rsiTag} · ${macdTag} · ${bbTag} · EMA21 ${num(i.ema21, 0)} / EMA55 ${num(i.ema55, 0)}${i.ema200 ? ' / EMA200 ' + num(i.ema200, 0) : ''}`;
  };

  const confluenceLine = conf
    ? `• Multi-TF confluence: 1h+4h+1d → ${conf.alignment} (${conf.bullish} bull, ${conf.bearish} bear, ${conf.neutral} neutral)`
    : '';

  const opt = s.options;
  const optBlock = opt ? `
═══ OPTIONS FLOW (Deribit) ═══
• Put/Call Ratio (OI): ${num(opt.pcrOI, 2)} → ${opt.pcrSignal.replace('_', ' ')}
• Put/Call Ratio (24h vol): ${num(opt.pcrVolume, 2)}
• Max Pain (nearest expiry ${opt.nearestExpiry ? new Date(opt.nearestExpiry).toISOString().slice(0,10) : '—'}): $${opt.maxPain ? Number(opt.maxPain).toLocaleString() : '—'} (${opt.maxPainGap != null ? (opt.maxPainGap >= 0 ? '+' : '') + opt.maxPainGap.toFixed(2) + '% from spot' : '—'})
• Total Call OI: ${big(opt.callOI, 1000, 'K contracts')} | Put OI: ${big(opt.putOI, 1000, 'K contracts')}` : '';

  const oc = s.onChain;
  const onChainBlock = oc ? `
═══ ON-CHAIN CYCLE (CoinMetrics) ═══
• MVRV ratio: ${num(oc.mvrv, 2)} → ${oc.mvrvSignal.replace('_', ' ')}
• Realized Price (cost basis): $${oc.realizedPrice ? Number(oc.realizedPrice).toLocaleString(undefined, {maximumFractionDigits: 0}) : '—'}  (current premium: ${oc.realizedPrice && s.ticker?.price ? '+' + (((s.ticker.price - oc.realizedPrice) / oc.realizedPrice) * 100).toFixed(1) + '%' : '—'})
• MVRV percentile (30d): ${num(oc.mvrvPercentile30d, 0)}%` : '';

  const mc = s.macro;
  const macroBlock = mc ? `
═══ MACRO CONTEXT (Stooq) ═══
• DXY: ${mc.dxy ? mc.dxy.close.toFixed(2) + ' (' + (mc.dxy.changePct >= 0 ? '+' : '') + mc.dxy.changePct.toFixed(2) + '%)' : 'N/A'}
• Gold: ${mc.gold ? '$' + mc.gold.close.toFixed(0) + ' (' + (mc.gold.changePct >= 0 ? '+' : '') + mc.gold.changePct.toFixed(2) + '%)' : 'N/A'}
• S&P 500: ${mc.spx ? mc.spx.close.toFixed(0) + ' (' + (mc.spx.changePct >= 0 ? '+' : '') + mc.spx.changePct.toFixed(2) + '%)' : 'N/A'}
• Risk regime: ${mc.riskRegime.replace('_', ' ')}` : '';

  return `═══ HARGA & MARKET ═══
• BTC/USDT spot: $${num(s.ticker?.price, 2)}
• 24h change: ${num(s.ticker?.change24h)}% | High/Low: $${num(s.ticker?.high24h, 0)} / $${num(s.ticker?.low24h, 0)}
• 7d / 30d: ${num(s.coingecko?.change7d)}% / ${num(s.coingecko?.change30d)}%
• Market cap: ${big(s.coingecko?.marketCap, 1e12, 'T')}
• 24h volume: ${big(s.ticker?.volume24h)}
• BTC dominance: ${num(s.global?.btcDominance)}%
• ATH distance: ${num(s.coingecko?.athDistance)}%

═══ ORDER BOOK (spot) ═══
• Top bid walls: ${big(s.orderBook?.bidWall, 1e6, 'M')}
• Top ask walls: ${big(s.orderBook?.askWall, 1e6, 'M')}
• Bid dominance: ${s.orderBook?.ratio ? (s.orderBook.ratio * 100).toFixed(1) + '%' : 'N/A'}
• Best bid: $${num(s.orderBook?.bids?.[0]?.price, 0)} | Best ask: $${num(s.orderBook?.asks?.[0]?.price, 0)}

═══ DERIVATIVES INTELLIGENCE (Binance Futures) ═══
• Funding rate (perp): ${num(s.funding?.fundingRate, 4)}%  ${(s.funding?.fundingRate ?? 0) > 0.01 ? '(longs crowded — pay shorts)' : (s.funding?.fundingRate ?? 0) < -0.01 ? '(shorts crowded — pay longs)' : '(neutral)'}
${oiLine}
${lsLine}
${tvLine}

═══ TECHNICAL ANALYSIS (multi-timeframe, pre-computed) ═══
${fmtInd('h1', '1H')}
${fmtInd('h4', '4H')}
${fmtInd('d1', '1D')}
${confluenceLine}${optBlock}${onChainBlock}${macroBlock}

═══ SENTIMENT & NETWORK ═══
• Fear & Greed: ${s.fearGreed?.value ?? 'N/A'} (${s.fearGreed?.label ?? 'N/A'})
• Hashrate: ${s.network?.hashrate ? (s.network.hashrate / 1e9).toFixed(2) + ' EH/s' : 'N/A'}
• Mempool fast fee: ${s.mempool?.fastestFee ?? 'N/A'} sat/vB

═══ BERITA TERKINI (CryptoCompare) ═══
${newsLines}`;
}

/**
 * QUICK MODE prompt (single-call, sama seperti v4). Reuse buildDataSection.
 */
function buildPrompt(s) {
  const num = (v, decimals = 2) => v == null ? 'N/A' : Number(v).toFixed(decimals);
  const big = (v, divisor = 1e9, suffix = 'B') =>
    v == null ? 'N/A' : '$' + (v / divisor).toFixed(2) + suffix;

  return `Kamu adalah Bitcoin bandarmologi trader senior dengan 10+ tahun pengalaman membaca order flow, derivatives positioning, dan smart money behavior.

Analisis snapshot REAL-TIME berikut, lalu berikan trade action plan terstruktur.

${buildDataSection(s)}

TUGAS:
Analisis dengan kaidah bandarmologi PLUS confluence multi-timeframe.
Berikan trade action plan untuk horizon 1-3 hari (atau lebih sesuai kondisi).

KAIDAH BACA DATA (gunakan untuk reasoning):
1. CONFIRMATION dari Open Interest:
   - OI naik + harga naik = trend valid (HIGH confidence LONG)
   - OI turun + harga naik = short squeeze saja (LOW confidence, rentan reverse)
   - OI naik + harga turun = real selling (HIGH confidence SHORT)
2. SMART MONEY vs RETAIL:
   - Top trader long, retail short = bullish setup (smart money positioned)
   - Top trader short, retail long = bearish setup (retail jadi exit liquidity)
3. TAKER pressure:
   - Taker buy ratio > 1.1 dengan harga naik = real demand
   - Taker buy < 0.9 dengan harga turun = real distribution
4. MULTI-TF CONFLUENCE:
   - 3 TF aligned (STRONG_BULL/BEAR) = HIGH confidence
   - 2 TF aligned = MEDIUM confidence  
   - Mixed = LOW / WAIT
5. RSI extreme + diverge dari TF lain = sinyal reversal
6. BB squeeze (widthPct < 4%) = volatility expansion incoming
7. Funding extreme (>0.05% atau <-0.05%) = mean reversion likely
8. OPTIONS FLOW (v4):
   - PCR OI > 1.0 = puts dominant (BEARISH sentiment, atau contrarian bullish kalau extreme)
   - PCR OI < 0.5 = calls dominant (BULLISH, atau contrarian bearish kalau extreme < 0.35)
   - Max pain efek magnet: harga sering bergerak ke max pain menjelang expiry (terutama 3-7 hari sebelumnya)
9. ON-CHAIN MVRV (v4):
   - MVRV > 3.5 = CYCLE TOP territory (historical sell zone) — caution untuk LONG
   - MVRV 1.5-3.5 = healthy bull range
   - MVRV < 1.0 = CYCLE BOTTOM (historical buy zone)
   - Realized Price = cost basis market — sering jadi support psikologis kuat
10. MACRO (v4):
   - DXY rally + SPX fall = RISK_OFF → BTC kemungkinan ikut turun
   - DXY weak + SPX rally = RISK_ON → BTC tailwind
   - Jangan paksa direction BTC kalau macro lawan arah (kecuali ada sinyal idiosyncratic kuat dari derivatives/on-chain)

ATURAN KETAT (PASTI DIPATUHI):
• LONG → stopLoss < entryLow < entryHigh < takeProfit1 < takeProfit2
• SHORT → takeProfit2 < takeProfit1 < entryLow < entryHigh < stopLoss
• WAIT → semua harga ≈ harga current
• riskRewardRatio minimum 1.5 untuk LONG/SHORT (kalau tidak tercapai → WAIT)
• Mixed/kontra signal → WAIT (jangan paksa direction)
• signalReasoning: tepat 3 poin singkat (cite specific data dari LAYER yang berbeda — misal: 1 dari TA, 1 dari derivatives, 1 dari on-chain/macro)
• newsHeadlines: top 3 headline relevan
• derivativesView: 1-2 kalimat — apa kata data OI+L/S+taker
• technicalView: 1-2 kalimat — apa kata RSI+MACD+BB multi-TF
• optionsView: 1-2 kalimat — apa kata PCR + max pain (kosongkan kalau data N/A)
• onChainView: 1-2 kalimat — apa kata MVRV cycle context (kosongkan kalau data N/A)
• macroView: 1-2 kalimat — apa kata DXY/Gold/SPX (kosongkan kalau data N/A)
• cycleStage: klasifikasi fase pasar saat ini — ACCUMULATION (low MVRV, sideways), MARKUP (rising MVRV, bullish trend), DISTRIBUTION (high MVRV, sideways/topping), MARKDOWN (falling, decreasing MVRV), atau UNCLEAR
• timeframeAlignment: harus konsisten dengan data multi-TF di atas
• HIGH confidence hanya jika MIN 2 TF aligned + derivatives confirm + macro tidak lawan arah
• Bahasa Indonesia untuk semua field text.`;
}

/**
 * Inti: panggil Gemini API langsung dari browser dengan structured output.
 *
 * @param {string} apiKey  - User's Gemini API key
 * @param {string} modelId - Model ID (e.g. 'gemini-2.5-flash')
 * @param {string} prompt  - The analysis prompt
 * @param {AbortSignal} signal - For cancellation
 * @returns {Promise<{ parsed: object, raw: string, usage: object, elapsed: number }>}
 */
async function callGemini(apiKey, modelId, prompt, signal, grounding = false) {
  const url = `${GEMINI_BASE}/${modelId}:generateContent`;
  const t0 = Date.now();

  // Grounding ⇄ responseSchema incompatible. Pakai schema enforcement kalau OFF,
  // pakai prompt-only JSON instruction + manual parse kalau ON.
  const body = {
    contents: [{ parts: [{ text: prompt + (grounding ? '\n\nPENTING: OUTPUT HARUS HANYA JSON valid sesuai schema yang disebutkan, tanpa markdown wrapper, tanpa preamble.' : '') }] }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 8192,   // ← fix: 4096 terlalu kecil untuk schema 15+ field
      ...(grounding
        ? {} // no schema/mime when grounding
        : { responseMimeType: 'application/json', responseSchema: ANALYSIS_SCHEMA }),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
    ...(grounding ? { tools: [{ google_search: {} }] } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  const elapsed = Date.now() - t0;

  // ── Handle HTTP error ─────────────────────────────────────────────────────
  if (!res.ok) {
    const errText = await res.text();
    let detail = errText, gStatus = '';
    try {
      const j = JSON.parse(errText);
      detail = j.error?.message || errText;
      gStatus = j.error?.status || '';
    } catch (_) {}
    const err = new Error((gStatus ? `[${gStatus}] ` : '') + detail.slice(0, 400));
    err.status = res.status;
    err.gStatus = gStatus;
    err.elapsed = elapsed;
    throw err;
  }

  const data = await res.json();

  // ── Handle blocked / no candidate ─────────────────────────────────────────
  if (data.promptFeedback?.blockReason) {
    const err = new Error(`Prompt blocked: ${data.promptFeedback.blockReason}`);
    err.status = 502;
    throw err;
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    const err = new Error('No candidate in Gemini response');
    err.status = 502;
    throw err;
  }
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'RECITATION') {
    const err = new Error(`Stopped by Gemini: ${cand.finishReason}`);
    err.status = 502;
    throw err;
  }
  if (cand.finishReason === 'MAX_TOKENS') {
    const err = new Error('Response truncated (MAX_TOKENS) — coba ulang atau pakai model Pro');
    err.status = 502;
    throw err;
  }

  // ── Extract text — filter thinking parts (Gemini 2.5 Pro/Flash) ────────────
  const allParts = (cand.content?.parts || []);
  const responseParts = allParts.filter(p => !p.thought);
  const raw = (responseParts.length > 0 ? responseParts : allParts)
    .map(p => p.text || '').filter(Boolean).join('\n').trim();

  if (!raw) {
    const err = new Error(`Empty response from Gemini (finishReason: ${cand.finishReason})`);
    err.status = 502;
    throw err;
  }

  // ── Parse (responseMimeType=application/json sudah jamin JSON valid) ─────
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Fallback: strip markdown fences, extract {…}
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      const err = new Error(
        `JSON parse error: ${e.message}. ` +
        (raw.length < 20 ? `Response kosong (${raw.length} chars) — kemungkinan MAX_TOKENS terpotong.` : `Raw: "${raw.slice(0, 200)}"`)
      );
      err.status = 502;
      err.raw = raw.slice(0, 500);
      throw err;
    }
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e2) {
      const err = new Error(`JSON parse fallback juga gagal: ${e2.message} — response terpotong di tengah JSON.`);
      err.status = 502;
      err.raw = raw.slice(0, 500);
      throw err;
    }
  }

  // Capture grounding citations if available
  const groundingMeta = cand.groundingMetadata || null;

  return {
    parsed,
    raw,
    usage: data.usageMetadata || {},
    elapsed,
    finishReason: cand.finishReason,
    groundingMeta,
  };
}

/**
 * Wrapper dengan retry untuk transient errors.
 */
async function callGeminiWithRetry(apiKey, modelId, prompt, signal, grounding) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callGemini(apiKey, modelId, prompt, signal, grounding);
    } catch (err) {
      lastErr = err;
      // Tidak retry kalau: auth error (401/403), bad request (400), atau user abort
      if (err.status === 400 || err.status === 401 || err.status === 403) throw err;
      if (signal?.aborted) throw err;
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 1500)); // wait sebelum retry
      }
    }
  }
  throw lastErr;
}

// =============================================================================
//  AGENT COUNCIL (v5) — multi-agent debate untuk keputusan lebih robust
// =============================================================================
//  Pipeline: Bull + Bear (paralel) → Debate Judge → Portfolio Manager (final)
//  Terinspirasi TradingAgents (Tauric Research) tapi diadaptasi untuk
//  browser + Gemini single-snapshot. Tiap agent = 1 Gemini call.
// =============================================================================

/**
 * Generic free-text agent call (untuk Bull & Bear yang output prosa).
 * Fix v5.2:
 *  - Filter p.thought === true (Gemini 2.5 Pro/Flash thinking model)
 *  - Tambah finishReason check
 *  - Retry sekali untuk transient empty/502
 */
async function callAgentText(apiKey, modelId, prompt, signal) {
  const url = `${GEMINI_BASE}/${modelId}:generateContent`;

  async function _call() {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 2000 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const t = await res.text();
      let detail = t, gStatus = '';
      try { const j = JSON.parse(t); detail = j.error?.message || t; gStatus = j.error?.status || ''; } catch (_) {}
      const err = new Error((gStatus ? `[${gStatus}] ` : '') + detail.slice(0, 300));
      err.status = res.status;
      throw err;
    }

    const data = await res.json();

    // ── No candidate ───────────────────────────────────────────────────────
    if (!data.candidates?.length) {
      const blockReason = data.promptFeedback?.blockReason;
      const err = new Error(blockReason
        ? `Agent diblokir Gemini: ${blockReason}`
        : 'Gemini tidak mengembalikan candidate (no_candidates)');
      err.status = 502;
      throw err;
    }

    const cand = data.candidates[0];
    const reason = cand.finishReason || 'UNKNOWN';

    // ── Blocked/failed finish reasons ─────────────────────────────────────
    if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) {
      const err = new Error(`Agent dihentikan Gemini (${reason}) — coba ulang, biasanya transient`);
      err.status = 502;
      err.finishReason = reason;
      throw err;
    }

    // ── Extract text — KECUALIKAN thought parts (thinking model) ──────────
    // Gemini 2.5 Pro/Flash mengembalikan parts dengan p.thought=true (internal reasoning)
    // yang bukan bagian dari response final. Kita hanya mau response-nya.
    const parts = (cand.content?.parts || []);
    const responseParts = parts.filter(p => !p.thought);
    let text = responseParts.map(p => p.text || '').filter(Boolean).join('\n').trim();

    // Fallback: kalau response parts kosong tapi ada thought parts, mungkin model
    // belum generate response — return singkat supaya pipeline tetap jalan
    if (!text && parts.length > 0) {
      // Ambil semua text termasuk thinking sebagai fallback
      text = parts.map(p => p.text || '').filter(Boolean).join('\n').trim();
    }

    if (!text) {
      const err = new Error(
        `Agent response kosong (finishReason: ${reason}) — ` +
        (reason === 'MAX_TOKENS' ? 'token habis, coba ulang' : 'kemungkinan safety filter atau thinking-only response')
      );
      err.status = 502;
      err.finishReason = reason;
      throw err;
    }

    return text;
  }

  // Retry sekali untuk empty/502 transient error
  try {
    return await _call();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err.status === 400 || err.status === 401 || err.status === 403 || err.status === 429) throw err;
    // Tunggu lalu retry
    await new Promise(r => setTimeout(r, 2000));
    return _call();
  }
}

/**
 * Structured agent call (untuk Judge yang output JSON terstruktur).
 * Fix v5.1: tambah finishReason=MAX_TOKENS check + safe fallback parsing.
 */
async function callAgentStructured(apiKey, modelId, prompt, schema, signal) {
  const url = `${GEMINI_BASE}/${modelId}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.5, topP: 0.95,
        maxOutputTokens: 3000,   // ← fix: naik dari 1500
        responseMimeType: 'application/json', responseSchema: schema,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    }),
    signal,
  });

  if (!res.ok) {
    const t = await res.text();
    let detail = t, gStatus = '';
    try { const j = JSON.parse(t); detail = j.error?.message || t; gStatus = j.error?.status || ''; } catch (_) {}
    const err = new Error((gStatus ? `[${gStatus}] ` : '') + detail.slice(0, 300));
    err.status = res.status;
    throw err;
  }

  const data = await res.json();

  // ── Block / no candidate ──────────────────────────────────────────────────
  if (data.promptFeedback?.blockReason) {
    const err = new Error(`Agent blocked: ${data.promptFeedback.blockReason}`);
    err.status = 502;
    throw err;
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    const err = new Error('No candidate from agent call');
    err.status = 502;
    throw err;
  }

  // ── Truncation guard ─────────────────────────────────────────────────────
  if (cand.finishReason === 'MAX_TOKENS') {
    const err = new Error('Agent response truncated (MAX_TOKENS) — JSON akan corrupt. Coba lagi.');
    err.status = 502;
    throw err;
  }
  if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII'].includes(cand.finishReason)) {
    const err = new Error(`Agent dihentikan Gemini (${cand.finishReason}) — coba ulang`);
    err.status = 502;
    throw err;
  }

  // ── Filter thinking parts (Gemini 2.5 Pro/Flash thinking model) ──────────
  const parts = (cand.content?.parts || []);
  const responseParts = parts.filter(p => !p.thought);
  const raw = responseParts.map(p => p.text || '').filter(Boolean).join('\n').trim()
    // Fallback ke semua parts kalau response parts kosong
    || parts.map(p => p.text || '').filter(Boolean).join('\n').trim();

  // ── Safe JSON parse ───────────────────────────────────────────────────────
  if (!raw) {
    const err = new Error('Empty agent response (agent returned no text)');
    err.status = 502;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    // Fallback: strip markdown fences, extract {…}
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a === -1 || b === -1 || b <= a) {
      const err = new Error(`Agent returned non-JSON: "${raw.slice(0, 200)}"`);
      err.status = 502;
      throw err;
    }
    return JSON.parse(cleaned.slice(a, b + 1));
  }
}

// ── Agent prompts ────────────────────────────────────────────────────────────

function buildBullPrompt(s) {
  return `Kamu adalah BULL RESEARCHER di sebuah trading desk BTC. Tugasmu: bangun argumen TERKUAT untuk posisi LONG (beli) BTC saat ini.

Gunakan HANYA data di bawah. Jangan mengarang. Kalau ada sinyal bullish, tonjolkan. Kalau ada sinyal bearish, akui tapi jelaskan kenapa itu bisa di-counter atau kenapa bullish tetap lebih kuat.

${buildDataSection(s)}

INSTRUKSI:
- Tulis 3-5 poin argumen LONG terkuat, masing-masing cite data spesifik (angka).
- Fokus: konfirmasi trend (OI, taker), smart money positioning, confluence TF, support levels, on-chain value, macro tailwind.
- Akui 1 risiko terbesar terhadap thesis bullish, lalu jelaskan kenapa masih worth it.
- Tulis natural seperti briefing ke trader, bukan bullet kaku. Maksimal 200 kata.
- Bahasa Indonesia.`;
}

function buildBearPrompt(s) {
  return `Kamu adalah BEAR RESEARCHER di sebuah trading desk BTC. Tugasmu: bangun argumen TERKUAT untuk posisi SHORT (jual) atau MENGHINDARI BTC saat ini.

Gunakan HANYA data di bawah. Jangan mengarang. Kalau ada sinyal bearish, tonjolkan. Kalau ada sinyal bullish, akui tapi jelaskan kenapa itu rapuh atau kenapa bearish tetap lebih kuat.

${buildDataSection(s)}

INSTRUKSI:
- Tulis 3-5 poin argumen SHORT/AVOID terkuat, masing-masing cite data spesifik (angka).
- Fokus: divergence OI vs harga, funding/positioning yang crowded, resistance, RSI overbought, MVRV mahal, macro headwind, max pain di bawah harga.
- Akui 1 kekuatan terbesar dari sisi bullish, lalu jelaskan kenapa kamu tetap bearish.
- Tulis natural seperti briefing ke trader, bukan bullet kaku. Maksimal 200 kata.
- Bahasa Indonesia.`;
}

function buildJudgePrompt(s, bullCase, bearCase) {
  return `Kamu adalah RESEARCH MANAGER (debate judge) yang OBJEKTIF di trading desk BTC. Dua peneliti baru saja berdebat. Tugasmu: timbang kedua argumen, tentukan sisi mana yang lebih kuat secara bukti.

DATA MENTAH (untuk verifikasi klaim):
${buildDataSection(s)}

═══ ARGUMEN BULL ═══
${bullCase}

═══ ARGUMEN BEAR ═══
${bearCase}

TUGAS:
- Evaluasi kualitas bukti tiap sisi (bukan retorika). Sisi mana cite data lebih solid?
- Tentukan lean: BULLISH / BEARISH / NEUTRAL.
- Beri conviction 0-100 (seberapa yakin pada lean ini).
- Sebutkan 2-3 faktor penentu (deciding factors) yang membuatmu condong ke sisi itu.
- Sebutkan apa yang bisa membuktikan lean ini SALAH (invalidation).
- Kalau kedua sisi sama kuat atau sinyal saling bertentangan → NEUTRAL dengan conviction rendah.
- Bahasa Indonesia untuk semua field text.`;
}

function buildCouncilFinalPrompt(s, bullCase, bearCase, judge) {
  return `Kamu adalah PORTFOLIO MANAGER senior — pengambil keputusan FINAL di trading desk BTC. Kamu menerima hasil debat tim riset dan keputusan judge. Sekarang buat keputusan trading final dengan disiplin risk management.

DATA MENTAH:
${buildDataSection(s)}

═══ ARGUMEN BULL ═══
${bullCase}

═══ ARGUMEN BEAR ═══
${bearCase}

═══ KEPUTUSAN JUDGE ═══
Lean: ${judge.lean} (conviction ${judge.conviction}/100)
Faktor penentu: ${(judge.decidingFactors || []).join('; ')}
Invalidation: ${judge.invalidation || '—'}

TUGAS FINAL (terapkan RISK LENS sebagai 3 sudut pandang internal):
1. Sudut AGGRESSIVE: kalau ambil posisi, di mana peluang maksimal?
2. Sudut CONSERVATIVE: apa yang bisa bikin rugi? Worst case?
3. Sudut NEUTRAL: apakah risk/reward seimbang & layak?

Lalu putuskan trade action FINAL dengan aturan:
- Kalau judge conviction < 45 ATAU sinyal mixed → WAIT (jangan paksa).
- LONG hanya kalau lean BULLISH + R:R ≥ 1.5 + derivatives/TF confirm.
- SHORT hanya kalau lean BEARISH + R:R ≥ 1.5 + derivatives/TF confirm.
- Posisi sizing harus konsisten dengan conviction (conviction rendah = size kecil).

ATURAN HARGA KETAT:
- LONG → stopLoss < entryLow < entryHigh < takeProfit1 < takeProfit2
- SHORT → takeProfit2 < takeProfit1 < entryLow < entryHigh < stopLoss
- WAIT → semua harga ≈ harga current

Isi semua field sesuai schema. signalReasoning: 3 poin cite layer berbeda. Bahasa Indonesia untuk semua field text.`;
}

// ── Judge schema ──────────────────────────────────────────────────────────────
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    lean:            { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
    conviction:      { type: 'number' },
    decidingFactors: { type: 'array', items: { type: 'string' } },
    invalidation:    { type: 'string' },
    summary:         { type: 'string' },
  },
  required: ['lean', 'conviction', 'decidingFactors', 'invalidation', 'summary'],
};

/**
 * Orchestrate the full council pipeline.
 * @param onProgress callback(phase) untuk update UI
 */
async function runCouncil(apiKey, modelId, snapshot, signal, onProgress) {
  // ── Phase 1: Bull + Bear ─────────────────────────────────────────────────
  // Pro: sequential dengan jeda (Pro RPM limit lebih ketat & ada thinking overhead)
  // Flash: paralel (lebih longgar rate limit)
  onProgress?.('debate');
  const isPro = modelId.includes('pro');
  let bullCase, bearCase;
  if (isPro) {
    bullCase = await callAgentText(apiKey, modelId, buildBullPrompt(snapshot), signal);
    onProgress?.('debate_bear');  // sub-progress visual
    await new Promise(r => setTimeout(r, 1000)); // jeda kecil antar call
    bearCase = await callAgentText(apiKey, modelId, buildBearPrompt(snapshot), signal);
  } else {
    [bullCase, bearCase] = await Promise.all([
      callAgentText(apiKey, modelId, buildBullPrompt(snapshot), signal),
      callAgentText(apiKey, modelId, buildBearPrompt(snapshot), signal),
    ]);
  }

  // ── Phase 2: Judge menimbang ──────────────────────────────────────────────
  onProgress?.('judge');
  const judge = await callAgentStructured(
    apiKey, modelId, buildJudgePrompt(snapshot, bullCase, bearCase), JUDGE_SCHEMA, signal
  );

  // ── Phase 3: Portfolio Manager final decision ────────────────────────────
  onProgress?.('final');
  const finalRes = await callGemini(
    apiKey, modelId, buildCouncilFinalPrompt(snapshot, bullCase, bearCase, judge), signal, false
  );

  const analysis = finalRes.parsed;
  analysis.debate = { bullCase, bearCase, judge };
  analysis._meta = {
    model: modelId,
    elapsedMs: finalRes.elapsed,
    finishReason: finalRes.finishReason,
    usage: finalRes.usage,
    mode: 'council',
  };
  return analysis;
}


// ─────────────────────────────────────────────────────────────────────────────
//  Snapshot fetch (Vercel edge function)
// ─────────────────────────────────────────────────────────────────────────────
async function loadSnapshot() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch('/api/snapshot', { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.snapshot = await r.json();
    state.lastFetch = Date.now();
  } catch (e) {
    state.error = e.name === 'AbortError' ? 'Timeout 12s saat fetch snapshot' : e.message;
  } finally {
    state.loading = false;
    render();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI Analysis (browser → Gemini langsung)
// ─────────────────────────────────────────────────────────────────────────────
let _analysisAbortCtrl = null;

async function loadAnalysis() {
  if (!state.snapshot) return;

  if (!state.apiKey) {
    state.showSettings = true;
    state.analyzeError = 'API key Gemini belum di-set. Buka Settings di atas.';
    render();
    return;
  }

  state.analyzing = true;
  state.analyzeError = null;
  state.analyzeHint = null;
  state.councilPhase = null;
  render();

  // Council butuh lebih lama (4 calls) → timeout lebih panjang
  const timeoutMs = state.analysisMode === 'council' ? 180_000 : ANALYZE_TIMEOUT_MS;

  // Setup abort controller untuk timeout
  _analysisAbortCtrl = new AbortController();
  const timeoutId = setTimeout(() => _analysisAbortCtrl.abort(), timeoutMs);

  try {
    let analysis;

    if (state.analysisMode === 'council') {
      // ── Multi-agent council ──────────────────────────────────────────────
      analysis = await runCouncil(
        state.apiKey,
        state.model,
        state.snapshot,
        _analysisAbortCtrl.signal,
        (phase) => { state.councilPhase = phase; render(); },
      );
    } else {
      // ── Quick single-call (v4 behaviour) ─────────────────────────────────
      const prompt = buildPrompt(state.snapshot);
      const result = await callGeminiWithRetry(
        state.apiKey,
        state.model,
        prompt,
        _analysisAbortCtrl.signal,
        state.grounding,
      );
      analysis = result.parsed;
      analysis._meta = {
        model: state.model,
        elapsedMs: result.elapsed,
        finishReason: result.finishReason,
        usage: result.usage,
        grounding: state.grounding,
        groundingMeta: result.groundingMeta,
        mode: 'quick',
      };
    }

    state.analysis = analysis;
    state.lastAnalyze = Date.now();
  } catch (err) {
    if (err.name === 'AbortError' || _analysisAbortCtrl?.signal.aborted) {
      state.analyzeError = `Timeout`;
      state.analyzeHint = state.analysisMode === 'council'
        ? 'Council butuh 4 AI call (~30-50s). Coba mode Quick di Settings, atau ulangi.'
        : 'Coba lagi atau ganti model ke Gemini 2.5 Flash (lebih cepat).';
    } else if (err.status === 401 || err.status === 403) {
      state.analyzeError = `Auth gagal (${err.status})`;
      state.analyzeHint = 'API key invalid atau expired. Generate ulang di aistudio.google.com';
    } else if (err.status === 429) {
      state.analyzeError = 'Rate limit / kuota habis';
      state.analyzeHint = 'Tunggu 1 menit atau cek quota di aistudio.google.com';
    } else if (err.status === 400) {
      state.analyzeError = 'Bad request: ' + (err.message || '').slice(0, 200);
      state.analyzeHint = 'Mungkin model tidak support fitur ini — coba switch model di Settings.';
    } else if (err.message?.includes('MAX_TOKENS') || err.message?.includes('truncat') || err.message?.includes('JSON parse')) {
      state.analyzeError = 'Response terpotong (JSON tidak lengkap)';
      state.analyzeHint = 'Sudah diperbaiki di versi ini (maxOutputTokens dinaikkan). Coba retry — kalau masih terjadi, ganti ke model Gemini 2.5 Pro.';
    } else {
      state.analyzeError = err.message || 'Unknown error';
      state.analyzeHint = err.status ? `HTTP ${err.status}` : 'Cek koneksi & coba lagi.';
    }
  } finally {
    clearTimeout(timeoutId);
    _analysisAbortCtrl = null;
    state.analyzing = false;
    state.councilPhase = null;
    render();
  }
}

function cancelAnalysis() {
  if (_analysisAbortCtrl) {
    _analysisAbortCtrl.abort();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test API Key (langsung ke Gemini, no proxy)
// ─────────────────────────────────────────────────────────────────────────────
async function testApiKey() {
  const input = document.getElementById('api-key-input');
  const key = input ? input.value.trim() : state.apiKey;
  if (!key) {
    alert('Masukkan API key dulu');
    return;
  }

  state.testing = true;
  state.testResult = null;
  render();

  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);

    const r = await fetch(`${GEMINI_BASE}/${state.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with just: OK' }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(tid);

    const elapsed = Date.now() - t0;
    const bodyText = await r.text();
    let body;
    try { body = JSON.parse(bodyText); } catch (_) {}

    if (!r.ok) {
      const detail = body?.error?.message || bodyText.slice(0, 300);
      const gStatus = body?.error?.status || '';
      state.testResult = {
        ok: false,
        status: r.status,
        detail: (gStatus ? `[${gStatus}] ` : '') + detail,
        elapsedMs: elapsed,
      };
    } else {
      const cand = body?.candidates?.[0];
      const reply = cand?.content?.parts?.[0]?.text || '';
      state.testResult = {
        ok: true,
        status: 200,
        reply: reply.slice(0, 100),
        model: state.model,
        finishReason: cand?.finishReason,
        usage: body?.usageMetadata,
        elapsedMs: elapsed,
      };
    }
  } catch (e) {
    state.testResult = {
      ok: false,
      error: e.name === 'AbortError'
        ? `Test timeout ${TEST_TIMEOUT_MS / 1000}s — cek koneksi internet`
        : 'Network error: ' + e.message,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    state.testing = false;
    render();
    setTimeout(() => { const i = document.getElementById('api-key-input'); if (i) i.focus(); }, 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings actions
// ─────────────────────────────────────────────────────────────────────────────
function toggleSettings() {
  state.showSettings = !state.showSettings;
  state.testResult = null;
  if (!state.showSettings) {
    state.keyDraft = null;     // ← clear draft saat panel ditutup tanpa save
  }
  render();
}

function saveApiKey() {
  const input = document.getElementById('api-key-input');
  if (!input) return;
  const key = input.value.trim();
  if (!key) { alert('API key kosong'); return; }
  if (!key.startsWith('AIza')) {
    if (!confirm('Key biasanya diawali "AIza". Lanjut save?')) return;
  }
  state.apiKey = key;
  try { localStorage.setItem(STORAGE_KEY, key); } catch (_) {}
  state.keyDraft = null;       // ← clear draft (sudah saved ke state.apiKey)
  state.showSettings = false;
  state.analyzeError = null;
  state.analyzeHint = null;
  render();
}

function clearApiKey() {
  if (!confirm('Hapus API key dari browser?')) return;
  state.apiKey = '';
  state.keyDraft = null;       // ← clear draft juga
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  state.testResult = null;
  render();
}

function toggleShowKey() {
  state.showKeyValue = !state.showKeyValue;
  render();
  setTimeout(() => { const i = document.getElementById('api-key-input'); if (i) i.focus(); }, 0);
}

function selectModel(id) {
  state.model = id;
  try { localStorage.setItem(STORAGE_MODEL, id); } catch (_) {}
  state.testResult = null;
  render();
}

function toggleGrounding() {
  state.grounding = !state.grounding;
  try { localStorage.setItem(STORAGE_GROUNDING, state.grounding ? 'true' : 'false'); } catch (_) {}
  render();
}

function setMode(mode) {
  state.analysisMode = mode;
  try { localStorage.setItem(STORAGE_MODE, mode); } catch (_) {}
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
//  (View functions di bawah — di file terpisah `view.js`)
// ─────────────────────────────────────────────────────────────────────────────

// =============================================================================
//  VIEWS — semua functions yang return HTML strings
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
//  SVG helpers
// ─────────────────────────────────────────────────────────────────────────────
function sparkSVG(values, color = '#3b82f6', w = 600, h = 80) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="w-full h-full">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" />
  </svg>`;
}

function gaugeSVG(value) {
  if (value == null) return '';
  const angle = (value / 100) * 180 - 90;
  const color = value < 25 ? '#ef4444'
              : value < 45 ? '#f59e0b'
              : value < 55 ? '#eab308'
              : value < 75 ? '#84cc16'
              : '#22c55e';
  const dashLen = (value / 100) * 251;
  const x2 = 100 + 65 * Math.cos((angle - 90) * Math.PI / 180);
  const y2 = 100 + 65 * Math.sin((angle - 90) * Math.PI / 180);
  return `<svg viewBox="0 0 200 110" class="w-full h-full">
    <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="#27272a" stroke-width="8" fill="none" />
    <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="${color}" stroke-width="8" fill="none" stroke-dasharray="${dashLen} 251" stroke-linecap="round" />
    <line x1="100" y1="100" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fafafa" stroke-width="2" />
    <circle cx="100" cy="100" r="4" fill="#fafafa" />
  </svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings panel
// ─────────────────────────────────────────────────────────────────────────────
function viewSettings() {
  if (!state.showSettings) return '';

  const inputType = state.showKeyValue ? 'text' : 'password';

  const modelButtons = GEMINI_MODELS.map(m => {
    const active = state.model === m.id;
    const isPro = m.id === 'gemini-2.5-pro';
    return `<button onclick="window._app.selectModel('${m.id}')"
      class="text-left border ${active
        ? (isPro ? 'border-purple-500 bg-purple-500/10' : 'border-blue-500 bg-blue-500/10')
        : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} px-3 py-3 transition-colors relative">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-xs font-medium ${active ? (isPro ? 'text-purple-200' : 'text-blue-200') : 'text-zinc-300'}">${esc(m.label)}</span>
        <span class="text-[9px] ${m.badgeColor || 'text-zinc-500'} font-medium">${esc(m.badge || '')}</span>
      </div>
      <div class="text-[10px] text-zinc-500 sans mb-1.5">${esc(m.cost)} · ${esc(m.latency)}</div>
      <div class="text-[10px] text-zinc-600 sans leading-relaxed">${esc(m.desc || '')}</div>
      ${active ? `<div class="mt-1.5 text-[9px] ${isPro ? 'text-purple-400' : 'text-blue-400'} uppercase tracking-wider">● active</div>` : ''}
    </button>`;
  }).join('');

  const testBlock = (() => {
    if (!state.testResult) return '';
    const tr = state.testResult;
    if (tr.ok) {
      return `<div class="mt-2 border border-emerald-500/30 bg-emerald-500/5 p-3 text-[11px] sans">
        <div class="text-emerald-400 font-medium mb-1">✓ Connection OK · ${tr.elapsedMs}ms</div>
        <div class="text-zinc-400">Model: <code class="text-zinc-300">${esc(tr.model || '—')}</code></div>
        ${tr.reply ? `<div class="text-zinc-400 mt-1">Reply: <code class="text-zinc-300">${esc(tr.reply)}</code></div>` : ''}
        ${tr.usage ? `<div class="text-[10px] text-zinc-500 mt-1">Tokens: ${esc(JSON.stringify(tr.usage))}</div>` : ''}
      </div>`;
    }
    return `<div class="mt-2 border border-red-500/30 bg-red-500/5 p-3 text-[11px] sans">
      <div class="text-red-400 font-medium mb-1">✗ Test failed · status ${esc(tr.status || '—')}</div>
      ${tr.detail ? `<div class="text-zinc-400 break-words">${esc(tr.detail)}</div>` : ''}
      ${tr.error ? `<div class="text-zinc-400 break-words">${esc(tr.error)}</div>` : ''}
    </div>`;
  })();

  return `<div class="border-2 border-blue-500/40 bg-zinc-950 p-6 mb-3 slide-down">
    <div class="flex items-start justify-between mb-4">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="text-blue-400 text-lg">⚙</span>
          <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Settings · Gemini API</span>
        </div>
        <h2 class="serif text-2xl text-zinc-100">Configure <span class="italic text-blue-400">Google Gemini</span></h2>
      </div>
      <button onclick="window._app.toggleSettings()" class="text-zinc-500 hover:text-zinc-300 text-xl leading-none" title="Close">✕</button>
    </div>

    <!-- v5: Analysis Mode selector -->
    <div class="mb-5">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Analysis Mode</label>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        <button onclick="window._app.setMode('council')"
          class="text-left border ${state.analysisMode === 'council'
            ? 'border-purple-500 bg-purple-500/10'
            : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} px-3 py-3 transition-colors">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-xs font-medium ${state.analysisMode === 'council' ? 'text-purple-300' : 'text-zinc-300'}">⚖ Agent Council</span>
            ${state.analysisMode === 'council' ? '<span class="text-[9px] text-purple-400">● ACTIVE</span>' : ''}
          </div>
          <div class="text-[10px] text-zinc-500 sans leading-relaxed">Bull vs Bear berdebat → Judge timbang → Portfolio Manager putuskan. 4 AI call, ~30-50s. Lebih robust & transparan.</div>
        </button>
        <button onclick="window._app.setMode('quick')"
          class="text-left border ${state.analysisMode === 'quick'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} px-3 py-3 transition-colors">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-xs font-medium ${state.analysisMode === 'quick' ? 'text-blue-300' : 'text-zinc-300'}">⚡ Quick Analysis</span>
            ${state.analysisMode === 'quick' ? '<span class="text-[9px] text-blue-400">● ACTIVE</span>' : ''}
          </div>
          <div class="text-[10px] text-zinc-500 sans leading-relaxed">Single AI call. ~12-18s. Lebih cepat & hemat kuota, cocok untuk cek cepat.</div>
        </button>
      </div>
    </div>

    <!-- Model selection -->
    <div class="mb-5">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Choose Model</label>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-2">${modelButtons}</div>
      <div class="mt-2 text-[10px] text-zinc-600 sans">
        Council mode butuh ~30-50s dengan Flash · ~60-90s dengan Pro · Pro lebih dalam analisisnya
      </div>
    </div>

    <!-- v4: Google Search Grounding toggle -->
    <div class="mb-5">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Real-time Web Grounding</label>
      <button onclick="window._app.toggleGrounding()" class="w-full text-left border ${state.grounding
        ? 'border-emerald-500/50 bg-emerald-500/5'
        : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} p-3 transition-colors flex items-start justify-between gap-3">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xs font-medium ${state.grounding ? 'text-emerald-300' : 'text-zinc-300'}">Google Search Grounding</span>
            ${state.grounding ? '<span class="text-[9px] text-emerald-400">● ENABLED</span>' : '<span class="text-[9px] text-zinc-600">○ disabled</span>'}
          </div>
          <div class="text-[11px] text-zinc-500 sans leading-relaxed">
            Saat aktif, Gemini akan search web real-time untuk berita & event terbaru saat analisis. Sedikit lebih lambat (+3-8s), tapi catch event yang baru saja terjadi. Pakai key Gemini yang sama.
          </div>
        </div>
        <div class="w-10 h-6 rounded-full ${state.grounding ? 'bg-emerald-500/40' : 'bg-zinc-800'} relative transition-colors flex-shrink-0">
          <div class="absolute top-0.5 ${state.grounding ? 'right-0.5' : 'left-0.5'} w-5 h-5 rounded-full ${state.grounding ? 'bg-emerald-400' : 'bg-zinc-500'} transition-all"></div>
        </div>
      </button>
    </div>

    <!-- API Key input -->
    <div class="grid grid-cols-12 gap-4">
      <div class="col-span-12 md:col-span-8">
        <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">
          API Key
          ${state.apiKey
            ? `<span class="text-emerald-400 ml-2">● configured</span>`
            : `<span class="text-amber-400 ml-2">○ not set</span>`}
        </label>
        <div class="flex gap-2">
          <div class="flex-1 relative">
            <input
              id="api-key-input"
              type="${inputType}"
              value="${esc(state.keyDraft != null ? state.keyDraft : state.apiKey)}"
              placeholder="AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              class="w-full bg-black border border-zinc-700 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
              autocomplete="off"
              spellcheck="false"
            />
            <button onclick="window._app.toggleShowKey()" class="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-blue-400 px-2">
              ${state.showKeyValue ? 'Hide' : 'Show'}
            </button>
          </div>
          <button onclick="window._app.testApiKey()" ${state.testing ? 'disabled' : ''}
            class="border border-zinc-700 hover:border-zinc-500 px-4 py-2.5 text-[10px] uppercase tracking-[0.15em] text-zinc-300 transition-colors disabled:opacity-50">
            ${state.testing ? 'Testing...' : 'Test'}
          </button>
          <button onclick="window._app.saveApiKey()"
            class="bg-blue-500 hover:bg-blue-400 text-black px-5 py-2.5 text-[10px] uppercase tracking-[0.15em] font-medium transition-colors">
            Save
          </button>
        </div>
        ${testBlock}
        ${state.apiKey ? `<div class="mt-2 flex items-center gap-2 text-[11px]">
          <span class="text-zinc-500 sans">Saved: <code class="text-zinc-400">${esc(fmt.maskKey(state.apiKey))}</code></span>
          <span class="text-zinc-600">·</span>
          <button onclick="window._app.clearApiKey()" class="text-red-400/80 hover:text-red-400 uppercase tracking-wider">Clear</button>
        </div>` : `<div class="mt-2 text-[11px] text-zinc-500 sans">Belum ada key tersimpan</div>`}
      </div>

      <div class="col-span-12 md:col-span-4 text-xs text-zinc-400 sans space-y-2 border-l border-zinc-800 pl-4">
        <p class="text-zinc-300"><strong>Cara dapat key:</strong></p>
        <ol class="list-decimal list-inside space-y-1 text-zinc-500">
          <li>Buka <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="text-blue-400 hover:underline">aistudio.google.com</a></li>
          <li>Login dengan Google → Free tier aktif default</li>
          <li>Create API Key → copy → paste di sini</li>
        </ol>
        <div class="text-[10px] text-zinc-600 pt-2 border-t border-zinc-800/60 space-y-1">
          <p>🔒 Key disimpan di browser kamu (localStorage), tidak pernah ke server kami.</p>
          <p>⚡ Browser panggil Gemini API langsung — no proxy, no timeout Vercel.</p>
          <p>💸 Free tier: 1500 request/hari untuk Flash, cukup buat puluhan analisis.</p>
        </div>
      </div>
    </div>
  </div>`;
}

function viewApiKeyBadge() {
  const hasKey = !!state.apiKey;
  const cfg = hasKey
    ? { border: 'border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/60', dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'Gemini ✓' }
    : { border: 'border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20', dot: 'bg-blue-400 pulse-dot', text: 'text-blue-300', label: 'Setup Key' };
  return `<button onclick="window._app.toggleSettings()" class="flex items-center gap-1.5 px-2.5 py-1 border ${cfg.border} transition-colors">
    <span class="w-1.5 h-1.5 rounded-full ${cfg.dot}"></span>
    <span class="text-[10px] uppercase tracking-[0.15em] ${cfg.text}">${cfg.label}</span>
  </button>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trade Action Hero — kartu utama berisi LONG/SHORT/WAIT decision
// ─────────────────────────────────────────────────────────────────────────────
function viewTradeActionHero(analysis, currentPrice) {
  if (!analysis || !analysis.tradeAction) return '';
  const a = analysis.tradeAction;

  // Style per direction
  const cfg = {
    LONG:  { label: 'LONG',  sub: 'Buy & hold',   icon: '↗', border: 'border-emerald-500/50', bg: 'bg-emerald-500/[0.07]', text: 'text-emerald-400', glow: 'shadow-[0_0_60px_-15px_rgba(16,185,129,0.4)]' },
    SHORT: { label: 'SHORT', sub: 'Sell / short', icon: '↘', border: 'border-red-500/50',     bg: 'bg-red-500/[0.07]',     text: 'text-red-400',     glow: 'shadow-[0_0_60px_-15px_rgba(239,68,68,0.4)]'  },
    WAIT:  { label: 'WAIT',  sub: 'Stand aside',  icon: '⏸', border: 'border-amber-500/50',   bg: 'bg-amber-500/[0.07]',   text: 'text-amber-400',   glow: 'shadow-[0_0_60px_-15px_rgba(245,158,11,0.3)]' },
  };
  const c = cfg[a.direction] || cfg.WAIT;
  const isWait = a.direction === 'WAIT';
  const confColors = {
    LOW:    'text-zinc-400 border-zinc-700',
    MEDIUM: 'text-amber-400 border-amber-500/40',
    HIGH:   'text-emerald-400 border-emerald-500/40',
  };

  const meta = analysis._meta || {};

  // Compute risk/reward percentages dari entry midpoint
  const entryMid = (a.entryLow + a.entryHigh) / 2;
  const riskPct  = entryMid && a.stopLoss   ? Math.abs((a.stopLoss   - entryMid) / entryMid) * 100 : null;
  const rew1     = entryMid && a.takeProfit1 ? Math.abs((a.takeProfit1 - entryMid) / entryMid) * 100 : null;
  const rew2     = entryMid && a.takeProfit2 ? Math.abs((a.takeProfit2 - entryMid) / entryMid) * 100 : null;

  // Price ladder
  const kindStyles = {
    tp:    { dot: 'bg-emerald-500', text: 'text-emerald-400', accent: 'border-l-emerald-500' },
    now:   { dot: 'bg-blue-400',    text: 'text-blue-300',    accent: 'border-l-blue-400'    },
    entry: { dot: 'bg-purple-400',  text: 'text-purple-300',  accent: 'border-l-purple-400'  },
    sl:    { dot: 'bg-red-500',     text: 'text-red-400',     accent: 'border-l-red-500'     },
  };

  let levels = [];
  if (!isWait) {
    if (a.direction === 'LONG') {
      levels = [
        { p: a.takeProfit2, l: 'TP2',     k: 'tp',    s: 'Target 2'  },
        { p: a.takeProfit1, l: 'TP1',     k: 'tp',    s: 'Target 1'  },
        { p: currentPrice,  l: 'NOW',     k: 'now',   s: 'Spot'      },
        { p: a.entryHigh,   l: 'ENTRY ↑', k: 'entry', s: 'Entry top' },
        { p: a.entryLow,    l: 'ENTRY ↓', k: 'entry', s: 'Entry bot' },
        { p: a.stopLoss,    l: 'SL',      k: 'sl',    s: 'Stop loss' },
      ];
    } else {
      levels = [
        { p: a.stopLoss,    l: 'SL',      k: 'sl',    s: 'Stop loss' },
        { p: a.entryHigh,   l: 'ENTRY ↑', k: 'entry', s: 'Entry top' },
        { p: a.entryLow,    l: 'ENTRY ↓', k: 'entry', s: 'Entry bot' },
        { p: currentPrice,  l: 'NOW',     k: 'now',   s: 'Spot'      },
        { p: a.takeProfit1, l: 'TP1',     k: 'tp',    s: 'Target 1'  },
        { p: a.takeProfit2, l: 'TP2',     k: 'tp',    s: 'Target 2'  },
      ];
    }
  }

  const ladderHTML = levels.map(lv => {
    const s = kindStyles[lv.k];
    const showPct = lv.k !== 'now' && lv.k !== 'entry';
    const pct = showPct ? pctFrom(currentPrice, lv.p) : null;
    return `<div class="flex items-center gap-3 px-3 py-2 border-l-2 ${s.accent} bg-zinc-950/60">
      <div class="w-1.5 h-1.5 rounded-full ${s.dot}"></div>
      <div class="text-[10px] uppercase tracking-wider w-16 ${s.text}">${esc(lv.l)}</div>
      <div class="text-base text-zinc-100 tabular-nums flex-1">${esc(fmt.usd(lv.p))}</div>
      ${pct != null ? `<div class="text-xs tabular-nums ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(pct))}</div>` : ''}
      <div class="text-[10px] text-zinc-500 sans w-20 text-right">${esc(lv.s)}</div>
    </div>`;
  }).join('');

  return `<div class="border-2 ${c.border} ${c.bg} p-6 mb-3 ${c.glow}">
    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-5 pb-5 border-b border-zinc-800/60">
      <div class="flex items-center gap-4">
        <div class="text-5xl ${c.text}">${c.icon}</div>
        <div>
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Trade Action</span>
            <span class="text-[10px] text-zinc-600">·</span>
            <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">${esc(a.horizon || '1–3 hari')}</span>
            ${meta.model ? `<span class="text-[10px] text-zinc-600">·</span>
              <span class="text-[10px] uppercase tracking-[0.15em] text-blue-400">🅖 ${esc(meta.model)}</span>` : ''}
            ${meta.elapsedMs ? `<span class="text-[10px] text-zinc-600">·</span>
              <span class="text-[10px] text-zinc-500">${(meta.elapsedMs/1000).toFixed(1)}s</span>` : ''}
          </div>
          <div class="text-5xl tracking-tight leading-none ${c.text}">${c.label}</div>
          <div class="text-xs text-zinc-500 mt-2 sans">${esc(c.sub)}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 md:gap-3 items-start">
        ${viewCycleStageBadge(analysis)}
        <div class="border px-3 py-2 ${confColors[a.confidence] || confColors.LOW}">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Confidence</div>
          <div class="text-sm">${esc(a.confidence || 'LOW')}</div>
        </div>
        ${!isWait ? `<div class="border border-zinc-700 px-3 py-2">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Risk : Reward</div>
          <div class="text-sm text-zinc-100">1 : ${a.riskRewardRatio ? esc(a.riskRewardRatio.toFixed(1)) : '—'}</div>
        </div>` : ''}
        <div class="border border-zinc-700 px-3 py-2">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Position</div>
          <div class="text-sm text-zinc-100">${esc(a.positionSize || '—')}</div>
        </div>
      </div>
    </div>

    ${isWait ? `
      <div class="text-center py-8">
        <p class="text-sm text-zinc-300 leading-relaxed sans max-w-2xl mx-auto italic">${renderMd(a.actionReasoning || '')}</p>
        ${a.invalidationReason ? `<div class="mt-6 text-xs text-zinc-500 sans">
          <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">Watch for</span>${renderMd(a.invalidationReason || '')}
        </div>` : ''}
      </div>
    ` : `
      <div class="grid grid-cols-12 gap-6">
        <div class="col-span-12 md:col-span-6">
          <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Price Ladder</div>
          <div class="space-y-1">${ladderHTML}</div>
        </div>
        <div class="col-span-12 md:col-span-6 flex flex-col gap-4">
          <div>
            <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Reasoning</div>
            <p class="text-sm text-zinc-200 leading-relaxed sans">${renderMd(a.actionReasoning || '')}</p>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-2">
            <div class="border border-red-500/30 bg-red-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-red-400/80 mb-1">Risk</div>
              <div class="text-base text-red-400 tabular-nums">${riskPct ? '-' + riskPct.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to SL</div>
            </div>
            <div class="border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1">TP1</div>
              <div class="text-base text-emerald-400 tabular-nums">${rew1 ? '+' + rew1.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to target 1</div>
            </div>
            <div class="border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1">TP2</div>
              <div class="text-base text-emerald-400 tabular-nums">${rew2 ? '+' + rew2.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to target 2</div>
            </div>
          </div>
          ${a.invalidationReason ? `<div class="mt-1 pt-3 border-t border-zinc-800/60 text-xs text-zinc-400 sans leading-relaxed">
            <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">Invalidation</span>${renderMd(a.invalidationReason || '')}
          </div>` : ''}
        </div>
      </div>
    `}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Generic cards
// ─────────────────────────────────────────────────────────────────────────────
function viewPlaceholder(label) {
  return `<div class="border border-zinc-800 bg-zinc-950 p-5">
    <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">${esc(label)}</div>
    <div class="text-zinc-700 text-sm">No data</div>
  </div>`;
}

function viewMetric(label, value, sub, color = 'text-zinc-100') {
  return `<div class="border border-zinc-800 bg-zinc-950 p-4 hover:border-zinc-700 transition-colors">
    <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">${esc(label)}</div>
    <div class="text-xl tabular-nums ${color}">${esc(value)}</div>
    ${sub ? `<div class="text-[11px] text-zinc-500 mt-1">${esc(sub)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Price card (BTC spot + sparkline + 24h range)
// ─────────────────────────────────────────────────────────────────────────────
function viewPriceCard(snap) {
  if (!snap?.ticker) return viewPlaceholder('BTC / USD · Spot');
  const t  = snap.ticker;
  const cg = snap.coingecko || {};
  const g  = snap.global || {};
  const support    = snap.orderBook?.bids?.[0]?.price;
  const resistance = snap.orderBook?.asks?.[0]?.price;
  const pos = (support && resistance && t.price && resistance > support)
    ? Math.max(0, Math.min(100, ((t.price - support) / (resistance - support)) * 100))
    : 50;

  return `<div class="col-span-12 md:col-span-7 border border-zinc-800 bg-zinc-950 p-6">
    <div class="flex items-center justify-between mb-2">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">BTC / USDT · Live tick</span>
      <span class="text-[10px] text-zinc-600">Binance + CoinGecko</span>
    </div>
    <div class="flex items-baseline gap-4 mb-4">
      <div class="text-5xl tabular-nums text-zinc-100">${esc(fmt.usd(t.price))}</div>
      <div class="text-lg ${t.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'}">
        ${t.change24h >= 0 ? '▲' : '▼'} ${esc(fmt.pct(t.change24h))}
      </div>
    </div>
    <div class="h-20 mb-4">${snap.klines && snap.klines.length ? sparkSVG(snap.klines, '#3b82f6') : ''}</div>
    <div class="mb-4">
      <div class="flex justify-between text-[10px] text-zinc-500 mb-2">
        <span>BID WALL ${esc(fmt.usd(support))}</span>
        <span class="text-blue-400">NOW ${esc(fmt.usd(t.price))}</span>
        <span>ASK WALL ${esc(fmt.usd(resistance))}</span>
      </div>
      <div class="relative h-2 bg-zinc-900">
        <div class="absolute inset-y-0 left-0 bg-emerald-500/20" style="width: 15%"></div>
        <div class="absolute inset-y-0 right-0 bg-red-500/20" style="width: 15%"></div>
        <div class="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-400 rounded-full -ml-1.5" style="left: ${pos}%"></div>
      </div>
    </div>
    <div class="grid grid-cols-4 gap-3 pt-4 border-t border-zinc-800">
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">7d</div>
        <div class="text-sm ${cg.change7d >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(cg.change7d))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">30d</div>
        <div class="text-sm ${cg.change30d >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(cg.change30d))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">ATH dist</div>
        <div class="text-sm text-zinc-300">${esc(fmt.pct(cg.athDistance))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">Dominance</div>
        <div class="text-sm text-blue-400">${g.btcDominance ? esc(g.btcDominance.toFixed(2) + '%') : '—'}</div></div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Whale Walls card — visual order book
// ─────────────────────────────────────────────────────────────────────────────
function viewWhaleWalls(snap) {
  if (!snap?.orderBook) return viewPlaceholder('Whale Walls');
  const ob = snap.orderBook;
  const allWalls = [
    ...ob.bids.map(b => ({ ...b, side: 'bid' })),
    ...ob.asks.map(a => ({ ...a, side: 'ask' })),
  ].sort((a, b) => a.price - b.price);
  const maxTotal = Math.max(...allWalls.map(w => w.total), 1);

  return `<div class="col-span-12 md:col-span-5 border border-zinc-800 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Whale Wall Map</span>
      <span class="text-[10px] text-zinc-600">Binance top 10</span>
    </div>
    <div class="flex justify-between text-xs mb-3">
      <span class="text-emerald-400">BID $${(ob.bidWall / 1e6).toFixed(2)}M</span>
      <span class="text-zinc-500">${(ob.ratio * 100).toFixed(0)}% bid dominance</span>
      <span class="text-red-400">$${(ob.askWall / 1e6).toFixed(2)}M ASK</span>
    </div>
    <div class="space-y-1">
      ${allWalls.map(w => {
        const widthPct = (w.total / maxTotal) * 100;
        return `<div class="flex items-center gap-2 text-[10px]">
          <span class="w-20 tabular-nums text-zinc-400">${esc(fmt.usd(w.price))}</span>
          <div class="flex-1 h-3 bg-zinc-900 relative">
            <div class="absolute inset-y-0 left-0 ${w.side === 'bid' ? 'bg-emerald-500/60' : 'bg-red-500/60'}" style="width: ${widthPct}%"></div>
          </div>
          <span class="w-16 text-right tabular-nums ${w.side === 'bid' ? 'text-emerald-400' : 'text-red-400'}">$${(w.total / 1e6).toFixed(2)}M</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fear & Greed gauge
// ─────────────────────────────────────────────────────────────────────────────
function viewFearGreed(snap) {
  const fg = snap?.fearGreed;
  if (!fg) return viewPlaceholder('Fear & Greed');
  const color = fg.value < 25 ? '#ef4444'
              : fg.value < 45 ? '#f59e0b'
              : fg.value < 55 ? '#eab308'
              : fg.value < 75 ? '#84cc16'
              : '#22c55e';
  return `<div class="col-span-12 md:col-span-4 border border-zinc-800 bg-zinc-950 p-5 h-full">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Fear & Greed</span>
      <span class="text-[10px] text-zinc-600">alternative.me</span>
    </div>
    <div class="relative h-24 mb-2">${gaugeSVG(fg.value)}</div>
    <div class="text-center">
      <div class="text-3xl tabular-nums" style="color: ${color}">${esc(fg.value)}</div>
      <div class="text-xs uppercase tracking-wider text-zinc-400 mt-1">${esc(fg.label || '')}</div>
    </div>
    ${fg.history && fg.history.length ? `<div class="h-10 mt-3">${sparkSVG(fg.history.map(h => h.v), color, 200, 40)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signal chip (AI sentiment + reasoning)
// ─────────────────────────────────────────────────────────────────────────────
function viewSignal(analysis) {
  if (!analysis?.signal) return '';
  const map = {
    STRONG_BUY: { label: 'STRONG BUY', klass: 'text-emerald-400 border-emerald-500/40' },
    BUY:        { label: 'BUY',        klass: 'text-green-400 border-green-500/40' },
    NEUTRAL:    { label: 'NEUTRAL',    klass: 'text-amber-400 border-amber-500/40' },
    CAUTION:    { label: 'CAUTION',    klass: 'text-orange-400 border-orange-500/40' },
    AVOID:      { label: 'AVOID',      klass: 'text-red-400 border-red-500/40' },
  };
  const m = map[analysis.signal] || map.NEUTRAL;
  const textClass = m.klass.split(' ')[0];
  return `<div class="col-span-12 md:col-span-8 border ${m.klass} bg-zinc-950 p-5">
    <div class="flex items-baseline justify-between mb-2">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Sentiment Signal</span>
      <span class="text-[10px] text-zinc-600">snapshot + AI</span>
    </div>
    <div class="text-2xl mb-3 ${textClass}">${esc(m.label)}</div>
    <ul class="space-y-1.5 text-xs">
      ${(analysis.signalReasoning || []).slice(0, 3).map(r =>
        `<li class="text-zinc-400 leading-relaxed"><span class="opacity-60">→ </span>${renderMd(r)}</li>`
      ).join('')}
    </ul>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Whale Summary + News headlines
// ─────────────────────────────────────────────────────────────────────────────
function viewWhaleNews(analysis) {
  if (!analysis) return '';
  return `<div class="col-span-12 border border-zinc-800 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Whale & Smart Money · 24h</span>
      <span class="text-[10px] text-zinc-600">snapshot data + CryptoCompare news</span>
    </div>
    <p class="text-sm text-zinc-300 leading-relaxed sans mb-4">${renderMd(analysis.whaleSummary || '—')}</p>
    <div class="pt-3 border-t border-zinc-800">
      <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Top Headlines</div>
      <ul class="space-y-1.5">
        ${(analysis.newsHeadlines || []).map((h, i) => `<li class="text-xs text-zinc-400 leading-relaxed sans">
          <span class="text-blue-400/60 mr-2">${String(i + 1).padStart(2, '0')}</span>${esc(h)}
        </li>`).join('')}
      </ul>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v3: Derivatives Intelligence card (OI + L/S + Taker)
// ─────────────────────────────────────────────────────────────────────────────
function viewDerivativesCard(snap, analysis) {
  const oi = snap?.openInterest;
  const ls = snap?.longShort;
  const tv = snap?.takerVolume;
  if (!oi && !ls && !tv) return '';

  // OI confluence with price
  const priceUp = (snap.ticker?.change24h ?? 0) > 0;
  let oiConfluence = { label: '—', class: 'text-zinc-400', hint: '' };
  if (oi) {
    if (oi.change24h > 2 && priceUp) oiConfluence = { label: 'NEW MONEY', class: 'text-emerald-400', hint: 'trend valid · whales open longs' };
    else if (oi.change24h < -2 && priceUp) oiConfluence = { label: 'SHORT SQUEEZE', class: 'text-amber-400', hint: 'rally lemah · shorts cover' };
    else if (oi.change24h > 2 && !priceUp) oiConfluence = { label: 'NEW SHORTS', class: 'text-red-400', hint: 'bearish confirm · whales short' };
    else if (oi.change24h < -2 && !priceUp) oiConfluence = { label: 'LONG CAPITULATE', class: 'text-orange-400', hint: 'longs surrender · selling pressure' };
    else oiConfluence = { label: 'NEUTRAL FLOW', class: 'text-zinc-400', hint: 'no significant flow' };
  }

  // Smart money bias styling
  const biasMap = {
    LONG:                     { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: 'BIAS LONG' },
    SHORT:                    { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: 'BIAS SHORT' },
    SMART_LONG_RETAIL_SHORT:  { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/50', label: 'CONTRARIAN LONG' },
    SMART_SHORT_RETAIL_LONG:  { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/50',     label: 'CONTRARIAN SHORT' },
    NEUTRAL:                  { color: 'text-zinc-400',    bg: 'bg-zinc-800/40',    border: 'border-zinc-700',       label: 'NEUTRAL' },
  };
  const bias = ls ? biasMap[ls.smartMoneyBias] || biasMap.NEUTRAL : null;

  // Taker visual
  const takerPos = tv ? Math.min(Math.max((tv.current - 0.7) / 0.6, 0), 1) * 100 : 50;
  const takerLabel = tv && tv.current > 1.1 ? 'BUYERS AGGRESSIVE'
                   : tv && tv.current < 0.9 ? 'SELLERS AGGRESSIVE'
                   : 'BALANCED';
  const takerColor = tv && tv.current > 1.1 ? 'text-emerald-400'
                   : tv && tv.current < 0.9 ? 'text-red-400'
                   : 'text-zinc-400';

  return `<div class="col-span-12 border border-purple-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-purple-300">Derivatives Intelligence · NEW v3</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Binance Futures — OI · Long/Short · Taker flow</div>
      </div>
      <span class="text-[10px] text-zinc-600">smart money lens</span>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">

      <!-- Open Interest -->
      ${oi ? `<div class="border border-zinc-800 bg-zinc-950/40 p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Open Interest 24h</span>
          <span class="text-[10px] ${oiConfluence.class}">${oiConfluence.label}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-1">$${(oi.current / 1e9).toFixed(2)}<span class="text-sm text-zinc-500">B</span></div>
        <div class="flex items-center gap-2 mb-2">
          <span class="text-sm tabular-nums ${oi.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'}">${oi.change24h >= 0 ? '+' : ''}${oi.change24h.toFixed(2)}%</span>
          <span class="text-[10px] text-zinc-500 sans">vs 24h ago</span>
        </div>
        <div class="text-[11px] text-zinc-400 sans italic">${esc(oiConfluence.hint)}</div>
      </div>` : ''}

      <!-- Long/Short ratio -->
      ${ls ? `<div class="border ${bias.border} ${bias.bg} p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Long/Short Bias</span>
          <span class="text-[10px] ${bias.color} font-medium">${bias.label}</span>
        </div>
        <div class="space-y-2 mb-2">
          <div class="flex items-center justify-between">
            <span class="text-[10px] text-zinc-500 uppercase">Smart money</span>
            <div class="flex items-center gap-2">
              <span class="text-base tabular-nums ${ls.topTrader.current > 1 ? 'text-emerald-400' : 'text-red-400'}">${ls.topTrader.current.toFixed(2)}</span>
              <span class="text-[9px] text-zinc-600">${ls.topTrader.trend === 'RISING' ? '↗' : '↘'}</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-[10px] text-zinc-500 uppercase">Retail</span>
            <div class="flex items-center gap-2">
              <span class="text-base tabular-nums ${ls.global.current > 1 ? 'text-emerald-400' : 'text-red-400'}">${ls.global.current.toFixed(2)}</span>
              <span class="text-[9px] text-zinc-600">${ls.global.trend === 'RISING' ? '↗' : '↘'}</span>
            </div>
          </div>
        </div>
        <div class="text-[11px] text-zinc-400 sans pt-2 border-t border-zinc-800/60">
          Divergence: <span class="${Math.abs(ls.divergence) > 0.3 ? 'text-amber-400' : 'text-zinc-400'} tabular-nums">${ls.divergence >= 0 ? '+' : ''}${ls.divergence.toFixed(2)}</span>
          ${Math.abs(ls.divergence) > 0.5 ? '<span class="text-amber-400 ml-1">⚠</span>' : ''}
        </div>
      </div>` : ''}

      <!-- Taker volume -->
      ${tv ? `<div class="border border-zinc-800 bg-zinc-950/40 p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Taker Flow 24h</span>
          <span class="text-[10px] ${takerColor}">${takerLabel}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-2">${tv.current.toFixed(2)}<span class="text-sm text-zinc-500"> ratio</span></div>
        <div class="h-2 bg-zinc-900 relative mb-2">
          <div class="absolute inset-y-0 left-1/2 w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 w-2 -ml-1 ${tv.current > 1 ? 'bg-emerald-400' : 'bg-red-400'}" style="left: ${takerPos}%"></div>
        </div>
        <div class="flex justify-between text-[9px] text-zinc-600 mb-2">
          <span>0.7 sell</span><span>1.0</span><span>1.3 buy</span>
        </div>
        <div class="text-[11px] text-zinc-400 sans italic">trend: ${tv.trend.toLowerCase().replace('_', ' ')}</div>
      </div>` : ''}

    </div>

    ${analysis?.derivativesView ? `<div class="mt-4 pt-4 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-purple-400/80 mb-2">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.derivativesView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v3: Technical Indicators card (RSI + MACD + BB + EMA per TF)
// ─────────────────────────────────────────────────────────────────────────────
function viewTechnicalCard(snap, analysis) {
  const ind = snap?.indicators;
  const conf = snap?.confluence;
  if (!ind) return '';

  const tfBlock = (tf, label) => {
    const i = ind[tf];
    if (!i) return `<div class="border border-zinc-800 bg-zinc-950/40 p-3 opacity-50 text-center">
      <div class="text-[10px] uppercase text-zinc-500">${label}</div>
      <div class="text-xs text-zinc-600 mt-2">data tidak tersedia</div>
    </div>`;

    const trendCfg = i.trend === 'BULLISH' ? { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', icon: '▲' }
                   : i.trend === 'BEARISH' ? { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     icon: '▼' }
                   :                          { color: 'text-zinc-400',   bg: 'bg-zinc-800/30',    border: 'border-zinc-700',       icon: '◆' };

    const rsiColor = i.rsi >= 70 ? '#ef4444' : i.rsi <= 30 ? '#22c55e' : i.rsi >= 60 ? '#84cc16' : i.rsi <= 40 ? '#f97316' : '#a1a1aa';
    const rsiLabel = i.rsi >= 70 ? 'OB' : i.rsi <= 30 ? 'OS' : i.rsi >= 60 ? 'BULL' : i.rsi <= 40 ? 'BEAR' : '—';
    const rsiPct = Math.min(Math.max(i.rsi, 0), 100);

    const bbPos = i.bb ? Math.min(Math.max(i.bb.position * 100, 0), 100) : 50;
    const bbSqueeze = i.bb && i.bb.widthPct < 4;

    return `<div class="border ${trendCfg.border} ${trendCfg.bg} p-3">
      <div class="flex items-center justify-between mb-3">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">${label}</span>
        <div class="flex items-center gap-1 ${trendCfg.color}">
          <span class="text-xs">${trendCfg.icon}</span>
          <span class="text-[10px] font-medium">${i.trend}</span>
        </div>
      </div>

      <!-- RSI -->
      <div class="mb-3">
        <div class="flex items-center justify-between text-[10px] mb-1">
          <span class="text-zinc-500">RSI 14</span>
          <span class="tabular-nums" style="color: ${rsiColor}">${i.rsi != null ? i.rsi.toFixed(1) : '—'} <span class="text-[9px]">${rsiLabel}</span></span>
        </div>
        <div class="h-1.5 bg-zinc-900 relative">
          <div class="absolute inset-y-0 left-[30%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[70%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-0" style="width: ${rsiPct}%; background: ${rsiColor}"></div>
        </div>
      </div>

      <!-- MACD -->
      ${i.macd ? `<div class="mb-3">
        <div class="flex items-center justify-between text-[10px]">
          <span class="text-zinc-500">MACD</span>
          <div class="flex items-center gap-2">
            <span class="${i.macd.bullish ? 'text-emerald-400' : 'text-red-400'}">${i.macd.bullish ? 'BULL' : 'BEAR'}</span>
            <span class="text-zinc-600">${i.macd.momentum === 'RISING' ? '↗' : '↘'}</span>
          </div>
        </div>
        <div class="text-[10px] text-zinc-600 tabular-nums">hist ${i.macd.histogram.toFixed(2)}</div>
      </div>` : ''}

      <!-- Bollinger position -->
      ${i.bb ? `<div class="mb-2">
        <div class="flex items-center justify-between text-[10px] mb-1">
          <span class="text-zinc-500">BB pos</span>
          <span class="text-zinc-400 tabular-nums">${(i.bb.position * 100).toFixed(0)}%${bbSqueeze ? ' <span class="text-amber-400">SQZ</span>' : ''}</span>
        </div>
        <div class="h-1 bg-zinc-900 relative">
          <div class="absolute inset-y-0 w-1 -ml-0.5 bg-blue-400" style="left: ${bbPos}%"></div>
        </div>
      </div>` : ''}

      <!-- EMA -->
      <div class="text-[10px] text-zinc-600 sans pt-2 border-t border-zinc-800/40 tabular-nums">
        EMA21 ${i.ema21 ? '$' + i.ema21.toFixed(0) : '—'}<br>
        EMA55 ${i.ema55 ? '$' + i.ema55.toFixed(0) : '—'}${i.ema200 ? '<br>EMA200 $' + i.ema200.toFixed(0) : ''}
      </div>
    </div>`;
  };

  // Confluence summary
  const confCfg = !conf ? null
    : conf.alignment === 'STRONG_BULL' ? { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: '⚡ STRONG BULL — all 3 TF aligned', hint: 'tightest confluence · highest confidence' }
    : conf.alignment === 'STRONG_BEAR' ? { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: '⚡ STRONG BEAR — all 3 TF aligned', hint: 'tightest confluence · highest confidence' }
    : conf.alignment === 'BULL'        ? { color: 'text-emerald-400', bg: 'bg-emerald-500/5',  border: 'border-emerald-500/30', label: 'BULL — 2 of 3 TF aligned',          hint: 'medium confluence' }
    : conf.alignment === 'BEAR'        ? { color: 'text-red-400',     bg: 'bg-red-500/5',      border: 'border-red-500/30',     label: 'BEAR — 2 of 3 TF aligned',          hint: 'medium confluence' }
    :                                    { color: 'text-amber-400',   bg: 'bg-amber-500/5',    border: 'border-amber-500/30',   label: 'MIXED — no clear direction',        hint: 'wait for confluence' };

  return `<div class="col-span-12 border border-blue-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-blue-300">Technical Analysis · NEW v3</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Multi-timeframe · pre-computed (RSI · MACD · BB · EMA)</div>
      </div>
      <span class="text-[10px] text-zinc-600">self-computed from klines</span>
    </div>

    ${confCfg ? `<div class="border ${confCfg.border} ${confCfg.bg} p-3 mb-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-sm ${confCfg.color} font-medium">${esc(confCfg.label)}</div>
          <div class="text-[11px] text-zinc-500 sans mt-1">${esc(confCfg.hint)}</div>
        </div>
        <div class="flex gap-1 text-[10px]">
          <span class="px-2 py-1 ${conf.bullish > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-900 text-zinc-600'} rounded">${conf.bullish} bull</span>
          <span class="px-2 py-1 ${conf.bearish > 0 ? 'bg-red-500/20 text-red-400' : 'bg-zinc-900 text-zinc-600'} rounded">${conf.bearish} bear</span>
          <span class="px-2 py-1 ${conf.neutral > 0 ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-900 text-zinc-600'} rounded">${conf.neutral} neut</span>
        </div>
      </div>
    </div>` : ''}

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      ${tfBlock('h1', '1H · short-term')}
      ${tfBlock('h4', '4H · swing')}
      ${tfBlock('d1', '1D · position')}
    </div>

    ${analysis?.technicalView ? `<div class="mt-4 pt-4 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-blue-400/80 mb-2">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.technicalView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: Options Flow card (Deribit PCR + Max Pain)
// ─────────────────────────────────────────────────────────────────────────────
function viewOptionsCard(snap, analysis) {
  const o = snap?.options;
  if (!o) return '';

  const signalCfg = {
    BULLISH_HEAVY: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: 'BULLISH HEAVY', hint: 'calls dominant — kemungkinan extreme, watch contrarian' },
    BULLISH:       { color: 'text-emerald-400', bg: 'bg-emerald-500/5',  border: 'border-emerald-500/30', label: 'BULLISH',       hint: 'options market lean bullish' },
    NEUTRAL:       { color: 'text-zinc-400',    bg: 'bg-zinc-800/30',    border: 'border-zinc-700',       label: 'NEUTRAL',       hint: 'balanced positioning' },
    BEARISH:       { color: 'text-red-400',     bg: 'bg-red-500/5',      border: 'border-red-500/30',     label: 'BEARISH',       hint: 'puts dominant — hedging atau bearish bias' },
    BEARISH_HEAVY: { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: 'BEARISH HEAVY', hint: 'puts dominant — kemungkinan capitulation' },
  };
  const cfg = signalCfg[o.pcrSignal] || signalCfg.NEUTRAL;

  // Max pain magnet visualization
  const currentPrice = snap.ticker?.price || o.underlying;
  const maxPain = o.maxPain;
  const gap = o.maxPainGap;
  const magnetColor = gap == null ? 'text-zinc-400'
                    : Math.abs(gap) < 1   ? 'text-emerald-400'
                    : Math.abs(gap) < 3   ? 'text-amber-400'
                    : 'text-red-400';

  const daysToExpiry = o.nearestExpiry
    ? Math.max(0, Math.ceil((o.nearestExpiry - Date.now()) / (24 * 3600 * 1000)))
    : null;
  const expiryDate = o.nearestExpiry ? new Date(o.nearestExpiry).toISOString().slice(0, 10) : '—';

  return `<div class="col-span-12 md:col-span-6 border border-amber-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-amber-300">Options Flow · NEW v4</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Deribit · Put/Call ratio + Max pain magnet</div>
      </div>
      <span class="text-[10px] text-zinc-600">${o.optionsCount} contracts</span>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <!-- PCR Block -->
      <div class="border ${cfg.border} ${cfg.bg} p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">P/C Ratio</span>
          <span class="text-[9px] ${cfg.color} font-medium">${cfg.label}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-1">${o.pcrOI != null ? o.pcrOI.toFixed(2) : '—'}</div>
        <div class="text-[10px] text-zinc-500 sans mb-2">by open interest</div>
        <div class="text-[10px] text-zinc-400 tabular-nums">${o.pcrVolume != null ? o.pcrVolume.toFixed(2) : '—'} <span class="text-zinc-600">vol</span></div>
        <div class="text-[10px] text-zinc-600 sans mt-1 italic">${esc(cfg.hint)}</div>
      </div>

      <!-- Max Pain Block -->
      <div class="border border-zinc-800 bg-zinc-950/40 p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Max Pain</span>
          <span class="text-[9px] text-amber-400">${daysToExpiry != null ? daysToExpiry + 'd' : '—'} expiry</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-1">${maxPain ? '$' + maxPain.toLocaleString() : '—'}</div>
        <div class="text-[10px] ${magnetColor} tabular-nums">${gap != null ? (gap >= 0 ? '+' : '') + gap.toFixed(2) + '% from spot' : ''}</div>
        <div class="text-[10px] text-zinc-500 sans mt-2">expiry ${expiryDate}</div>
        <div class="text-[10px] text-zinc-600 sans mt-1 italic">${
          gap == null ? '' :
          Math.abs(gap) < 1 ? 'sudah di magnet — kemungkinan pinned' :
          Math.abs(gap) < 3 ? 'price magnet aktif — bisa tarik harga' :
          'gap besar — magnet effect lebih lemah'
        }</div>
      </div>
    </div>

    <!-- Call vs Put OI bar -->
    <div class="mt-3">
      <div class="flex justify-between text-[10px] text-zinc-500 mb-1">
        <span>Calls $${(o.callOI / 1000).toFixed(1)}K</span>
        <span>Puts $${(o.putOI / 1000).toFixed(1)}K</span>
      </div>
      <div class="h-2 bg-zinc-900 flex overflow-hidden">
        <div class="bg-emerald-500/60" style="width: ${(o.callOI / (o.callOI + o.putOI || 1)) * 100}%"></div>
        <div class="bg-red-500/60 flex-1"></div>
      </div>
    </div>

    ${analysis?.optionsView ? `<div class="mt-3 pt-3 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-amber-400/80 mb-1.5">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.optionsView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: On-Chain Cycle card (CoinMetrics MVRV)
// ─────────────────────────────────────────────────────────────────────────────
function viewOnChainCard(snap, analysis) {
  const oc = snap?.onChain;
  if (!oc) return '';

  const cycleCfg = {
    CYCLE_BOTTOM: { color: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/50', icon: '⬇', label: 'CYCLE BOTTOM', hint: 'historical buy zone — rare opportunity' },
    UNDERVALUED:  { color: 'text-emerald-400', bg: 'bg-emerald-500/5',  border: 'border-emerald-500/30', icon: '↓', label: 'UNDERVALUED',  hint: 'below market cost basis' },
    FAIR_VALUE:   { color: 'text-blue-400',    bg: 'bg-blue-500/5',     border: 'border-blue-500/30',    icon: '◆', label: 'FAIR VALUE',   hint: 'at market cost basis' },
    BULLISH:      { color: 'text-blue-400',    bg: 'bg-blue-500/5',     border: 'border-blue-500/30',    icon: '↑', label: 'BULLISH',      hint: 'healthy bull range' },
    OVERVALUED:   { color: 'text-orange-400',  bg: 'bg-orange-500/5',   border: 'border-orange-500/30',  icon: '⬆', label: 'OVERVALUED',   hint: 'caution — late-cycle' },
    CYCLE_TOP:    { color: 'text-red-400',     bg: 'bg-red-500/15',     border: 'border-red-500/50',    icon: '⚠', label: 'CYCLE TOP',     hint: 'historical sell zone — extreme overheated' },
  };
  const cfg = cycleCfg[oc.mvrvSignal] || cycleCfg.FAIR_VALUE;

  // MVRV scale visualization (0.5 to 4.0)
  const mvrvPct = Math.min(Math.max((oc.mvrv - 0.5) / 3.5, 0), 1) * 100;
  const currentPrice = snap.ticker?.price;
  const realizedPremium = oc.realizedPrice && currentPrice
    ? ((currentPrice - oc.realizedPrice) / oc.realizedPrice) * 100
    : null;

  return `<div class="col-span-12 md:col-span-6 border border-emerald-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-emerald-300">On-Chain Cycle · NEW v4</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">CoinMetrics · MVRV ratio + Realized Price</div>
      </div>
      <span class="text-[10px] text-zinc-600">daily update</span>
    </div>

    <div class="grid grid-cols-2 gap-3 mb-4">
      <!-- MVRV main metric -->
      <div class="border ${cfg.border} ${cfg.bg} p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">MVRV ratio</span>
          <span class="text-[9px] ${cfg.color}">${cfg.icon} ${cfg.label}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-2">${oc.mvrv != null ? oc.mvrv.toFixed(2) : '—'}</div>
        <!-- MVRV scale -->
        <div class="h-1.5 bg-zinc-900 relative">
          <div class="absolute inset-y-0 left-[14%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[29%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[57%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[86%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 w-1.5 -ml-0.5 ${cfg.color.replace('text-', 'bg-')}" style="left: ${mvrvPct}%"></div>
        </div>
        <div class="flex justify-between text-[9px] text-zinc-600 mt-1">
          <span>0.5</span><span>1</span><span>2.5</span><span>3.5</span>
        </div>
      </div>

      <!-- Realized Price -->
      <div class="border border-zinc-800 bg-zinc-950/40 p-3">
        <div class="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Realized Price</div>
        <div class="text-base tabular-nums text-zinc-100 mb-2">$${oc.realizedPrice ? Number(oc.realizedPrice).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</div>
        <div class="text-[10px] text-zinc-500 sans mb-1">market avg cost basis</div>
        ${realizedPremium != null ? `<div class="text-[11px] tabular-nums ${realizedPremium >= 0 ? 'text-emerald-400' : 'text-red-400'}">${realizedPremium >= 0 ? '+' : ''}${realizedPremium.toFixed(1)}% premium</div>` : ''}
        <div class="text-[10px] text-zinc-600 sans mt-1 italic">${realizedPremium != null
          ? (realizedPremium > 100 ? 'high premium — bull market'
            : realizedPremium > 30 ? 'healthy bull range'
            : realizedPremium > 0 ? 'modest premium'
            : 'below cost basis — bear territory')
          : ''}</div>
      </div>
    </div>

    <div class="text-[10px] text-zinc-500 sans pt-2 border-t border-zinc-800/60">
      <span class="text-emerald-400/80 uppercase tracking-wider mr-2">Reference</span>${esc(cfg.hint)}
    </div>

    ${analysis?.onChainView ? `<div class="mt-3 pt-3 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1.5">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.onChainView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: Macro Context card (DXY + Gold + SPX)
// ─────────────────────────────────────────────────────────────────────────────
function viewMacroCard(snap, analysis) {
  const m = snap?.macro;
  if (!m) return '';

  const regimeCfg = {
    RISK_OFF:           { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: 'RISK OFF',         hint: 'DXY↑ + SPX↓ → BTC headwind' },
    DOLLAR_STRENGTH:    { color: 'text-orange-400',  bg: 'bg-orange-500/5',   border: 'border-orange-500/30',  label: 'DOLLAR STRONG',    hint: 'USD rally → BTC headwind' },
    NEUTRAL:            { color: 'text-zinc-400',    bg: 'bg-zinc-800/30',    border: 'border-zinc-700',       label: 'NEUTRAL',          hint: 'macro balanced' },
    DOLLAR_WEAKNESS:    { color: 'text-blue-400',    bg: 'bg-blue-500/5',     border: 'border-blue-500/30',    label: 'DOLLAR WEAK',      hint: 'USD slip → BTC tailwind' },
    RISK_ON:            { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: 'RISK ON',          hint: 'DXY↓ + SPX↑ → BTC tailwind' },
  };
  const cfg = regimeCfg[m.riskRegime] || regimeCfg.NEUTRAL;

  const metricBox = (label, data, inverseToBTC = false) => {
    if (!data) return `<div class="border border-zinc-800 bg-zinc-950/40 p-3 opacity-50 text-center">
      <div class="text-[10px] uppercase text-zinc-500">${label}</div>
      <div class="text-xs text-zinc-600 mt-2">N/A</div>
    </div>`;
    const positive = data.changePct >= 0;
    const goodForBTC = inverseToBTC ? !positive : positive;
    return `<div class="border border-zinc-800 bg-zinc-950/40 p-3">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">${label}</span>
        ${inverseToBTC ? '<span class="text-[9px] text-zinc-600" title="Inverse correlation to BTC">↔ inv</span>' : ''}
      </div>
      <div class="text-lg tabular-nums text-zinc-100">${typeof data.close === 'number' ? data.close.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</div>
      <div class="text-[11px] tabular-nums ${positive ? 'text-emerald-400' : 'text-red-400'}">${positive ? '+' : ''}${data.changePct != null ? data.changePct.toFixed(2) : '0'}%</div>
      <div class="text-[9px] mt-1 ${goodForBTC ? 'text-emerald-500/70' : 'text-red-500/70'}">${goodForBTC ? '↗ BTC favorable' : '↘ BTC pressure'}</div>
    </div>`;
  };

  return `<div class="col-span-12 border border-cyan-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-cyan-300">Macro Context · NEW v4</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Stooq · DXY · Gold · S&P 500 correlation</div>
      </div>
      <div class="border ${cfg.border} ${cfg.bg} px-3 py-1.5">
        <span class="text-[10px] uppercase tracking-wider ${cfg.color} font-medium">${cfg.label}</span>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-3 mb-3">
      ${metricBox('DXY · Dollar Index', m.dxy, true)}
      ${metricBox('Gold · USD/oz', m.gold, false)}
      ${metricBox('S&P 500', m.spx, false)}
    </div>

    <div class="text-[11px] text-zinc-500 sans pt-2 border-t border-zinc-800/60">
      <span class="text-cyan-400/80 uppercase tracking-wider mr-2">Regime</span>${esc(cfg.hint)}
    </div>

    ${analysis?.macroView ? `<div class="mt-3 pt-3 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-cyan-400/80 mb-1.5">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.macroView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: Cycle Stage chip (shown inside trade action hero header)
// ─────────────────────────────────────────────────────────────────────────────
function viewCycleStageBadge(analysis) {
  if (!analysis?.cycleStage) return '';
  const stages = {
    ACCUMULATION:  { color: 'text-emerald-300', bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', label: 'ACCUMULATION' },
    MARKUP:        { color: 'text-emerald-200', bg: 'bg-emerald-500/25', border: 'border-emerald-500/50', label: 'MARKUP' },
    DISTRIBUTION:  { color: 'text-orange-300',  bg: 'bg-orange-500/15',  border: 'border-orange-500/40',  label: 'DISTRIBUTION' },
    MARKDOWN:      { color: 'text-red-300',     bg: 'bg-red-500/15',     border: 'border-red-500/40',     label: 'MARKDOWN' },
    UNCLEAR:       { color: 'text-zinc-400',    bg: 'bg-zinc-800/40',    border: 'border-zinc-700',       label: 'UNCLEAR PHASE' },
  };
  const s = stages[analysis.cycleStage] || stages.UNCLEAR;
  return `<div class="border ${s.border} ${s.bg} px-3 py-2">
    <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Cycle Stage</div>
    <div class="text-sm ${s.color}">${s.label}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v5: Debate Transcript card (Bull vs Bear vs Judge)
// ─────────────────────────────────────────────────────────────────────────────
function viewDebateCard(analysis) {
  const d = analysis?.debate;
  if (!d) return '';
  const judge = d.judge || {};

  const leanCfg = judge.lean === 'BULLISH' ? { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40' }
                : judge.lean === 'BEARISH' ? { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40' }
                :                            { color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/40' };
  const conviction = judge.conviction != null ? Math.round(judge.conviction) : null;

  return `<div class="col-span-12 border border-purple-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-purple-300">Agent Council Debate · v5</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Bull vs Bear → Research Manager verdict</div>
      </div>
      <span class="text-[10px] text-zinc-600">multi-agent reasoning</span>
    </div>

    <!-- items-start: tiap kolom tingginya mengikuti kontennya sendiri, tidak force equal-height -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 items-start">
      <!-- Bull case -->
      <div class="border border-emerald-500/30 bg-emerald-500/[0.04] p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-emerald-400 text-sm">▲</span>
          <span class="text-[10px] uppercase tracking-wider text-emerald-400 font-medium">Bull Researcher</span>
        </div>
        <div class="text-xs text-zinc-300 sans leading-relaxed">${renderMd(d.bullCase || '—')}</div>
      </div>
      <!-- Bear case -->
      <div class="border border-red-500/30 bg-red-500/[0.04] p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-red-400 text-sm">▼</span>
          <span class="text-[10px] uppercase tracking-wider text-red-400 font-medium">Bear Researcher</span>
        </div>
        <div class="text-xs text-zinc-300 sans leading-relaxed">${renderMd(d.bearCase || '—')}</div>
      </div>
    </div>

    <!-- Judge verdict -->
    <div class="border ${leanCfg.border} ${leanCfg.bg} p-4">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div class="flex items-center gap-2">
          <span class="${leanCfg.color} text-sm">⚖</span>
          <span class="text-[10px] uppercase tracking-wider ${leanCfg.color} font-medium">Research Manager verdict</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-sm ${leanCfg.color} font-medium">${esc(judge.lean || '—')}</span>
          ${conviction != null ? `<div class="flex items-center gap-1.5">
            <div class="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div class="h-full ${leanCfg.color.replace('text-', 'bg-')}" style="width: ${conviction}%"></div>
            </div>
            <span class="text-[10px] text-zinc-400 tabular-nums">${conviction}%</span>
          </div>` : ''}
        </div>
      </div>
      <div class="text-xs text-zinc-300 sans leading-relaxed mb-3">${renderMd(judge.summary || '')}</div>
      ${(judge.decidingFactors && judge.decidingFactors.length) ? `<div class="mt-2 pt-3 border-t border-zinc-800/60">
        <div class="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Faktor penentu</div>
        <ul class="space-y-1.5">
          ${judge.decidingFactors.slice(0, 3).map(f => `<li class="text-[11px] text-zinc-300 sans leading-relaxed"><span class="${leanCfg.color} mr-1.5 font-medium">→</span>${renderMd(f)}</li>`).join('')}
        </ul>
      </div>` : ''}
      ${judge.invalidation ? `<div class="mt-3 pt-3 border-t border-zinc-800/60 text-[11px] text-zinc-400 sans leading-relaxed">
        <span class="text-amber-400 uppercase tracking-wider text-[9px] font-medium mr-2">Invalidation</span>${renderMd(judge.invalidation)}
      </div>` : ''}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Call-to-action when no AI analysis yet
// ─────────────────────────────────────────────────────────────────────────────
function viewAICTA() {
  if (!state.apiKey) {
    return `<div class="border-2 border-dashed border-blue-500/40 bg-blue-500/[0.05] p-6 mb-3 text-center">
      <div class="text-blue-400 text-4xl mb-3">🔑</div>
      <div class="serif text-2xl text-zinc-100 mb-2">Setup <span class="italic text-blue-400">Gemini API Key</span> dulu</div>
      <div class="text-sm text-zinc-400 sans mb-4 max-w-xl mx-auto">
        Masukkan API key Google Gemini kamu. Disimpan di browser, dipakai per-request langsung ke Google API. Free tier sudah cukup buat puluhan analisis/hari.
      </div>
      <button onclick="window._app.toggleSettings()"
        class="bg-blue-500 hover:bg-blue-400 text-black px-5 py-2.5 text-[10px] uppercase tracking-[0.15em] font-medium transition-colors">
        ⚙ Configure API Key
      </button>
    </div>`;
  }
  const m = GEMINI_MODELS.find(x => x.id === state.model) || GEMINI_MODELS[0];
  return `<div class="border-2 border-dashed border-blue-500/30 bg-blue-500/[0.03] p-6 mb-3 text-center">
    <div class="text-blue-400 text-4xl mb-3">✦</div>
    <div class="text-sm text-zinc-300 sans mb-2">
      Tekan <span class="text-blue-400 font-medium">"Generate AI Analysis"</span> untuk dapat trade action plan
    </div>
    <div class="flex items-center justify-center gap-3 text-[11px] text-zinc-500 sans mt-2 flex-wrap">
      <span>🅖 ${esc(m.label)}</span>
      <span class="text-zinc-700">·</span>
      <span class="text-zinc-400">${esc(m.latency)}</span>
      <span class="text-zinc-700">·</span>
      <span>${esc(m.cost)}</span>
      ${state.grounding ? `<span class="text-zinc-700">·</span><span class="text-emerald-400">🌐 Web grounding ON</span>` : ''}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Analyzing progress bar (saat AI berjalan)
// ─────────────────────────────────────────────────────────────────────────────
function viewAnalyzingProgress() {
  if (!state.analyzing) return '';
  const m = GEMINI_MODELS.find(x => x.id === state.model) || GEMINI_MODELS[0];

  // Quick mode → simple bar
  if (state.analysisMode !== 'council') {
    return `<div class="border-2 border-blue-500/40 bg-blue-500/5 p-6 mb-3">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-3">
          <div class="spin text-blue-400 text-xl">⟳</div>
          <div>
            <div class="text-sm text-blue-300 uppercase tracking-[0.15em]">Analyzing with ${esc(m.label)}</div>
            <div class="text-xs text-zinc-500 sans mt-1">Quick mode · estimasi ${esc(m.latency)}</div>
          </div>
        </div>
        <button onclick="window._app.cancelAnalysis()"
          class="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-red-400 border border-zinc-700 hover:border-red-500/50 px-3 py-1.5 transition-colors">Cancel</button>
      </div>
      <div class="h-1 bg-zinc-900 overflow-hidden">
        <div class="h-full bg-gradient-to-r from-blue-500 to-purple-500 progress-bar"></div>
      </div>
    </div>`;
  }

  // Council mode → multi-phase stepper
  const phase = state.councilPhase;
  const isPro = state.model.includes('pro');
  const steps = isPro
    ? [
        { id: 'debate',      icon: '▲', label: 'Bull Researcher',    sub: 'membangun kasus LONG' },
        { id: 'debate_bear', icon: '▼', label: 'Bear Researcher',    sub: 'membangun kasus SHORT' },
        { id: 'judge',       icon: '⚖', label: 'Research Manager',   sub: 'menimbang bukti' },
        { id: 'final',       icon: '🎯', label: 'Portfolio Manager', sub: 'keputusan final' },
      ]
    : [
        { id: 'debate', icon: '⚔', label: 'Bull vs Bear Debate', sub: '2 agent paralel' },
        { id: 'judge',  icon: '⚖', label: 'Research Manager',    sub: 'menimbang bukti' },
        { id: 'final',  icon: '🎯', label: 'Portfolio Manager',  sub: 'keputusan final' },
      ];
  const order = steps.map(s => s.id);
  const curIdx = order.indexOf(phase);

  const stepHtml = steps.map((st, i) => {
    const done = curIdx > i;
    const active = curIdx === i;
    const color = done ? 'text-emerald-400' : active ? 'text-purple-300' : 'text-zinc-600';
    const dotBg = done ? 'bg-emerald-500' : active ? 'bg-purple-400 pulse-dot' : 'bg-zinc-700';
    return `<div class="flex items-center gap-3 ${active ? '' : 'opacity-' + (done ? '80' : '40')}">
      <div class="w-7 h-7 rounded-full ${dotBg} flex items-center justify-center text-sm flex-shrink-0">
        ${done ? '<span class="text-black">✓</span>' : `<span class="${active ? 'spin' : ''}">${active ? '⟳' : st.icon}</span>`}
      </div>
      <div class="flex-1">
        <div class="text-sm ${color}">${esc(st.label)}</div>
        <div class="text-[10px] text-zinc-500 sans">${esc(st.sub)}</div>
      </div>
      ${active ? '<span class="text-[10px] text-purple-400 uppercase tracking-wider">running</span>' : done ? '<span class="text-[10px] text-emerald-400 uppercase tracking-wider">done</span>' : ''}
    </div>`;
  }).join('<div class="ml-3.5 h-3 border-l border-zinc-800"></div>');

  return `<div class="border-2 border-purple-500/40 bg-purple-500/5 p-6 mb-3">
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-3">
        <div class="text-purple-400 text-xl">⚖</div>
        <div>
          <div class="text-sm text-purple-300 uppercase tracking-[0.15em]">Agent Council in session</div>
          <div class="text-xs text-zinc-500 sans mt-1">${esc(m.label)} · 4 agent · estimasi ${m.id === 'gemini-2.5-pro' ? '60-90s' : '30-50s'}</div>
        </div>
      </div>
      <button onclick="window._app.cancelAnalysis()"
        class="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-red-400 border border-zinc-700 hover:border-red-500/50 px-3 py-1.5 transition-colors">Cancel</button>
    </div>
    <div class="space-y-0">${stepHtml}</div>
  </div>`;
}

// =============================================================================
//  MAIN RENDER
// =============================================================================
function render() {
  // ── Capture in-flight input value SEBELUM innerHTML hancurkan DOM ─────────
  // Ini fix utk bug: user ngetik di input → klik Test/Show → render() jalan →
  // input field di-recreate dengan value kosong (karena state.apiKey belum
  // di-save). Akhirnya saat klik Save, value-nya hilang.
  const liveKeyInput = document.getElementById('api-key-input');
  if (liveKeyInput && state.showSettings) {
    state.keyDraft = liveKeyInput.value;
  }

  const { snapshot, analysis, loading, analyzing, error, analyzeError, analyzeHint, lastFetch, lastAnalyze } = state;
  const dotClass = loading || analyzing
    ? 'bg-blue-400 pulse-dot'
    : snapshot ? 'bg-emerald-500' : 'bg-zinc-600';
  const statusText = loading ? 'Fetching live data'
    : analyzing ? 'Gemini analyzing'
    : snapshot ? 'Live tick · multi-source'
    : 'Idle';
  const hasKey = !!state.apiKey;

  let body = '';

  if (loading && !snapshot) {
    body = `<div class="border border-blue-500/30 bg-blue-500/5 p-12 mb-6 text-center">
      <div class="flex items-center justify-center gap-3 mb-4">
        <span class="text-blue-400 text-lg">🔍</span>
        <span class="text-sm text-blue-300 uppercase tracking-[0.15em]">Fetching live snapshot</span>
      </div>
      <div class="text-sm text-zinc-400 sans">Mengambil tick dari Binance, CoinGecko, mempool.space, alternative.me, blockchain.info, CryptoCompare...</div>
      <div class="h-1 bg-zinc-900 max-w-md mx-auto overflow-hidden mt-6">
        <div class="h-full shimmer"></div>
      </div>
    </div>`;
  } else if (error) {
    body = `<div class="border border-red-500/40 bg-red-500/5 p-6 mb-6">
      <div class="text-sm font-medium text-red-400 mb-1">⚠ Gagal fetch snapshot</div>
      <div class="text-xs text-red-400/70 break-all">${esc(error)}</div>
      <button onclick="window._app.loadSnapshot()"
        class="mt-3 text-xs text-blue-400 hover:text-blue-300 uppercase tracking-wider">→ Coba lagi</button>
    </div>`;
  } else if (snapshot) {
    const t = snapshot.ticker;
    const cg = snapshot.coingecko;
    const fund = snapshot.funding;
    const net = snapshot.network;
    const mp = snapshot.mempool;

    body = `
      ${analyzing ? viewAnalyzingProgress() : (analysis ? viewTradeActionHero(analysis, t?.price) : viewAICTA())}

      ${(!analyzing && analysis?.debate) ? `<div class="grid grid-cols-12 gap-3 mb-3"><div class="col-span-12">${viewDebateCard(analysis)}</div></div>` : ''}

      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewPriceCard(snapshot)}
        ${viewWhaleWalls(snapshot)}
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        ${viewMetric('Market Cap',
          cg?.marketCap ? '$' + (cg.marketCap / 1e12).toFixed(3) + 'T' : '—',
          t?.volume24h ? '24h vol $' + (t.volume24h / 1e9).toFixed(1) + 'B' : '',
          'text-blue-400')}
        ${viewMetric('Funding Rate',
          fund?.fundingRate != null ? fund.fundingRate.toFixed(4) + '%' : '—',
          fund?.fundingRate >= 0 ? 'Longs pay shorts 🔥' : 'Shorts pay longs ❄',
          fund?.fundingRate < 0 ? 'text-blue-400' : 'text-orange-400')}
        ${viewMetric('Hashrate',
          net?.hashrate ? (net.hashrate / 1e9).toFixed(2) + ' EH/s' : '—',
          net?.blockHeight ? 'Block #' + net.blockHeight.toLocaleString() : '',
          'text-purple-400')}
        ${viewMetric('Mempool Fee',
          mp?.fastestFee ? mp.fastestFee + ' sat/vB' : '—',
          mp?.economyFee ? 'Eco: ' + mp.economyFee + ' sat/vB' : '',
          'text-cyan-400')}
      </div>

      <!-- v3: Derivatives Intelligence -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewDerivativesCard(snapshot, analysis)}
      </div>

      <!-- v3: Technical Analysis multi-TF -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewTechnicalCard(snapshot, analysis)}
      </div>

      <!-- v4: Options Flow + On-Chain Cycle (side by side) -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewOptionsCard(snapshot, analysis)}
        ${viewOnChainCard(snapshot, analysis)}
      </div>

      <!-- v4: Macro Context (full width) -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewMacroCard(snapshot, analysis)}
      </div>

      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewFearGreed(snapshot)}
        ${analysis ? viewSignal(analysis) : `<div class="col-span-12 md:col-span-8 border border-zinc-800 bg-zinc-950 p-5 flex items-center justify-center text-sm text-zinc-500 sans italic">
          ${hasKey ? 'Tekan "Generate AI Analysis" untuk dapat sinyal bandarmologi' : 'Setup API Key dulu untuk akses AI bandarmologi'}
        </div>`}
      </div>

      ${analysis ? `<div class="grid grid-cols-12 gap-3 mb-3">${viewWhaleNews(analysis)}</div>` : ''}

      ${analyzeError ? `<div class="border border-red-500/40 bg-red-500/5 p-4 mb-6">
        <div class="text-xs text-red-400 mb-1">⚠ AI analysis gagal: ${esc(analyzeError)}</div>
        ${analyzeHint ? `<div class="text-[11px] text-red-400/70 sans mt-1">${esc(analyzeHint)}</div>` : ''}
        <div class="mt-2 flex gap-3">
          <button onclick="window._app.loadAnalysis()" class="text-xs text-blue-400 hover:text-blue-300 uppercase tracking-wider">Retry</button>
          <button onclick="window._app.toggleSettings()" class="text-xs text-zinc-400 hover:text-zinc-200 uppercase tracking-wider">Edit Settings</button>
        </div>
      </div>` : ''}

      ${analysis?.riskWarning ? `<div class="border border-zinc-800 bg-zinc-950 p-4 mb-6">
        <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">⚠ Risk</span>
        <span class="text-xs text-zinc-400 sans italic">${esc(analysis.riskWarning)}</span>
      </div>` : ''}

      ${snapshot.errors?.length ? `<div class="text-[10px] text-zinc-600 sans mb-4">
        ⚠ ${snapshot.errors.length} source error: ${esc(snapshot.errors.map(e => e.source).join(', '))}
      </div>` : ''}

      <footer class="border-t border-zinc-800 pt-4 flex items-center justify-between text-[10px] text-zinc-600 sans gap-4 flex-wrap">
        <div>Snapshot: Binance · CoinGecko · alternative.me · mempool.space · blockchain.info · CryptoCompare</div>
        <div>Bukan saran finansial · DYOR</div>
      </footer>
    `;
  }

  document.getElementById('app').innerHTML = `
    <header class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 border-b border-zinc-800 pb-5 mb-6">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <div class="w-2 h-2 rounded-full ${dotClass}"></div>
          <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">${esc(statusText)}</span>
        </div>
        <h1 class="serif text-5xl text-zinc-100 leading-none">Bitcoin <span class="italic text-blue-400">Intelligence</span></h1>
        <p class="text-xs text-zinc-500 mt-2 sans">Live tick · AI bandarmologi · Google Gemini direct</p>
      </div>
      <div class="flex flex-col gap-2 items-start md:items-end">
        <div class="flex items-center gap-2 flex-wrap">
          ${viewApiKeyBadge()}
          <button onclick="window._app.loadSnapshot()" ${loading ? 'disabled' : ''}
            class="px-3 py-1.5 border border-zinc-700 hover:border-blue-500/50 hover:text-blue-300 text-[10px] uppercase tracking-[0.15em] text-zinc-400 transition-colors disabled:opacity-50 flex items-center gap-2">
            <span class="${loading ? 'spin' : ''}">↻</span>
            ${loading ? 'Loading...' : 'Refresh tick'}
          </button>
          <button onclick="window._app.loadAnalysis()" ${(!snapshot || analyzing) ? 'disabled' : ''}
            class="px-3 py-1.5 ${state.analysisMode === 'council' ? 'bg-purple-500 hover:bg-purple-400' : 'bg-blue-500 hover:bg-blue-400'} text-black text-[10px] uppercase tracking-[0.15em] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            ${state.analysisMode === 'council' ? '⚖' : '✦'} ${analyzing ? 'Analyzing...' : analysis ? 'Re-analyze' : (state.analysisMode === 'council' ? 'Run Council' : 'Generate Analysis')}
          </button>
        </div>
        <div class="text-[10px] text-zinc-600 tabular-nums">
          ${state.analysisMode === 'council' ? '⚖ council' : '⚡ quick'}${lastFetch ? ` · tick ${esc(fmt.ago(lastFetch))}` : ''}${lastAnalyze ? ` · AI ${esc(fmt.ago(lastAnalyze))}` : ''}
        </div>
      </div>
    </header>

    ${viewSettings()}
    ${body}
  `;
}

// =============================================================================
//  BOOT
// =============================================================================
window._app = {
  loadSnapshot,
  loadAnalysis,
  cancelAnalysis,
  toggleSettings,
  saveApiKey,
  clearApiKey,
  toggleShowKey,
  testApiKey,
  selectModel,
  toggleGrounding,
  setMode,
};

// Initial load
loadSnapshot();

// Auto-refresh snapshot tiap 30s (skip kalau lagi loading / panel settings buka)
setInterval(() => {
  if (!state.loading && !state.analyzing && !state.showSettings) loadSnapshot();
}, 30_000);

// Re-render tiap 5s supaya "X ago" timestamp update
setInterval(() => {
  if (!state.showSettings) render();
}, 5_000);
