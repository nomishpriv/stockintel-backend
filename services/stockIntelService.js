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
  // If already logging in, wait for that one
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
          status: 'ACTIVE', lastUpdate: s.d,
          signal: (+s.pch || 0) > 0.01 ? 'BUY' : (+s.pch || 0) < -0.01 ? 'SELL' : 'NEUTRAL'
        }));

      console.log(`✅ ${stocks.length} stocks`);
      setCache('all', stocks);
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

async function getToken() {
  // 1. Check stored token
  const stored = loadToken();
  if (stored) return stored;

  // 2. Try auto-login ONCE
  const newToken = await loginAndGetToken();
  if (newToken) return newToken;

  // 3. Fallback to manual token from .env
  return process.env.STOCKINTEL_TOKEN || '';
}

// ========== API ==========
const api = axios.create({ baseURL: BASE, timeout: 15000 });

api.interceptors.request.use(async (config) => {
  config.headers.Authorization = `Bearer ${await getToken()}`;
  return config;
});

// ADD THIS INTERCEPTOR:
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 403) {
      console.log('🔄 Token expired, refreshing...');
      // Delete bad token file
      try { fs.unlinkSync(TOKEN_FILE); } catch { }
      // Try fresh login
      const newToken = await loginAndGetToken();
      if (newToken) {
        err.config.headers.Authorization = `Bearer ${newToken}`;
        return api(err.config);
      }
    }
    return Promise.reject(err);
  }
);

// ========== FETCH ==========
async function fetchAllStocks() {
  const cached = getCache('all');
  if (cached) return cached;

  console.log('📡 Fetching...');
  try {
    const { data } = await api.get('/market');
    const raw = data?.data?.eq;
    if (!raw) return [];

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
        status: 'ACTIVE', lastUpdate: s.d,
        signal: (+s.pch || 0) > 0.01 ? 'BUY' : (+s.pch || 0) < -0.01 ? 'SELL' : 'NEUTRAL'
      }));

    console.log(`✅ ${stocks.length} stocks`);
    setCache('all', stocks);
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
  }
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

module.exports = { fetchAllStocks, getStock, getSummary, searchStocks, getOpportunities, clearCache };