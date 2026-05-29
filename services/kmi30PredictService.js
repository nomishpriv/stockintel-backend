// services/kmi30PredictService.js
const fs = require('fs').promises;
const path = require('path');

const si = require('./stockIntelService');
const newsService = require('./newsService');

const PREDICT_FILE = path.join(__dirname, '..', '.kmi30-predictions.json');

// KMI-30: 30 most liquid PSX stocks (approximate constituents)
const KMI30_SYMBOLS = [
  'HBL', 'UBL', 'MCB', 'BAFL', 'ABL', 'MEBL',
  'LUCK', 'DGKC', 'CHCC', 'FCCL',
  'OGDC', 'PPL', 'MARI', 'POL', 'PSO', 'SHEL', 'APL',
  'ENGRO', 'FFC', 'EFERT', 'FATIMA',
  'HUBC', 'KAPCO', 'KEL',
  'SEARL', 'GLAXO', 'ABOT',
  'INDU', 'PSMC', 'HCAR',
  'NESTLE', 'COLG', 'UNITY',
  'TRG', 'SYS', 'TELE',
  'NML', 'NCL', 'GATM',
  'ASTL', 'ISL', 'MUGHAL'
];

// SECTOR mapping for news alignment
const SYMBOL_SECTOR = {
  'HBL': 'Banking', 'UBL': 'Banking', 'MCB': 'Banking', 'BAFL': 'Banking', 'ABL': 'Banking', 'MEBL': 'Banking',
  'LUCK': 'Cement', 'DGKC': 'Cement', 'CHCC': 'Cement', 'FCCL': 'Cement',
  'OGDC': 'Oil & Gas', 'PPL': 'Oil & Gas', 'MARI': 'Oil & Gas', 'POL': 'Oil & Gas', 'PSO': 'Oil & Gas', 'SHEL': 'Oil & Gas', 'APL': 'Oil & Gas',
  'ENGRO': 'Fertilizer', 'FFC': 'Fertilizer', 'EFERT': 'Fertilizer', 'FATIMA': 'Fertilizer',
  'HUBC': 'Power', 'KAPCO': 'Power', 'KEL': 'Power',
  'SEARL': 'Pharma', 'GLAXO': 'Pharma', 'ABOT': 'Pharma',
  'INDU': 'Auto', 'PSMC': 'Auto', 'HCAR': 'Auto',
  'NESTLE': 'Food & FMCG', 'COLG': 'Food & FMCG', 'UNITY': 'Food & FMCG',
  'TRG': 'Tech', 'SYS': 'Tech', 'TELE': 'Tech',
  'NML': 'Textile', 'NCL': 'Textile', 'GATM': 'Textile',
  'ASTL': 'Steel', 'ISL': 'Steel', 'MUGHAL': 'Steel',
};

let loadPromise = null;
let saveQueue = Promise.resolve();

async function loadPredictions() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await fs.readFile(PREDICT_FILE, 'utf8');
      return JSON.parse(raw);
    } catch { return {}; }
    finally { loadPromise = null; }
  })();
  return loadPromise;
}

