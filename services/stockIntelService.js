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
function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (data.expiry > Date.now()) return data.token;
    }
  } catch { }
  return null;
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expiry: Date.now() + 3500000 }));
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
        saveToken(token);
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
  const stored = loadToken();
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
      try { fs.unlinkSync(TOKEN_FILE); } catch { }
      const newToken = await loginAndGetToken();
      if (newToken) {
        err.config.headers.Authorization = `Bearer ${newToken}`;
        return api(err.config);
      }
    }
    return Promise.reject(err);
  }
);

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
    const { data } = await api.get('/market');
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

  const recent = volumeSpeedCache.candles.slice(-5);
  const avgSpeed = recent.reduce((s, c) => s + c.perMinute, 0) / recent.length;
  const firstHalf = recent.slice(0, 2).reduce((s, c) => s + c.perMinute, 0) / 2;
  const secondHalf = recent.slice(-2).reduce((s, c) => s + c.perMinute, 0) / 2;

  let trend, color, message;
  if (secondHalf > firstHalf * 1.5) {
    trend = 'SURGING'; color = '#a855f7'; message = `Volume surging — ${perMinute.toLocaleString()}/min`;
  } else if (secondHalf > firstHalf * 1.2) {
    trend = 'ACCELERATING'; color = '#f97316'; message = `Volume accelerating — ${perMinute.toLocaleString()}/min`;
  } else if (secondHalf < firstHalf * 0.5) {
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
    const { data } = await api.get('/market');
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
      const { data } = await api.get('/market');
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
          prevClose: +s.ldcp, prevVolume: +s.ldcv, rsi: +s.rsi,
          upperCircuit: +s.uc, lowerCircuit: +s.lc,
          pivot: +s.pp?.pp, r1: +s.pp?.r1, r2: +s.pp?.r2, s1: +s.pp?.s1, s2: +s.pp?.s2,
          perf1w: +s.p1w, perf1m: +s.p1m, perf3m: +s.p3m, perf1y: +s.p1y, perfYtd: +s.pytd,
          eps: +s.eps, dps: +s.dps, pe: +s.pr, divYield: +s.di,
          volAvg1w: +s.vaw, volAvg10d: +s.va10d, volAvg1m: +s.vam, volAvg30d: +s.v30a,
          beta1m: +s.bt?.['1m'], beta1y: +s.bt?.['1y'],
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
            const rsi = +s.rsi || 50;
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

      // Record order flow data
      const orderFlowService = require('./orderFlowService');
      orderFlowService.recordFromStocks(stocks);

      // Auto-predict & check
      const predictService = require('./predictService');
      predictService.autoPredict(stocks);
      for (const stock of stocks) {
        try { predictService.checkPrediction(stock.symbol, stock.price, stock.high, stock.low); } catch { }
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

async function getStock(s) { const all = await fetchAllStocks(); return all.find(x => x.symbol === s.toUpperCase()) || null; }
async function getSummary() {
  const all = await fetchAllStocks();
  const a = all.filter(s => s.price > 0);
  return { total: all.length, active: a.length, gainers: a.filter(s => s.changePercent > 0).length, losers: a.filter(s => s.changePercent < 0).length, avgChange: +(a.reduce((x, b) => x + b.changePercent, 0) / a.length).toFixed(2) || 0 };
}
async function searchStocks(q) { const all = await fetchAllStocks(); const ql = q.toLowerCase(); return all.filter(s => s.symbol.toLowerCase().includes(ql) || s.name.toLowerCase().includes(ql)).slice(0, 20); }
async function getOpportunities(n = 10) { const all = await fetchAllStocks(); return all.filter(s => s.price > 0 && s.volume > 10000).sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, n); }
function clearCache() { cache.clear(); }

module.exports = { fetchAllStocks, getStock, getSummary, searchStocks, getOpportunities, clearCache, getKSE100Volume, getVolumeSpeed, getToken };