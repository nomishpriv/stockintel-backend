const fs = require('fs');
const path = require('path');

const PREDICT_FILE = path.join(__dirname, '..', '.predictions.json');
const STATE_FILE = path.join(__dirname, '..', '.predict-state.json');

// ========== LOAD / SAVE ==========
function loadPredictions() {
  try {
    if (fs.existsSync(PREDICT_FILE)) {
      return JSON.parse(fs.readFileSync(PREDICT_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function savePredictions(data) {
  fs.writeFileSync(PREDICT_FILE, JSON.stringify(data, null, 2));
}

// FIX 1: Persist lastAutoPredict so server restarts don't cause duplicate predictions
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return { lastAutoPredict: 0 };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// FIX 2: Use PKT timezone (UTC+5) for PSX market hours
function isMarketOpen() {
  const now = new Date();
  // Convert to PKT (UTC+5)
  const pkt = new Date(now.getTime() + (5 * 60 * 60 * 1000));
  const hour = pkt.getUTCHours();
  const minute = pkt.getUTCMinutes();
  const day = pkt.getUTCDay(); // 0=Sun, 1=Mon ... 5=Fri, 6=Sat

  if (day === 0 || day === 6) return false; // Weekend

  const time = hour + minute / 60;
  return time >= 9.5 && time <= 15.5; // 9:30 AM – 3:30 PM PKT
}

// ========== TOP STOCKS FOR AUTO-PREDICT ==========
const TOP_SYMBOLS = ['FFC', 'LUCK', 'OGDC', 'MEBL', 'PPL', 'EFERT', 'HUBC', 'ENGRO', 'POL', 'MARI', 'SEARL', 'DGKC', 'MLCF'];

// ========== AUTO-PREDICT FUNCTION ==========
function autoPredict(stocks) {
  if (!isMarketOpen()) return [];

  // FIX 3: Load lastAutoPredict from disk so it survives restarts
  const state = loadState();
  if (Date.now() - state.lastAutoPredict < 900000) return []; // Every 15 minutes

  state.lastAutoPredict = Date.now();
  saveState(state);

  const results = [];

  for (const stock of stocks) {
    if (TOP_SYMBOLS.includes(stock.symbol)) {
      const result = createPrediction(stock);
      if (!result.skipped) {
        results.push(stock.symbol);
      }
    }
  }

  if (results.length > 0) {
    console.log('🤖 Auto-predicted:', results.join(', '));
  }
  return results;
}

// ========== CREATE PREDICTION ==========
function createPrediction(stock) {
  if (!isMarketOpen()) {
    return { skipped: true, reason: 'Market is closed' };
  }

  const price = stock.price || 0;
  const atr = stock.atr || (price * 0.01);
  const volumeOk = stock.volume > 10000;
  const atrOk = atr > price * 0.003;
  const r1 = stock.r1 || 0;
  const r2 = stock.r2 || 0;
  const s1 = stock.s1 || 0;
  const s2 = stock.s2 || 0;

  if (!volumeOk || !atrOk) {
    return { skipped: true, reason: 'Low volume or ATR too small' };
  }

  const all = loadPredictions();
  const existing = all[stock.symbol] || [];

  // FIX 4: Skip if a prediction with the same entry price already exists (deduplicates restart-spam)
  const samePrice = existing.filter(p => !p.checked && p.pivot.entry === price);
  if (samePrice.length > 0) {
    return { skipped: true, reason: 'Active prediction at same price already exists' };
  }

  // FIX 5: 5-minute recency guard still applies
  const recent = existing.filter(p => {
    const created = new Date(p.pivot.createdAt).getTime();
    return (Date.now() - created) < 300000;
  });
  if (recent.length > 0) {
    return { skipped: true, reason: 'Already predicted recently' };
  }

  // FIX 6: Validate pivot target is above entry price (was allowing target < entry)
  let pivotTarget = r1 > price ? r1 : r2;
  if (pivotTarget <= price) {
    // No valid resistance above price — skip pivot or use ATR-based target
    pivotTarget = +(price + atr * 1.5).toFixed(2);
  }

    // FIX 10: Skip if target is too close (less than 0.15% away)
  const targetDistance = ((pivotTarget - price) / price) * 100;
  if (targetDistance < 0.15) {
    return { skipped: true, reason: `Target too close (${targetDistance.toFixed(2)}%) — not worth trading` };
  }

  let pivotStop = s1 < price ? s1 : s2;
  if (pivotStop >= price) {
    pivotStop = +(price - atr * 1.5).toFixed(2);
  }

  const pivotConfidence = r1 > price ? 70 : 50;

  const predictions = {
    pivot: {
      method: 'PIVOT',
      entry: price,
      target: pivotTarget,
      stopLoss: pivotStop,
      confidence: pivotConfidence,
      createdAt: new Date().toISOString(),
      checked: false   // FIX 7: explicitly initialize
    },
    atr: {
      method: 'ATR',
      entry: price,
      target: +(price + atr * 2).toFixed(2),
      stopLoss: +(price - atr * 1.5).toFixed(2),
      confidence: 65,
      createdAt: new Date().toISOString(),
      checked: false   // FIX 7: explicitly initialize
    }
  };

  if (!all[stock.symbol]) all[stock.symbol] = [];
  all[stock.symbol].push({
    ...predictions,
    checked: false,
    result: null,
    hitAt: null
  });

  if (all[stock.symbol].length > 50) all[stock.symbol] = all[stock.symbol].slice(-50);

  savePredictions(all);
  return predictions;
}

// ========== CHECK PREDICTION ==========
function checkPrediction(symbol, currentPrice, currentHigh, currentLow) {
  const all = loadPredictions();
  const stockPreds = all[symbol] || [];
  let updated = false;

  for (const pred of stockPreds) {
    if (pred.checked) continue;

    // FIX 8: Guard against resolving predictions that are less than 60 seconds old
    const age = Date.now() - new Date(pred.pivot.createdAt).getTime();
    if (age < 60000) continue;

    if (!pred.pivot.checked) {
      if (currentHigh >= pred.pivot.target) {
        pred.pivot.result = 'WIN';
        pred.pivot.checked = true;
        pred.pivot.hitAt = new Date().toISOString();
        updated = true;
      } else if (currentLow <= pred.pivot.stopLoss) {
        pred.pivot.result = 'LOSS';
        pred.pivot.checked = true;
        pred.pivot.hitAt = new Date().toISOString();
        updated = true;
      }
    }

    if (!pred.atr.checked) {
      if (currentHigh >= pred.atr.target) {
        pred.atr.result = 'WIN';
        pred.atr.checked = true;
        pred.atr.hitAt = new Date().toISOString();
        updated = true;
      } else if (currentLow <= pred.atr.stopLoss) {
        pred.atr.result = 'LOSS';
        pred.atr.checked = true;
        pred.atr.hitAt = new Date().toISOString();
        updated = true;
      }
    }

    if (pred.pivot.checked && pred.atr.checked) {
      pred.checked = true;
    }
  }

  if (updated) savePredictions(all);

  const active = stockPreds.filter(p => !p.checked);
  const completed = stockPreds.filter(p => p.checked);

  const pivotWins = completed.filter(p => p.pivot?.result === 'WIN').length;
  const pivotTotal = completed.filter(p => p.pivot?.checked).length;
  const atrWins = completed.filter(p => p.atr?.result === 'WIN').length;
  const atrTotal = completed.filter(p => p.atr?.checked).length;

  return {
    symbol,
    active: active.length,
    completed: completed.length,
    pivot: { wins: pivotWins, total: pivotTotal, accuracy: pivotTotal > 0 ? +((pivotWins / pivotTotal) * 100).toFixed(0) : 0 },
    atr: { wins: atrWins, total: atrTotal, accuracy: atrTotal > 0 ? +((atrWins / atrTotal) * 100).toFixed(0) : 0 },
    bestMethod: pivotTotal > 0 && atrTotal > 0 ? (pivotWins / pivotTotal >= atrWins / atrTotal ? 'PIVOT' : 'ATR') : null
  };
}

// ========== GET ACCURACY SUMMARY ==========
function getAccuracySummary(symbol) {
  const all = loadPredictions();
  const stockPreds = all[symbol] || [];
  const completed = stockPreds.filter(p => p.checked);

  const pivotWins = completed.filter(p => p.pivot?.result === 'WIN').length;
  const pivotTotal = completed.filter(p => p.pivot?.checked).length;
  const atrWins = completed.filter(p => p.atr?.result === 'WIN').length;
  const atrTotal = completed.filter(p => p.atr?.checked).length;

  const pivotAccuracy = pivotTotal > 0 ? +((pivotWins / pivotTotal) * 100).toFixed(0) : null;
  const atrAccuracy = atrTotal > 0 ? +((atrWins / atrTotal) * 100).toFixed(0) : null;
  const bestMethod = pivotTotal >= 3 && atrTotal >= 3
    ? (pivotWins / pivotTotal >= atrWins / atrTotal ? 'PIVOT' : 'ATR')
    : null;

  // FIX 9: Populate recommendation instead of leaving it null
  let recommendation = null;
  if (bestMethod) {
    const acc = bestMethod === 'PIVOT' ? pivotAccuracy : atrAccuracy;
    if (acc >= 60) recommendation = `Use ${bestMethod} — strong accuracy (${acc}%)`;
    else if (acc >= 40) recommendation = `${bestMethod} shows moderate accuracy (${acc}%) — trade with caution`;
    else recommendation = `Both methods underperforming — avoid auto-trading ${symbol}`;
  }

  return {
    symbol,
    totalPredictions: stockPreds.length,
    totalCompleted: completed.length,
    pivotAccuracy,
    atrAccuracy,
    bestMethod,
    recommendation
  };
}

// ========== GET ALL ACCURACIES ==========
function getAllAccuracies() {
  const all = loadPredictions();
  const results = [];
  for (const symbol of Object.keys(all)) {
    results.push(getAccuracySummary(symbol));
  }
  return results.filter(r => r.totalCompleted >= 3).sort((a, b) => (b.pivotAccuracy || 0) - (a.pivotAccuracy || 0));
}

module.exports = { createPrediction, checkPrediction, getAccuracySummary, getAllAccuracies, autoPredict };