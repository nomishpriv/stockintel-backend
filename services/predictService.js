// predictService
const fs = require('fs');
const path = require('path');

const PREDICT_FILE = path.join(__dirname, '..', '.predictions.json');
const STATE_FILE   = path.join(__dirname, '..', '.predict-state.json');

// ========== TEST MODE CONFIG — Change only these ==========
const TEST_MODE = false;           // true=testing, false=production
const TEST_MIN_RR = 0.5;         // R:R threshold for testing
const PROD_MIN_RR = 1;           // R:R threshold for production
const TEST_MIN_COMPLETED = 1;    // Min predictions for accuracy (testing)
const PROD_MIN_COMPLETED = 3;    // Min predictions for accuracy (production)

// Derived config — don't change
const MIN_RR = TEST_MODE ? TEST_MIN_RR : PROD_MIN_RR;
const MIN_COMPLETED = TEST_MODE ? TEST_MIN_COMPLETED : PROD_MIN_COMPLETED;
// =============================================================

// FIX: Promise caches so concurrent loads share one disk read instead of
// hammering the filesystem when checkPrediction is called in a tight loop
// (e.g., 500+ times per fetch cycle).
let predictLoadPromise = null;
let stateLoadPromise   = null;

// FIX: Write queues so overlapping saves don't corrupt JSON by reading
// stale data, mutating it, and writing over a newer version.
let predictSaveQueue = Promise.resolve();
let stateSaveQueue   = Promise.resolve();