async function savePredictions(data) {
  saveQueue = saveQueue.then(async () => {
    try {
      const dir = path.dirname(PREDICT_FILE);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(PREDICT_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('❌ Failed to save KMI30 predictions:', e.message);
    }
  }).catch(() => {});
  return saveQueue;
}

function f2(n) { return +Number(n).toFixed(2); }

// ─── 15-MIN INTRADAY SCAN ───────────────────────────────────────────────────
async function scanKMI30() {
  const allStocks = await si.fetchAllStocks();
  if (!Array.isArray(allStocks)) return [];

  const newsSignal = await newsService.getQuickSignal().catch(() => null);
  const bullishNews = newsSignal?.sentiment === 'BULLISH';
  const bearishNews = newsSignal?.sentiment === 'BEARISH';
  const affectedSectors = new Set(
    (newsSignal?.affectedSectors || []).map(s => s.sector)
  );

  const picks = [];

  for (const stock of allStocks) {
    if (!KMI30_SYMBOLS.includes(stock.symbol)) continue;
    if (stock.price <= 0 || stock.volume <= 0) continue;

    // ─── TECHNICAL CHECKS ───
    const abovePivot = stock.pivot > 0 && stock.price > stock.pivot;
    const aboveS1 = stock.s1 > 0 && stock.price > stock.s1;
    const volumeOk = stock.volAvg10d > 0 && stock.volume > stock.volAvg10d * 1.1;
    const rsiOk = stock.rsi > 35 && stock.rsi < 70; // not oversold, not overbought
    const momentumOk = stock.changePercent > -1.0; // not falling hard
    const spreadOk = stock.spreadPct > 0 && stock.spreadPct < 0.3; // tradeable

    // Base score
    let score = 0;
    let reasons = [];

    if (abovePivot) { score += 3; reasons.push('Above pivot'); }
    if (aboveS1) { score += 2; reasons.push('Above S1'); }
    if (volumeOk) { score += 3; reasons.push('Volume surge'); }
    if (rsiOk) { score += 2; reasons.push('RSI healthy'); }
    if (momentumOk) { score += 2; reasons.push('Positive momentum'); }
    if (spreadOk) { score += 1; reasons.push('Tradeable spread'); }

    // ─── NEWS ALIGNMENT ───
    const sector = SYMBOL_SECTOR[stock.symbol];
    const sectorBoost = sector && affectedSectors.has(sector);
    if (bullishNews && sectorBoost) {
      score += 4;
      reasons.push(`News bullish on ${sector}`);
    } else if (bearishNews && sectorBoost) {
      score -= 3;
      reasons.push(`News bearish on ${sector}`);
    }

    // ─── ORDER FLOW ALIGNMENT ───
   // NEW (check if data exists, otherwise skip silently)
if (stock.bidAskRatio > 0) {
  if (stock.bidAskRatio > 1.2) {
    score += 2;
    reasons.push('Bid pressure');
  } else if (stock.bidAskRatio < 0.7) {
    score -= 2;
    reasons.push('Ask pressure');
  }
}

    // ─── QUALIFY ───
    // Need at least 8 points and positive momentum to qualify for 15-min buy
    if (score < 8 || stock.changePercent < -0.5) continue;

    // ─── LEVELS ───
    const entry = stock.s1 > 0 && stock.price > stock.s1 ? f2(stock.s1) : f2(stock.price);
    const target = stock.r1 > 0 ? f2(stock.r1) :
                   stock.pivot > 0 ? f2(stock.pivot * 1.02) :
                   f2(stock.price * 1.015); // 1.5% scalp
    const stopLoss = stock.s2 > 0 ? f2(stock.s2) :
                     stock.s1 > 0 ? f2(stock.s1) :
                     f2(stock.price * 0.985); // 1.5% stop

    // Risk:Reward gate (must be >= 1.0 for scalp)
    const reward = target - entry;
    const risk = entry - stopLoss;
    if (risk <= 0 || reward / risk < 0.8) continue;

    picks.push({
      symbol: stock.symbol,
      name: stock.name,
      price: stock.price,
      changePercent: stock.changePercent,
      volume: stock.volume,
      rsi: stock.rsi,
      bidAskRatio: stock.bidAskRatio,
      score,
      reasons: reasons.slice(0, 4),
      sector,
      entry,
      target,
      stopLoss,
      riskReward: f2(reward / risk),
      expectedHoldMinutes: 15,
      newsAligned: bullishNews && sectorBoost,
      rationale: reasons.join(' + ')
    });
  }

  // Sort by score descending
  picks.sort((a, b) => b.score - a.score);
  return picks.slice(0, 10); // max 10 picks per cycle
}

// ─── CREATE PREDICTIONS ─────────────────────────────────────────────────────
async function createKMI30Predictions() {
  const picks = await scanKMI30();
  if (picks.length === 0) return [];

  const all = await loadPredictions();
  const now = new Date().toISOString();

  const created = [];
  for (const pick of picks) {
    const pred = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      createdAt: now,
      symbol: pick.symbol,
      name: pick.name,
      entry: pick.entry,
      target: pick.target,
      stopLoss: pick.stopLoss,
      riskReward: pick.riskReward,
      score: pick.score,
      rationale: pick.rationale,
      expectedHoldMinutes: pick.expectedHoldMinutes,
      checked: false,
      result: null,
      hitAt: null,
      actualHigh: null,
      actualLow: null,
      actualClose: null,
      timeFrame: '15MIN'
    };

    if (!all[pick.symbol]) all[pick.symbol] = [];
    all[pick.symbol].push(pred);

    // Keep last 50 per symbol
    if (all[pick.symbol].length > 50) {
      all[pick.symbol] = all[pick.symbol].slice(-50);
    }

    created.push(pred);
  }

  await savePredictions(all);
  console.log('🔥 KMI-30 Intraday:', created.map(p => `${p.symbol}(${p.score})`).join(', '));
  return created;
}

