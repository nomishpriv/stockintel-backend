//orderFlowService
const fs = require('fs');
const path = require('path');

const RESET_INTERVAL = 15 * 60 * 1000; // 15 minutes
const MAX_SNAPSHOTS = 15; // 1 snapshot per minute for 15 min

const ORDER_FLOW_FILE = path.join(__dirname, '..', '.orderflow.json');

// FIX: Promise cache so concurrent loads share one disk read instead of
// hammering the filesystem when analyzeRatio / recordFromStocks are
// called in rapid succession (e.g., 500+ times per fetch cycle).
let loadPromise = null;
// FIX: Write queue so overlapping saves don't corrupt JSON by reading
// stale data, mutating it, and writing over a newer version.
let saveQueue = Promise.resolve();

// ========== LOAD / SAVE ==========
async function loadOrderFlow() {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const raw = await fs.promises.readFile(ORDER_FLOW_FILE, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

async function saveOrderFlow(data) {
  saveQueue = saveQueue.then(async () => {
    try {
      const dir = path.dirname(ORDER_FLOW_FILE);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(ORDER_FLOW_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('❌ Failed to save order flow:', e.message);
    }
  }).catch(() => {});

  return saveQueue;
}

// ========== RECORD SNAPSHOT ==========
async function recordSnapshot(symbol, bidVolume, askVolume, bidPrice, askPrice, price) {
  // FIX: Guard against invalid inputs that would corrupt the file or
  // produce nonsensical calculations (e.g., missing symbol or zero price).
  if (!symbol || typeof symbol !== 'string') return;
  if (price <= 0) return;

  const all = await loadOrderFlow();

  if (!all[symbol]) {
    all[symbol] = { snapshots: [], lastReset: Date.now() };
  }

  const stock = all[symbol];
  const now = Date.now();

  // Reset every 30 minutes
if (now - stock.lastReset > 900000) {   // 15 minutes
      stock.lastReset = now;
    stock.snapshots = [];
  }

  // Add snapshot
  stock.snapshots.push({
    time: new Date().toISOString(),
    bidVolume,
    askVolume,
    bidPrice,
    askPrice,
    price,
    ratio: askVolume > 0 ? +(bidVolume / askVolume).toFixed(2) : 0,
    spread: bidPrice > 0 ? +(((askPrice - bidPrice) / bidPrice) * 100).toFixed(2) : 0
  });

  // Keep last 30 snapshots (30 minutes at 1/min)
  if (stock.snapshots.length > 30) {
    stock.snapshots = stock.snapshots.slice(-30);
  }

  await saveOrderFlow(all);
}

// ========== ANALYZE RATIO ==========
async function analyzeRatio(symbol) {
  // FIX: Guard so missing/invalid symbols fail gracefully instead of
  // crashing downstream destructuring.
  if (!symbol || typeof symbol !== 'string') {
    return { symbol: symbol || 'N/A', message: 'Invalid symbol', ready: false };
  }

  const all = await loadOrderFlow();
  const stock = all[symbol];

  if (!stock || stock.snapshots.length < 3) {
    return { symbol, message: 'Collecting data...', ready: false };
  }

  const snaps = stock.snapshots;

  // Calculate totals for the window
  const totalBid = snaps.reduce((s, n) => s + n.bidVolume, 0);
  const totalAsk = snaps.reduce((s, n) => s + n.askVolume, 0);
  const overallRatio = totalAsk > 0 ? +(totalBid / totalAsk).toFixed(2) : 1;

  // Trend: compare first half vs second half
  const half = Math.floor(snaps.length / 2);
  const firstHalf = snaps.slice(0, half);
  const secondHalf = snaps.slice(-half);

  // FIX: Defensive guard against empty slices. Although the < 3 guard
  // above catches most cases, a window of exactly 2 items would make
  // half = 1 and slices safe; this guard protects against future changes.
  const firstRatio = firstHalf.length > 0
    ? firstHalf.reduce((s, n) => s + n.ratio, 0) / firstHalf.length
    : 0;
  const secondRatio = secondHalf.length > 0
    ? secondHalf.reduce((s, n) => s + n.ratio, 0) / secondHalf.length
    : 0;

  let trend, color;
  if (secondRatio > firstRatio * 1.3) {
    trend = 'BUYING_INCREASING';
    color = '#22c55e';
  } else if (secondRatio < firstRatio * 0.7) {
    trend = 'SELLING_INCREASING';
    color = '#ef4444';
  } else if (overallRatio > 1.5) {
    trend = 'BUYERS_DOMINANT';
    color = '#22c55e';
  } else if (overallRatio < 0.5) {
    trend = 'SELLERS_DOMINANT';
    color = '#ef4444';
  } else {
    trend = 'BALANCED';
    color = '#f59e0b';
  }

  // Latest spread
  const latestSpread = snaps[snaps.length - 1]?.spread || 0;

  return {
    symbol,
    ready: true,
    snapshots: snaps.length,
    windowMinutes: Math.round((Date.now() - stock.lastReset) / 60000),
    totalBidVolume: totalBid,
    totalAskVolume: totalAsk,
    overallRatio,
    firstHalfRatio: +firstRatio.toFixed(2),
    secondHalfRatio: +secondRatio.toFixed(2),
    trend,
    color,
    latestSpread,
    signal: trend === 'BUYING_INCREASING' ? '🟢 Buy pressure building' :
            trend === 'SELLING_INCREASING' ? '🔴 Sell pressure building' :
            trend === 'BUYERS_DOMINANT' ? '🟢 Buyers in control' :
            trend === 'SELLERS_DOMINANT' ? '🔴 Sellers in control' :
            '🟡 Balanced — wait for direction'
  };
}

// ========== RECORD FROM STOCK DATA ==========
// FIX: Completely rewrote to batch-process instead of calling recordSnapshot
// per stock. The old code loaded the entire JSON file from disk N times for
// N stocks (e.g., 500 reads per fetch cycle) and saved N times, which was
// O(n²) disk I/O and blocked the event loop with sync fs calls. Now it
// loads once, records all snapshots in memory, and saves once.
// NOTE: This function is now async. The caller in stockIntelService should
// await it (or at least handle the returned Promise) to ensure writes flush.
async function recordFromStocks(stocks) {
  if (!Array.isArray(stocks) || stocks.length === 0) return;

  const all = await loadOrderFlow();
  const now = Date.now();

  for (const stock of stocks) {
    // Skip stocks with no order-flow data instead of still touching the file.
    if (stock.bidVolume <= 0 && stock.askVolume <= 0) continue;
    if (stock.price <= 0) continue;

    const symbol = stock.symbol;
    if (!all[symbol]) {
      all[symbol] = { snapshots: [], lastReset: now };
    }

    const entry = all[symbol];

    // Reset every 30 minutes
    if (now - entry.lastReset >  RESET_INTERVAL) {
      entry.lastReset = now;
      entry.snapshots = [];
    }

    entry.snapshots.push({
      time: new Date().toISOString(),
      bidVolume: stock.bidVolume,
      askVolume: stock.askVolume,
      bidPrice: stock.bidPrice,
      askPrice: stock.askPrice,
      price: stock.price,
      ratio: stock.askVolume > 0 ? +(stock.bidVolume / stock.askVolume).toFixed(2) : 0,
      spread: stock.bidPrice > 0 ? +(((stock.askPrice - stock.bidPrice) / stock.bidPrice) * 100).toFixed(2) : 0
    });

    if (entry.snapshots.length > MAX_SNAPSHOTS) {
  entry.snapshots = entry.snapshots.slice(-MAX_SNAPSHOTS);
}
  }

  await saveOrderFlow(all);
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW: TICK TRADE ANALYSIS (time-and-sales data from /trading/trades)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyzes raw tick data from StockIntel /trading/trades endpoint.
 * Determines buyer-initiated vs seller-initiated volume.
 * 
 * Tick format: { m, s, t, tx, x, v, tsq, tsqb, tsqs, xi, xt }
 * x = price, v = volume, tsqb = bid queue, tsqs = ask queue
 */
function analyzeTickTrades(symbol, trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { symbol, ready: false, message: 'No tick data' };
  }

  let buyVolume = 0;      // Green trades (hitting ask)
  let sellVolume = 0;     // Red trades (hitting bid)
  let totalVolume = 0;
  let lastPrice = trades[0].x || 0;
  let lastBidQueue = trades[0].tsqb || 0;
  let lastAskQueue = trades[0].tsqs || 0;

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const price = trade.x || 0;
    const vol = trade.v || 0;
    const bidQueue = trade.tsqb || 0;
    const askQueue = trade.tsqs || 0;

    totalVolume += vol;

    // Method 1: Price momentum (trade at or above last price = buyer aggressive)
    // Method 2: Queue depletion (bid queue drops = seller hit bid, ask queue drops = buyer lifted ask)
    let isBuy = false;

    if (i === 0) {
      // First trade: compare to next or use queue logic
      isBuy = (bidQueue < lastBidQueue) || (askQueue === 0 && bidQueue > 0);
    } else {
      // Price went up or held = buyer initiated
      if (price >= lastPrice) {
        isBuy = true;
      } else {
        isBuy = false;
      }
    }

    // Refine with queue data when available
    if (bidQueue === 0 && askQueue > 0) {
      // All bids got hit = strong selling
      isBuy = false;
    } else if (askQueue === 0 && bidQueue > 0) {
      // All asks got lifted = strong buying
      isBuy = true;
    }

    if (isBuy) {
      buyVolume += vol;
    } else {
      sellVolume += vol;
    }

    lastPrice = price;
    lastBidQueue = bidQueue;
    lastAskQueue = askQueue;
  }

  const ratio = sellVolume > 0 ? +(buyVolume / sellVolume).toFixed(2) : (buyVolume > 0 ? 99 : 1);
  const buyPct = totalVolume > 0 ? +((buyVolume / totalVolume) * 100).toFixed(1) : 0;
  const sellPct = totalVolume > 0 ? +((sellVolume / totalVolume) * 100).toFixed(1) : 0;

  let trend, color, signal;
  if (ratio > 2.0 && buyPct > 65) {
    trend = 'STRONG_BUYING'; color = '#22c55e'; signal = '🟢🟢 Strong buying';
  } else if (ratio > 1.3 && buyPct > 55) {
    trend = 'BUYING'; color = '#84cc16'; signal = '🟢 Buying';
  } else if (ratio < 0.5 && sellPct > 65) {
    trend = 'STRONG_SELLING'; color = '#ef4444'; signal = '🔴🔴 Strong selling';
  } else if (ratio < 0.8 && sellPct > 55) {
    trend = 'SELLING'; color = '#f97316'; signal = '🔴 Selling';
  } else {
    trend = 'NEUTRAL'; color = '#f59e0b'; signal = '⚪ Neutral';
  }

  return {
    symbol,
    ready: true,
    totalTrades: trades.length,
    totalVolume,
    buyVolume,
    sellVolume,
    buyPct,
    sellPct,
    ratio,
    trend,
    color,
    signal,
    lastPrice: lastPrice.toFixed(2)
  };
}

module.exports = { recordFromStocks, analyzeRatio, recordSnapshot, analyzeTickTrades };