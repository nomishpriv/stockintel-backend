const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = 'https://app.stockintel.com/api';
const PHONE = process.env.STOCKINTEL_PHONE || '';
const PASSWORD = process.env.STOCKINTEL_PASSWORD || '';
const DEVICE_ID = process.env.DEVICE_ID || '';

const TOKEN_FILE = path.join(__dirname, '..', '.token.json');

// Cache
const cache = new Map();
const TTL = 60000;

function getCache(k) {
  const e = cache.get(k);
  if (!e || Date.now() - e.t > TTL) { cache.delete(k); return null; }
  return e.d;
}
function setCache(k, d) { cache.set(k, { d, t: Date.now() }); }

// ========== TOKEN ==========
// FIX: Switched to async fs to avoid blocking the event loop.
// FIX: Added directory creation so write doesn't crash if folder is missing.
async function loadToken() {
  try {
    await fs.promises.access(TOKEN_FILE);
    const raw = await fs.promises.readFile(TOKEN_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.expiry > Date.now()) return data.token;
  } catch { }
  return null;
}

async function saveToken(token) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      TOKEN_FILE,
      JSON.stringify({ token, expiry: Date.now() + 3500000 })
    );
  } catch (e) {
    console.error('❌ Failed to save token:', e.message);
  }
}

let loginPromise = null;

async function loginAndGetToken() {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    try {
      console.log('🔑 Auto-login...');
      const { data } = await axios.post(`${BASE}/login`, {
        phone: PHONE, password: PASSWORD,
        device: { id: DEVICE_ID, name: 'Chrome', os: 'windows', type: 'desktop' }
      }, { timeout: 10000 });

      const token = data?.data?.access_token;
      if (token) {
        await saveToken(token); // FIX: await async saveToken
        console.log('✅ Auto-login success');
        return token;
      }
      return null;
    } catch (e) {
      if (e.response?.status === 429) {
        console.log('⏳ Rate limited — using manual token');
      }
      return null;
    } finally {
      loginPromise = null;
    }
  })();

  return loginPromise;
}

async function getToken() {
  const stored = await loadToken(); // FIX: await async loadToken
  if (stored) return stored;

  const newToken = await loginAndGetToken();
  if (newToken) return newToken;

  return process.env.STOCKINTEL_TOKEN || '';
}

// ========== API ==========
const api = axios.create({ baseURL: BASE, timeout: 15000 });