// ─── CHECK PREDICTIONS (call every 15 min) ────────────────────────────────────
async function checkKMI30Predictions() {
  const all = await loadPredictions();
  const allStocks = await si.fetchAllStocks();
  if (!Array.isArray(allStocks)) return [];

  let updated = false;
  const now = Date.now();

  for (const stock of allStocks) {
    const preds = all[stock.symbol];
    if (!preds) continue;

    for (const pred of preds) {
      if (pred.checked || pred.timeFrame !== '15MIN') continue;

      const age = now - new Date(pred.createdAt).getTime();
      const minAge = age / 60000;

      // Only check after 10 minutes (avoid instant noise)
      if (minAge < 10) continue;

      pred.actualHigh = stock.high;
      pred.actualLow = stock.low;
      pred.actualClose = stock.price;

      // WIN: target hit
      if (stock.high >= pred.target) {
        pred.result = 'WIN';
        pred.checked = true;
        pred.hitAt = new Date().toISOString();
        updated = true;
        console.log(`✅ KMI30 WIN: ${pred.symbol} @ ${pred.target} (entry ${pred.entry})`);
      }
      // LOSS: SL hit
      else if (stock.low <= pred.stopLoss) {
        pred.result = 'LOSS';
        pred.checked = true;
        pred.hitAt = new Date().toISOString();
        updated = true;
        console.log(`❌ KMI30 LOSS: ${pred.symbol} @ ${pred.stopLoss} (entry ${pred.entry})`);
      }
      // EXPIRE: neither hit after 35 minutes
      else if (minAge > 35) {
        pred.result = 'EXPIRED';
        pred.checked = true;
        pred.hitAt = new Date().toISOString();
        updated = true;
        console.log(`⏸ KMI30 EXPIRED: ${pred.symbol} (entry ${pred.entry}, close ${stock.price})`);
      }
    }
  }

  if (updated) await savePredictions(all);

  // Build summary
  const active = [];
  const completed = [];
  for (const sym of Object.keys(all)) {
    for (const p of all[sym]) {
      if (p.timeFrame === '15MIN') {
        if (p.checked) completed.push(p);
        else active.push(p);
      }
    }
  }

  return {
    active: active.length,
    completed: completed.length,
    wins: completed.filter(p => p.result === 'WIN').length,
    losses: completed.filter(p => p.result === 'LOSS').length,
    expired: completed.filter(p => p.result === 'EXPIRED').length,
    accuracy: completed.length > 0 ? ((completed.filter(p => p.result === 'WIN').length / completed.length) * 100).toFixed(0) : 0,
    activePicks: active.slice(0, 5),
    recentResults: completed.slice(-5)
  };
}

// ─── GET ACCURACY SUMMARY ───────────────────────────────────────────────────
async function getKMI30Accuracy() {
  const all = await loadPredictions();
  const completed = [];
  for (const sym of Object.keys(all)) {
    completed.push(...all[sym].filter(p => p.checked && p.timeFrame === '15MIN'));
  }

  const wins = completed.filter(p => p.result === 'WIN').length;
  const total = completed.length;
  const bySymbol = {};

  for (const p of completed) {
    if (!bySymbol[p.symbol]) bySymbol[p.symbol] = { wins: 0, total: 0 };
    bySymbol[p.symbol].total++;
    if (p.result === 'WIN') bySymbol[p.symbol].wins++;
  }

  const bestSymbols = Object.entries(bySymbol)
    .filter(([_, v]) => v.total >= 3)
    .map(([sym, v]) => ({ symbol: sym, accuracy: ((v.wins / v.total) * 100).toFixed(0), total: v.total }))
    .sort((a, b) => b.accuracy - a.accuracy)
    .slice(0, 5);

  return {
    totalPredictions: total,
    wins,
    losses: completed.filter(p => p.result === 'LOSS').length,
    expired: completed.filter(p => p.result === 'EXPIRED').length,
    accuracy: total > 0 ? ((wins / total) * 100).toFixed(0) : 0,
    bestSymbols,
    lastUpdated: new Date().toISOString()
  };
}

module.exports = {
  scanKMI30,
  createKMI30Predictions,
  checkKMI30Predictions,
  getKMI30Accuracy
};