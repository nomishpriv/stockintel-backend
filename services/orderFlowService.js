const fs = require('fs');
const path = require('path');

const ORDER_FLOW_FILE = path.join(__dirname, '..', '.orderflow.json');

// ========== LOAD / SAVE ==========
function loadOrderFlow() {
  try {
    if (fs.existsSync(ORDER_FLOW_FILE)) {
      return JSON.parse(fs.readFileSync(ORDER_FLOW_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveOrderFlow(data) {
  fs.writeFileSync(ORDER_FLOW_FILE, JSON.stringify(data, null, 2));
}

// ========== RECORD SNAPSHOT ==========
function recordSnapshot(symbol, bidVolume, askVolume, bidPrice, askPrice, price) {
  const all = loadOrderFlow();
  
  if (!all[symbol]) {
    all[symbol] = { snapshots: [], lastReset: Date.now() };
  }

  const stock = all[symbol];
  const now = Date.now();

  // Reset every 30 minutes
  if (now - stock.lastReset > 1800000) {
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

  saveOrderFlow(all);
}

// ========== ANALYZE RATIO ==========
function analyzeRatio(symbol) {
  const all = loadOrderFlow();
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
  
  const firstRatio = firstHalf.reduce((s, n) => s + n.ratio, 0) / firstHalf.length;
  const secondRatio = secondHalf.reduce((s, n) => s + n.ratio, 0) / secondHalf.length;
  
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
function recordFromStocks(stocks) {
  for (const stock of stocks) {
    if (stock.bidVolume > 0 || stock.askVolume > 0) {
      recordSnapshot(
        stock.symbol,
        stock.bidVolume,
        stock.askVolume,
        stock.bidPrice,
        stock.askPrice,
        stock.price
      );
    }
  }
}

module.exports = { recordFromStocks, analyzeRatio, recordSnapshot };