// ========== LOAD / SAVE ==========
async function loadPredictions() {
  if (predictLoadPromise) return predictLoadPromise;

  predictLoadPromise = (async () => {
    try {
      const raw = await fs.promises.readFile(PREDICT_FILE, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    } finally {
      predictLoadPromise = null;
    }
  })();

  return predictLoadPromise;
}

async function savePredictions(data) {
  predictSaveQueue = predictSaveQueue.then(async () => {
    try {
      const dir = path.dirname(PREDICT_FILE);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(PREDICT_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('❌ Failed to save predictions:', e.message);
    }
  }).catch(() => {});

  return predictSaveQueue;
}

async function loadState() {
  if (stateLoadPromise) return stateLoadPromise;

  stateLoadPromise = (async () => {
    try {
      const raw = await fs.promises.readFile(STATE_FILE, 'utf8');
      return JSON.parse(raw);
    } catch {
      return { lastAutoPredict: 0 };
    } finally {
      stateLoadPromise = null;
    }
  })();

  return stateLoadPromise;
}

async function saveState(state) {
  stateSaveQueue = stateSaveQueue.then(async () => {
    try {
      const dir = path.dirname(STATE_FILE);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('❌ Failed to save state:', e.message);
    }
  }).catch(() => {});

  return stateSaveQueue;
}

// ========== MARKET HOURS (PKT = UTC+5) ==========
function isMarketOpen() {
  // TEST_MODE: bypass market hours check
  if (TEST_MODE) return true;

  const pkt  = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const day  = pkt.getUTCDay();  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const hour = pkt.getUTCHours();
  const min  = pkt.getUTCMinutes();
  const time = hour + min / 60;

  // Sunday & Saturday — closed
  if (day === 0 || day === 6) return false;

  // Monday to Thursday — 9:30 AM to 3:30 PM (continuous)
  if (day >= 1 && day <= 4) {
    return time >= 9.5 && time <= 15.5;
  }

  // Friday — two sessions with a break
  // Session 1: 9:15 AM to 12:00 PM
  // Session 2: 2:30 PM to 4:30 PM
  if (day === 5) {
    const session1 = time >= 9.25 && time <= 12.0;   // 9:15 AM – 12:00 PM
    const session2 = time >= 14.5 && time <= 16.5;   // 2:30 PM – 4:30 PM
    return session1 || session2;
  }

  return false;
}

// ========== ATR (True Range, single-candle approximation) ==========
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
// Reject entry prices that are stale (>3% below yesterday's close).
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
async function autoPredict(stocks) {
  if (!isMarketOpen()) return [];

  const state = await loadState();
  if (Date.now() - state.lastAutoPredict < 900000) return [];   // 15-min cooldown

  state.lastAutoPredict = Date.now();
  await saveState(state);

  const results = [];
  for (const stock of stocks) {
    if (!TOP_SYMBOLS.includes(stock.symbol)) continue;
    const result = await createPrediction(stock);
    if (!result.skipped) results.push(stock.symbol);
  }

  if (results.length > 0) console.log('🤖 Auto-predicted:', results.join(', '));
  return results;
}

// ========== CREATE PREDICTION ==========
async function createPrediction(stock) {
  if (!isMarketOpen())
    return { skipped: true, reason: 'Market is closed' };

  const price = stock.price || 0;
  if (price <= 0)
    return { skipped: true, reason: 'Invalid price' };

  const atr = computeATR(stock);

  if (stock.volume <= 10000)
    return { skipped: true, reason: 'Volume too low' };

  if (atr < price * 0.003)
    return { skipped: true, reason: 'ATR too small — low volatility' };

  if (!isEntryValid(price, stock.prevClose))
    return { skipped: true, reason: `Entry ${price} is stale vs LDCP ${stock.prevClose} — skip` };

  const r1 = stock.r1 || 0;
  const r2 = stock.r2 || 0;
  const s1 = stock.s1 || 0;
  const s2 = stock.s2 || 0;

  const all      = await loadPredictions();
  const existing = all[stock.symbol] || [];

  // Skip if an unchecked prediction at a similar price already exists
  const samePrice = existing.find(p =>
    !p.checked && Math.abs(p.pivot.entry - price) / price < 0.01
  );
  if (samePrice)
    return { skipped: true, reason: 'Active prediction at similar price already exists' };

  // 5-minute recency guard (any prediction, checked or unchecked)
  const recent = existing.find(p =>
    Date.now() - new Date(p.pivot.createdAt).getTime() < 300000
  );
  if (recent)
    return { skipped: true, reason: 'Already predicted in the last 5 minutes' };

  // Pivot target — prefer R1, fall back to R2, then ATR-based
  let pivotTarget =
    r1 > price ? f2(r1) :
    r2 > price ? f2(r2) :
    f2(price + atr * 1.5);

  // Pivot stop — prefer S1, fall back to S2, then ATR-based
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

  // R:R ratio gate — uses TEST_MODE threshold
  const reward = pivotTarget - price;
  const risk   = price - pivotStop;
  if (risk <= 0 || reward / risk < MIN_RR)
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

  await savePredictions(all);
  return entry;
}

// ========== CHECK PREDICTION ==========
// NOTE: currentPrice is passed by the caller (stockIntelService) but is
// intentionally unused in this version — only currentHigh / currentLow are
// needed to determine whether target or stop was hit.
async function checkPrediction(symbol, currentPrice, currentHigh, currentLow) {
  const all        = await loadPredictions();
  const stockPreds = all[symbol] || [];
  let updated      = false;

  // TEST_MODE: bypass high/low validation. Production: validate properly.
  const hasValidHL = TEST_MODE ? true : (currentHigh > 0 && currentLow > 0 && currentHigh >= currentLow);

  for (const pred of stockPreds) {
    if (pred.checked) continue;

    // Production: must be at least 60 seconds old before resolving. Test: check immediately.
    if (!TEST_MODE) {
      const age = Date.now() - new Date(pred.pivot.createdAt).getTime();
      if (age < 60000) continue;
    }

    // Check PIVOT method
    if (!pred.pivot.checked && hasValidHL) {
      if (currentHigh >= pred.pivot.target) {
        pred.pivot.result  = 'WIN';
        pred.pivot.checked = true;
        pred.pivot.hitAt   = new Date().toISOString();
        // Mark parent as resolved when pivot resolves
        pred.checked = true;
        pred.result  = 'WIN';
        pred.hitAt   = pred.pivot.hitAt;
        updated = true;
      } else if (currentLow <= pred.pivot.stopLoss) {
        pred.pivot.result  = 'LOSS';
        pred.pivot.checked = true;
        pred.pivot.hitAt   = new Date().toISOString();
        // Mark parent as resolved when pivot resolves
        pred.checked = true;
        pred.result  = 'LOSS';
        pred.hitAt   = pred.pivot.hitAt;
        updated = true;
      }
    }

    // Check ATR method
    if (!pred.atr.checked && hasValidHL) {
      if (currentHigh >= pred.atr.target) {
        pred.atr.result  = 'WIN';
        pred.atr.checked = true;
        pred.atr.hitAt   = new Date().toISOString();
        if (!pred.checked) {
          pred.checked = true;
          pred.result  = 'WIN';
          pred.hitAt   = pred.atr.hitAt;
        }
        updated = true;
      } else if (currentLow <= pred.atr.stopLoss) {
        pred.atr.result  = 'LOSS';
        pred.atr.checked = true;
        pred.atr.hitAt   = new Date().toISOString();
        if (!pred.checked) {
          pred.checked = true;
          pred.result  = 'LOSS';
          pred.hitAt   = pred.atr.hitAt;
        }
        updated = true;
      }
    }
  }

  if (updated) await savePredictions(all);

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
async function getAccuracySummary(symbol) {
  const all        = await loadPredictions();
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
async function getAllAccuracies() {
  const all = await loadPredictions();
  const summaries = [];
  for (const symbol of Object.keys(all)) {
    summaries.push(await getAccuracySummary(symbol));
  }
  return summaries
    .filter(r => r.totalCompleted >= MIN_COMPLETED)
    .sort((a, b) => (b.pivotAccuracy || 0) - (a.pivotAccuracy || 0));
}

module.exports = {
  createPrediction,
  checkPrediction,
  getAccuracySummary,
  getAllAccuracies,
  autoPredict
};