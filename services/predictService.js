const fs = require('fs');
const path = require('path');

const PREDICT_FILE = path.join(__dirname, '..', '.predictions.json');

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

// ========== CREATE PREDICTION ==========
function createPrediction(stock) {
  const price = stock.price || 0;
  const atr = stock.atr || (price * 0.01);
  const r1 = stock.r1 || 0;
  const r2 = stock.r2 || 0;
  const s1 = stock.s1 || 0;
  const s2 = stock.s2 || 0;

  const predictions = {
    pivot: {
      method: 'PIVOT',
      entry: price,
      target: r1 > price ? r1 : r2,
      stopLoss: s1 < price ? s1 : s2,
      confidence: r1 > price ? 70 : 50,
      createdAt: new Date().toISOString()
    },
    atr: {
      method: 'ATR',
      entry: price,
      target: +(price + atr * 2).toFixed(2),
      stopLoss: +(price - atr * 1.5).toFixed(2),
      confidence: 65,
      createdAt: new Date().toISOString()
    }
  };

  // Save
  const all = loadPredictions();
  if (!all[stock.symbol]) all[stock.symbol] = [];
  all[stock.symbol].push({
    ...predictions,
    checked: false,
    result: null,
    hitAt: null
  });
  
  // Keep last 50 per stock
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

    // Check pivot method
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

    // Check ATR method
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

    // Mark fully checked
    if (pred.pivot.checked && pred.atr.checked) {
      pred.checked = true;
    }
  }

  if (updated) savePredictions(all);

  // Return current status
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
    pivot: {
      wins: pivotWins,
      total: pivotTotal,
      accuracy: pivotTotal > 0 ? +((pivotWins / pivotTotal) * 100).toFixed(0) : 0
    },
    atr: {
      wins: atrWins,
      total: atrTotal,
      accuracy: atrTotal > 0 ? +((atrWins / atrTotal) * 100).toFixed(0) : 0
    },
    bestMethod: pivotTotal > 0 && atrTotal > 0 
      ? (pivotWins / pivotTotal >= atrWins / atrTotal ? 'PIVOT' : 'ATR')
      : null
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

  return {
    symbol,
    totalPredictions: stockPreds.length,
    totalCompleted: completed.length,
    pivotAccuracy: pivotTotal > 0 ? +((pivotWins / pivotTotal) * 100).toFixed(0) : null,
    atrAccuracy: atrTotal > 0 ? +((atrWins / atrTotal) * 100).toFixed(0) : null,
    bestMethod: pivotTotal >= 3 && atrTotal >= 3
      ? (pivotWins / pivotTotal >= atrWins / atrTotal ? 'PIVOT' : 'ATR')
      : null,
    recommendation: null
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

module.exports = { createPrediction, checkPrediction, getAccuracySummary, getAllAccuracies };