api.interceptors.request.use(async (config) => {
  config.headers.Authorization = `Bearer ${await getToken()}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 403) {
      console.log('🔄 Token expired, refreshing...');
      try { await fs.promises.unlink(TOKEN_FILE); } catch { } // FIX: async unlink
      const newToken = await loginAndGetToken();
      if (newToken) {
        err.config.headers.Authorization = `Bearer ${newToken}`;
        return api(err.config);
      }
    }
    return Promise.reject(err);
  }
);

// ========== SHARED MARKET DATA ==========
// FIX: New helper so /market is fetched once and reused by all consumers.
// This stops fetchAllStocks, getKSE100Volume and getVolumeSpeed from making
// separate network calls.
let marketDataPromise = null;

async function fetchMarketData() {
  const cached = getCache('market_raw');
  if (cached) return cached;

  if (marketDataPromise) return marketDataPromise;

  marketDataPromise = (async () => {
    try {
      const { data } = await api.get('/market');
      setCache('market_raw', data);
      return data;
    } catch (e) {
      throw e;
    } finally {
      marketDataPromise = null;
    }
  })();

  return marketDataPromise;
}

// ========== KSE100 VOLUME ANALYSIS ==========
let kseVolumeCache = null;
let kseVolumeLastFetch = 0;

function analyzeKSE100Volume(kseData) {
  if (!kseData) return null;

  const current = +kseData.v || 0;
  const avg10 = +kseData.v10a || 1;
  const avg30 = +kseData.v30a || 1;
  const ratio10 = (current / avg10) * 100;
  const ratio30 = (current / avg30) * 100;

  let level, color, signal, emoji;
  if (ratio10 > 200) {
    level = 'HEAVY_INSTITUTIONAL'; color = '#a855f7'; emoji = '🔴🔴';
    signal = 'Major institutional activity — strong momentum expected';
  } else if (ratio10 > 150) {
    level = 'INSTITUTIONAL'; color = '#f97316'; emoji = '🔴';
    signal = 'Smart money entering — follow the trend';
  } else if (ratio10 > 120) {
    level = 'ELEVATED'; color = '#f59e0b'; emoji = '🟡';
    signal = 'Above average volume — increased interest';
  } else if (ratio10 > 80) {
    level = 'NORMAL'; color = '#22c55e'; emoji = '🟢';
    signal = 'Normal retail volume — trade technicals';
  } else {
    level = 'LOW'; color = '#64748b'; emoji = '⚪';
    signal = 'Below average volume — low participation';
  }

  return {
    currentVolume: current, avg10Day: avg10, avg30Day: avg30,
    ratioVs10Day: +ratio10.toFixed(1), ratioVs30Day: +ratio30.toFixed(1),
    level, color, emoji, signal,
    indexValue: +kseData.c || 0, change: +kseData.ch || 0,
    changePercent: +kseData.pch ? +(kseData.pch * 100).toFixed(2) : 0,
    dayHigh: +kseData.h || 0, dayLow: +kseData.l || 0, open: +kseData.o || 0
  };
}

async function getKSE100Volume() {
  const now = Date.now();
  if (kseVolumeCache && (now - kseVolumeLastFetch) < TTL) return kseVolumeCache;

  try {
    const data = await fetchMarketData(); // FIX: reuse shared fetch instead of extra api.get
    const kseData = data?.data?.in?.KSE100;
    if (!kseData) return null;

    const analysis = analyzeKSE100Volume(kseData);
    kseVolumeCache = analysis;
    kseVolumeLastFetch = now;
    return analysis;
  } catch (e) {
    return null;
  }
}

// ========== VOLUME SPEED ==========
let volumeSpeedCache = { lastVolume: 0, lastTime: 0, candles: [] };

function analyzeVolumeSpeed(currentVolume, currentTime) {
  if (volumeSpeedCache.lastVolume === 0) {
    volumeSpeedCache = { lastVolume: currentVolume, lastTime: currentTime, candles: [] };
    return { speed: 0, perMinute: 0, trend: 'INIT', message: 'Initializing...', color: '#64748b' };
  }

  const volDiff = currentVolume - volumeSpeedCache.lastVolume;
  const timeDiff = (currentTime - volumeSpeedCache.lastTime) / 60000;
  if (timeDiff <= 0) return null;

  const perMinute = Math.round(volDiff / timeDiff);
  volumeSpeedCache.candles.push({ time: currentTime, volume: volDiff, perMinute });
  if (volumeSpeedCache.candles.length > 30) volumeSpeedCache.candles.shift();

  // FIX: Compare averages by actual slice length instead of hardcoded /2.
  // Old code divided by 2 even when the slice had only 1 item, skewing results.
  const recent = volumeSpeedCache.candles.slice(-5);
  const avgSpeed = recent.reduce((s, c) => s + c.perMinute, 0) / (recent.length || 1);

  const splitIdx = Math.floor(recent.length / 2);
  const firstSlice = recent.slice(0, splitIdx);
  const secondSlice = recent.slice(splitIdx);

  const firstAvg = firstSlice.length
    ? firstSlice.reduce((s, c) => s + c.perMinute, 0) / firstSlice.length
    : 0;
  const secondAvg = secondSlice.length
    ? secondSlice.reduce((s, c) => s + c.perMinute, 0) / secondSlice.length
    : 0;

  let trend, color, message;
  if (secondAvg > firstAvg * 1.5) {
    trend = 'SURGING'; color = '#a855f7'; message = `Volume surging — ${perMinute.toLocaleString()}/min`;
  } else if (secondAvg > firstAvg * 1.2) {
    trend = 'ACCELERATING'; color = '#f97316'; message = `Volume accelerating — ${perMinute.toLocaleString()}/min`;
  } else if (secondAvg < firstAvg * 0.5) {
    trend = 'SLOWING'; color = '#64748b'; message = `Volume slowing — ${perMinute.toLocaleString()}/min`;
  } else if (perMinute > avgSpeed * 1.5) {
    trend = 'SPIKE'; color = '#ef4444'; message = `Volume spike! ${perMinute.toLocaleString()}/min`;
  } else {
    trend = 'STEADY'; color = '#22c55e'; message = `Steady volume — ${perMinute.toLocaleString()}/min`;
  }

  volumeSpeedCache.lastVolume = currentVolume;
  volumeSpeedCache.lastTime = currentTime;

  return { currentVolume, volDiff, timeDiffSeconds: Math.round(timeDiff * 60), perMinute, avgSpeed5Min: Math.round(avgSpeed), trend, color, message };
}

async function getVolumeSpeed() {
  try {
    const data = await fetchMarketData(); // FIX: reuse shared fetch instead of extra api.get
    const kseData = data?.data?.in?.KSE100;
    if (!kseData) return null;

    const currentVolume = +kseData.v || 0;
    const currentTime = Date.now();
    const speed = analyzeVolumeSpeed(currentVolume, currentTime);
    if (!speed) return null;

    const avg10 = +kseData.v10a || 1;
    return {
      ...speed,
      ratioVsAvg: +((currentVolume / avg10) * 100).toFixed(1),
      indexValue: +kseData.c || 0,
      changePercent: +kseData.pch ? +(kseData.pch * 100).toFixed(2) : 0
    };
  } catch (e) {
    return null;
  }
}

// ========== FETCH ALL STOCKS ==========
let fetchPromise = null;

async function fetchAllStocks() {
  const cached = getCache('all');
  if (cached) return cached;

  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    console.log('📡 Fetching...');
    try {
      const data = await fetchMarketData(); // FIX: reuse shared fetch
      const raw = data?.data?.eq;
      if (!raw) return [];

      // Extract KSE100 volume data
      const kseData = data?.data?.in?.KSE100;
      if (kseData) {
        const volAnalysis = analyzeKSE100Volume(kseData);
        kseVolumeCache = volAnalysis;
        kseVolumeLastFetch = Date.now();
        console.log(`📊 KSE100 Vol: ${volAnalysis.emoji} ${volAnalysis.level} (${volAnalysis.ratioVs10Day}% of 10d avg)`);
        const speed = analyzeVolumeSpeed(+kseData.v || 0, Date.now());
        if (speed) console.log(`⚡ Vol Speed: ${speed.trend} — ${speed.perMinute.toLocaleString()}/min`);
      }

      const stocks = Object.entries(raw)
        .filter(([sym, s]) => {
          if (/R$|PREF|ETF|FUT|-/.test(sym)) return false;
          if (s.st !== 1 || !s.c || +s.c <= 0) return false;
          return true;
        })
        .map(([sym, s]) => ({
          symbol: sym, name: s.nm, price: +s.c, open: +s.o, high: +s.h, low: +s.l,
          volume: +s.v, change: +s.ch, changePercent: +((s.pch || 0) * 100).toFixed(2),
          prevClose: +s.ldcp, prevVolume: +s.ldcv,
          rsi: +(s.rsi ?? 0), // FIX: NaN guard — missing rsi becomes 0 instead of NaN
          upperCircuit: +s.uc, lowerCircuit: +s.lc,
          // FIX: NaN guards for all optional nested fields
          pivot: +(s.pp?.pp ?? 0),
          r1: +(s.pp?.r1 ?? 0),
          r2: +(s.pp?.r2 ?? 0),
          s1: +(s.pp?.s1 ?? 0),
          s2: +(s.pp?.s2 ?? 0),
          perf1w: +(s.p1w ?? 0),
          perf1m: +(s.p1m ?? 0),
          perf3m: +(s.p3m ?? 0),
          perf1y: +(s.p1y ?? 0),
          perfYtd: +(s.pytd ?? 0),
          eps: +(s.eps ?? 0),
          dps: +(s.dps ?? 0),
          pe: +(s.pr ?? 0),
          divYield: +(s.di ?? 0),
          volAvg1w: +(s.vaw ?? 0),
          volAvg10d: +(s.va10d ?? 0),
          volAvg1m: +(s.vam ?? 0),
          volAvg30d: +(s.v30a ?? 0),
          beta1m: +(s.bt?.['1m'] ?? 0),
          beta1y: +(s.bt?.['1y'] ?? 0),
          bidPrice: s.bidp ? +s.bidp : 0,
          bidVolume: s.bidv ? +s.bidv : 0,
          askPrice: s.askp ? +s.askp : 0,
          askVolume: s.askv ? +s.askv : 0,
          spreadAbs: (s.askp && s.bidp) ? +(+s.askp - +s.bidp).toFixed(2) : 0,
          spreadPct: (s.askp && s.bidp && +s.bidp > 0) ? +(((+s.askp - +s.bidp) / +s.bidp) * 100).toFixed(2) : 0,
          bidAskRatio: (s.bidv && s.askv && +s.askv > 0) ? +((+s.bidv / +s.askv)).toFixed(2) : 0,
          status: 'ACTIVE', lastUpdate: s.d,
          signal: (() => {
            const pch = +s.pch || 0;
            const rsi = +(s.rsi ?? 0); // FIX: consistent NaN guard
            const ratio = (s.bidv && s.askv && +s.askv > 0) ? +s.bidv / +s.askv : 1;
            let score = 0;
            if (pch > 0.01) score++;
            if (pch < -0.01) score--;
            if (rsi < 40) score++;
            if (rsi > 60) score--;
            if (ratio > 1.2) score++;
            if (ratio < 0.8) score--;
            return score >= 2 ? 'STRONG_BUY' : score === 1 ? 'BUY' : score === -1 ? 'SELL' : score <= -2 ? 'STRONG_SELL' : 'NEUTRAL';
          })(),
        }));

      console.log(`✅ ${stocks.length} stocks`);
      setCache('all', stocks);

      // FIX: Wrap optional services in try/catch so a missing file doesn't
      // wipe out the entire stock list by returning [].
      try {
        const orderFlowService = require('./orderFlowService');
        orderFlowService.recordFromStocks(stocks);
      } catch (e) {
        // Optional service not available
      }

      try {
        const predictService = require('./predictService');
        predictService.autoPredict(stocks);
        for (const stock of stocks) {
          try { predictService.checkPrediction(stock.symbol, stock.price, stock.high, stock.low); } catch { }
        }
      } catch (e) {
        // Optional service not available
      }

      return stocks;
    } catch (e) {
      console.error('❌ Fetch failed:', e.response?.status || e.message);
      return [];
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

// FIX: Input guards to prevent crashes on null / non-string arguments.
async function getStock(s) {
  if (!s || typeof s !== 'string') return null;
  const all = await fetchAllStocks();
  return all.find(x => x.symbol === s.toUpperCase()) || null;
}

async function getSummary() {
  const all = await fetchAllStocks();
  const a = all.filter(s => s.price > 0);
  return {
    total: all.length,
    active: a.length,
    gainers: a.filter(s => s.changePercent > 0).length,
    losers: a.filter(s => s.changePercent < 0).length,
    avgChange: +(a.reduce((x, b) => x + b.changePercent, 0) / a.length).toFixed(2) || 0
  };
}

async function searchStocks(q) {
  if (!q || typeof q !== 'string') return []; // FIX: guard against bad input
  const all = await fetchAllStocks();
  const ql = q.toLowerCase();
  return all.filter(s => s.symbol.toLowerCase().includes(ql) || s.name.toLowerCase().includes(ql)).slice(0, 20);
}

async function getOpportunities(n = 10) {
  const all = await fetchAllStocks();
  return all.filter(s => s.price > 0 && s.volume > 10000).sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, n);
}

// FIX: Also wipe volume caches so stale data doesn't linger.
function clearCache() {
  cache.clear();
  kseVolumeCache = null;
  kseVolumeLastFetch = 0;
  volumeSpeedCache = { lastVolume: 0, lastTime: 0, candles: [] };
}

module.exports = {
  fetchAllStocks, getStock, getSummary, searchStocks,
  getOpportunities, clearCache, getKSE100Volume, getVolumeSpeed, getToken
};