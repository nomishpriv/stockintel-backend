const fs = require('fs');
const path = require('path');

const PREDICT_FILE = path.join(__dirname, '..', '.predictions.json');
const STATE_FILE   = path.join(__dirname, '..', '.predict-state.json');

// ========== LOAD / SAVE ==========
function loadPredictions() {
  try {
    if (fs.existsSync(PREDICT_FILE))
      return JSON.parse(fs.readFileSync(PREDICT_FILE, 'utf8'));
  } catch {}
  return {};
}

function savePredictions(data) {
  fs.writeFileSync(PREDICT_FILE, JSON.stringify(data, null, 2));
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { lastAutoPredict: 0 };
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ========== MARKET HOURS (PKT = UTC+5) ==========
function isMarketOpen() {
  const pkt  = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const day  = pkt.getUTCDay();                          // 0=Sun, 6=Sat
  const time = pkt.getUTCHours() + pkt.getUTCMinutes() / 60;
  return day >= 1 && day <= 5 && time >= 9.5 && time <= 15.5;
}

// ========== ATR (True Range, single-candle approximation) ==========
// FIX: stock.atr does not exist in stockService — compute it here
// True Range = max( H-L, |H-prevClose|, |L-prevClose| )
// Floor at 0.5% of price so near-zero ATR never slips through
function computeATR(stock) {
  const h  = stock.high      || stock.price;
  const l  = stock.low       || stock.price;
  const pc = stock.prevClose || stock.price;
  const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  return Math.max(tr, stock.price * 0.005);
}

// ========== ENTRY VALIDATION ==========
// FIX: reject entry prices that are stale (>3% below yesterday's close).
// Caused false WINs within 2 minutes by comparing old entries against live prices.
function isEntryValid(entry, ldcp, tolerancePct = 0.03) {
  if (!ldcp || ldcp <= 0) return true;          // can't validate without LDCP
  return (ldcp - entry) / ldcp < tolerancePct;
}

// ========== SAFE toFixed ==========
function f2(n) { return +Number(n).toFixed(2); }

// ========== TOP SYMBOLS ==========
const TOP_SYMBOLS = [
  'FFC', 'LUCK', 'OGDC', 'MEBL', 'PPL', 'EFERT',
  'HUBC', 'ENGRO', 'POL', 'MARI', 'SEARL', 'DGKC', 'MLCF'
];

// ========== AUTO-PREDICT ==========
function autoPredict(stocks) {
  if (!isMarketOpen()) return [];

  const state = loadState();
  if (Date.now() - state.lastAutoPredict < 900000) return [];   // 15-min cooldown

  state.lastAutoPredict = Date.now();
  saveState(state);

  const results = [];
  for (const stock of stocks) {
    if (!TOP_SYMBOLS.includes(stock.symbol)) continue;
    const result = createPrediction(stock);
    if (!result.skipped) results.push(stock.symbol);
  }

  if (results.length > 0) console.log('🤖 Auto-predicted:', results.join(', '));
  return results;
}

// ========== CREATE PREDICTION ==========
function createPrediction(stock) {
  if (!isMarketOpen())
    return { skipped: true, reason: 'Market is closed' };

  const price = stock.price || 0;
  if (price <= 0)
    return { skipped: true, reason: 'Invalid price' };

  // FIX: compute ATR from stock OHLC fields
  const atr = computeATR(stock);

  if (stock.volume <= 10000)
    return { skipped: true, reason: 'Volume too low' };

  if (atr < price * 0.003)
    return { skipped: true, reason: 'ATR too small — low volatility' };

  // FIX: reject stale entry vs LDCP
  if (!isEntryValid(price, stock.prevClose))
    return { skipped: true, reason: `Entry ${price} is stale vs LDCP ${stock.prevClose} — skip` };

  const r1 = stock.r1 || 0;
  const r2 = stock.r2 || 0;
  const s1 = stock.s1 || 0;
  const s2 = stock.s2 || 0;

  const all      = loadPredictions();
  const existing = all[stock.symbol] || [];

  // Skip if an unchecked prediction at a similar price already exists
  const samePrice = existing.find(p =>
    !p.checked && Math.abs(p.pivot.entry - price) / price < 0.01
  );
  if (samePrice)
    return { skipped: true, reason: 'Active prediction at similar price already exists' };

  // 5-minute recency guard
  const recent = existing.find(p =>
    Date.now() - new Date(p.pivot.createdAt).getTime() < 300000
  );
  if (recent)
    return { skipped: true, reason: 'Already predicted in the last 5 minutes' };

  // FIX: pivot target — prefer R1, fall back to R2, then ATR-based
  let pivotTarget =
    r1 > price ? f2(r1) :
    r2 > price ? f2(r2) :
    f2(price + atr * 1.5);

  // FIX: pivot stop — prefer S1, fall back to S2, then ATR-based
  let pivotStop =
    s1 > 0 && s1 < price ? f2(s1) :
    s2 > 0 && s2 < price ? f2(s2) :
    f2(price - atr * 1.5);

  // Target distance checks
  const targetPct = ((pivotTarget - price) / price) * 100;
  if (targetPct < 0.15)
    return { skipped: true, reason: `Target too close (${targetPct.toFixed(2)}%) — not worth trading` };
  if (targetPct > 5)
    return { skipped: true, reason: `Target too far (${targetPct.toFixed(1)}%) — unrealistic for intraday` };

  // FIX: R:R ratio gate — minimum 1:1 required
  const reward = pivotTarget - price;
  const risk   = price - pivotStop;
  if (risk <= 0 || reward / risk < 1)
    return { skipped: true, reason: `Poor R:R (${risk > 0 ? (reward / risk).toFixed(2) : 'n/a'}) — skip` };

  const pivotConfidence = r1 > price ? 70 : 50;
  const now = new Date().toISOString();

  const entry = {
    pivot: {
      method:     'PIVOT',
      entry:      price,
      target:     pivotTarget,
      stopLoss:   pivotStop,
      confidence: pivotConfidence,
      createdAt:  now,
      checked:    false
    },
    atr: {
      method:     'ATR',
      entry:      price,
      target:     f2(price + atr * 2),
      stopLoss:   f2(price - atr * 1.5),
      confidence: 65,
      createdAt:  now,
      checked:    false
    },
    // Parent-level fields — updated by checkPrediction rollup
    checked: false,
    result:  null,
    hitAt:   null
  };

  if (!all[stock.symbol]) all[stock.symbol] = [];
  all[stock.symbol].push(entry);

  // Keep only the last 50 predictions per symbol
  if (all[stock.symbol].length > 50)
    all[stock.symbol] = all[stock.symbol].slice(-50);

  savePredictions(all);
  return entry;
}

// ========== CHECK PREDICTION ==========
function checkPrediction(symbol, currentPrice, currentHigh, currentLow) {
  const all        = loadPredictions();
  const stockPreds = all[symbol] || [];
  let updated      = false;

  for (const pred of stockPreds) {
    if (pred.checked) continue;

    // Must be at least 60 seconds old before resolving
    const age = Date.now() - new Date(pred.pivot.createdAt).getTime();
    if (age < 60000) continue;

    // Check PIVOT method
    if (!pred.pivot.checked) {
      if (currentHigh >= pred.pivot.target) {
        pred.pivot.result  = 'WIN';
        pred.pivot.checked = true;
        pred.pivot.hitAt   = new Date().toISOString();
        updated = true;
      } else if (currentLow <= pred.pivot.stopLoss) {
        pred.pivot.result  = 'LOSS';
        pred.pivot.checked = true;
        pred.pivot.hitAt   = new Date().toISOString();
        updated = true;
      }
    }

    // Check ATR method
    if (!pred.atr.checked) {
      if (currentHigh >= pred.atr.target) {
        pred.atr.result  = 'WIN';
        pred.atr.checked = true;
        pred.atr.hitAt   = new Date().toISOString();
        updated = true;
      } else if (currentLow <= pred.atr.stopLoss) {
        pred.atr.result  = 'LOSS';
        pred.atr.checked = true;
        pred.atr.hitAt   = new Date().toISOString();
        updated = true;
      }
    }

    // FIX: roll up parent fields when both methods are resolved
    if (pred.pivot.checked && pred.atr.checked) {
      pred.checked = true;
      // WIN if either method hit target; LOSS only if both lost
      pred.result = (pred.pivot.result === 'WIN' || pred.atr.result === 'WIN') ? 'WIN' : 'LOSS';
      pred.hitAt  = pred.pivot.hitAt || pred.atr.hitAt || new Date().toISOString();
      updated = true;
    }
  }

  if (updated) savePredictions(all);

  // Build return summary
  const active    = stockPreds.filter(p => !p.checked);
  const completed = stockPreds.filter(p => p.checked);

  const pivotWins  = completed.filter(p => p.pivot?.result === 'WIN').length;
  const pivotTotal = completed.filter(p => p.pivot?.checked).length;
  const atrWins    = completed.filter(p => p.atr?.result === 'WIN').length;
  const atrTotal   = completed.filter(p => p.atr?.checked).length;

  return {
    symbol,
    active:     active.length,
    completed:  completed.length,
    pivot: {
      wins:     pivotWins,
      total:    pivotTotal,
      accuracy: pivotTotal > 0 ? +((pivotWins / pivotTotal) * 100).toFixed(0) : 0
    },
    atr: {
      wins:     atrWins,
      total:    atrTotal,
      accuracy: atrTotal > 0 ? +((atrWins / atrTotal) * 100).toFixed(0) : 0
    },
    bestMethod: (pivotTotal > 0 && atrTotal > 0)
      ? (pivotWins / pivotTotal >= atrWins / atrTotal ? 'PIVOT' : 'ATR')
      : null
  };
}

// ========== ACCURACY SUMMARY (single symbol) ==========
function getAccuracySummary(symbol) {
  const all        = loadPredictions();
  const stockPreds = all[symbol] || [];
  const completed  = stockPreds.filter(p => p.checked);

  const pivotWins  = completed.filter(p => p.pivot?.result === 'WIN').length;
  const pivotTotal = completed.filter(p => p.pivot?.checked).length;
  const atrWins    = completed.filter(p => p.atr?.result === 'WIN').length;
  const atrTotal   = completed.filter(p => p.atr?.checked).length;

  const pivotAccuracy = pivotTotal > 0 ? +((pivotWins / pivotTotal) * 100).toFixed(0) : null;
  const atrAccuracy   = atrTotal   > 0 ? +((atrWins   / atrTotal)   * 100).toFixed(0) : null;

  // Need at least 3 completed predictions per method to pick a winner
  const bestMethod = (pivotTotal >= 3 && atrTotal >= 3)
    ? (pivotWins / pivotTotal >= atrWins / atrTotal ? 'PIVOT' : 'ATR')
    : null;

  let recommendation = null;
  if (bestMethod) {
    const acc = bestMethod === 'PIVOT' ? pivotAccuracy : atrAccuracy;
    if (acc >= 60)
      recommendation = `Use ${bestMethod} — strong accuracy (${acc}%)`;
    else if (acc >= 40)
      recommendation = `${bestMethod} shows moderate accuracy (${acc}%) — trade with caution`;
    else
      recommendation = `Both methods underperforming — avoid auto-trading ${symbol}`;
  }

  return {
    symbol,
    totalPredictions: stockPreds.length,
    totalCompleted:   completed.length,
    pivotAccuracy,
    atrAccuracy,
    bestMethod,
    recommendation
  };
}

// ========== ACCURACY SUMMARY (all symbols) ==========
function getAllAccuracies() {
  const all = loadPredictions();
  return Object.keys(all)
    .map(symbol => getAccuracySummary(symbol))
    .filter(r => r.totalCompleted >= 3)
    .sort((a, b) => (b.pivotAccuracy || 0) - (a.pivotAccuracy || 0));
}

module.exports = {
  createPrediction,
  checkPrediction,
  getAccuracySummary,
  getAllAccuracies,
  autoPredict
};