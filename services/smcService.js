const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = 'https://app.stockintel.com/api';

function getToken() {
  try {
    const tokenFile = path.join(__dirname, '..', '.token.json');
    const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    return data.token;
  } catch {
    return process.env.STOCKINTEL_TOKEN || '';
  }
}

async function fetchBars(symbol, from, to, freq = '1D') {
  const { data } = await axios.get(`${BASE}/market/bars`, {
    params: { symbol, from, to, freq, div_adj: 1 },
    headers: { Authorization: `Bearer ${getToken()}` },
    timeout: 10000
  });
  return data?.data || [];
}

function detectFVG(bars) {
  const fvgs = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
    if (c3.low > c1.high) {
      fvgs.push({ type: 'BULLISH', time: c3.time, gap: +(c3.low - c1.high).toFixed(2), zone: { top: c3.low, bottom: c1.high }, message: `Bullish FVG at ${c1.high}-${c3.low}` });
    } else if (c3.high < c1.low) {
      fvgs.push({ type: 'BEARISH', time: c3.time, gap: +(c1.low - c3.high).toFixed(2), zone: { top: c1.low, bottom: c3.high }, message: `Bearish FVG at ${c3.high}-${c1.low}` });
    }
  }
  return fvgs.slice(-5);
}

function detectOrderBlocks(bars) {
  const obs = [];
  for (let i = 3; i < bars.length; i++) {
    const prev = bars[i - 1], curr = bars[i];
    const move = ((curr.close - curr.open) / curr.open) * 100;
    if (move > 2 && prev.close < prev.open) {
      obs.push({ type: 'BULLISH', time: prev.time, zone: { top: prev.high, bottom: prev.low }, message: `Bullish OB at ${prev.low}-${prev.high}` });
    } else if (move < -2 && prev.close > prev.open) {
      obs.push({ type: 'BEARISH', time: prev.time, zone: { top: prev.high, bottom: prev.low }, message: `Bearish OB at ${prev.low}-${prev.high}` });
    }
  }
  return obs.slice(-5);
}

function detectBOS(bars) {
  const swings = [];
  for (let i = 2; i < bars.length - 1; i++) {
    if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i + 1].high) swings.push({ type: 'HIGH', time: bars[i].time, price: bars[i].high });
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i + 1].low) swings.push({ type: 'LOW', time: bars[i].time, price: bars[i].low });
  }
  const bos = [], recent = swings.slice(-10);
  for (let i = 1; i < recent.length; i++) {
    const p = recent[i - 1], c = recent[i];
    if (p.type === 'HIGH' && c.type === 'HIGH' && c.price > p.price) bos.push({ type: 'BULLISH', time: c.time, price: c.price, message: `BOS: Break above ${p.price}` });
    if (p.type === 'LOW' && c.type === 'LOW' && c.price < p.price) bos.push({ type: 'BEARISH', time: c.time, price: c.price, message: `BOS: Break below ${p.price}` });
  }
  return bos.slice(-3);
}

function detectCHOCH(bars) {
  const bosList = detectBOS(bars), choch = [];
  for (let i = 1; i < bosList.length; i++) {
    if (bosList[i - 1].type === 'BEARISH' && bosList[i].type === 'BULLISH') choch.push({ type: 'BULLISH_CHOCH', time: bosList[i].time, message: 'Trend reversal — now bullish' });
    if (bosList[i - 1].type === 'BULLISH' && bosList[i].type === 'BEARISH') choch.push({ type: 'BEARISH_CHOCH', time: bosList[i].time, message: 'Trend reversal — now bearish' });
  }
  return choch.slice(-2);
}

// ========== LIQUIDITY SWEEPS ==========
function detectLiquiditySweeps(bars) {
  const sweeps = [];
  
  for (let i = 3; i < bars.length - 1; i++) {
    const prev2 = bars[i - 2];
    const prev1 = bars[i - 1];
    const curr = bars[i];
    const next = bars[i + 1];

    if (prev1.high > prev2.high && curr.high > prev1.high && next.close < prev1.high) {
      sweeps.push({
        type: 'BEARISH_SWEEP',
        time: curr.time,
        level: prev1.high,
        message: `Liquidity sweep above ${prev1.high} — trapped buyers, likely reversal down`
      });
    }

    if (prev1.low < prev2.low && curr.low < prev1.low && next.close > prev1.low) {
      sweeps.push({
        type: 'BULLISH_SWEEP',
        time: curr.time,
        level: prev1.low,
        message: `Liquidity sweep below ${prev1.low} — trapped sellers, likely reversal up`
      });
    }
  }

  return sweeps.slice(-5);
}

// ========== IMPROVED ORDER BLOCKS (with volume) ==========
function detectOrderBlocksImproved(bars) {
  const obs = [];
  
  for (let i = 3; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const move = ((curr.close - curr.open) / curr.open) * 100;
    
    if (move > 2 && prev.close < prev.open && curr.volume > prev.volume * 1.2) {
      obs.push({
        type: 'BULLISH_OB',
        time: prev.time,
        zone: { top: prev.high, bottom: prev.low },
        volume: prev.volume,
        message: `Bullish OB at ${prev.low.toFixed(2)}-${prev.high.toFixed(2)} (Vol: ${(prev.volume/1000).toFixed(0)}K)`
      });
    }
    
    if (move < -2 && prev.close > prev.open && curr.volume > prev.volume * 1.2) {
      obs.push({
        type: 'BEARISH_OB',
        time: prev.time,
        zone: { top: prev.high, bottom: prev.low },
        volume: prev.volume,
        message: `Bearish OB at ${prev.low.toFixed(2)}-${prev.high.toFixed(2)} (Vol: ${(prev.volume/1000).toFixed(0)}K)`
      });
    }
  }

  return obs.slice(-5);
}

// ========== LIQUIDITY LEVELS (Equal Highs/Lows) ==========
function detectLiquidityLevels(bars) {
  const levels = [];
  const tolerance = 0.005;

  for (let i = 5; i < bars.length; i++) {
    const recent = bars.slice(i - 5, i);
    
    const highs = recent.map(b => b.high);
    const maxHigh = Math.max(...highs);
    const equalHighs = highs.filter(h => Math.abs(h - maxHigh) / maxHigh < tolerance).length;
    
    if (equalHighs >= 3) {
      const exists = levels.find(l => l.type === 'EQUAL_HIGHS' && Math.abs(l.level - maxHigh) / maxHigh < tolerance);
      if (!exists) {
        levels.push({
          type: 'EQUAL_HIGHS',
          level: +maxHigh.toFixed(2),
          touches: equalHighs,
          message: `Liquidity above at ${maxHigh.toFixed(2)} (${equalHighs} touches) — likely target for stops`
        });
      }
    }

    const lows = recent.map(b => b.low);
    const minLow = Math.min(...lows);
    const equalLows = lows.filter(l => Math.abs(l - minLow) / minLow < tolerance).length;
    
    if (equalLows >= 3) {
      const exists = levels.find(l => l.type === 'EQUAL_LOWS' && Math.abs(l.level - minLow) / minLow < tolerance);
      if (!exists) {
        levels.push({
          type: 'EQUAL_LOWS',
          level: +minLow.toFixed(2),
          touches: equalLows,
          message: `Liquidity below at ${minLow.toFixed(2)} (${equalLows} touches) — likely target for stops`
        });
      }
    }
  }

  return levels.slice(-5);
}

// ========== FAIR VALUE GAP (Improved — with gap size) ==========
function detectFVGImproved(bars) {
  const fvgs = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2], c2 = bars[i - 1], c3 = bars[i];
    
    // Bullish FVG: gap up
    if (c3.low > c1.high) {
      const gap = c3.low - c1.high;
      const gapPct = (gap / c1.high) * 100;
      if (gapPct > 0.1) { // Only significant gaps
        fvgs.push({
          type: 'BULLISH_FVG',
          time: c3.time,
          gap: +gap.toFixed(2),
          gapPct: +gapPct.toFixed(2),
          zone: { top: c3.low, bottom: c1.high },
          message: `Bullish FVG ${c1.high}-${c3.low} (${gapPct.toFixed(1)}% gap)`
        });
      }
    }
    // Bearish FVG: gap down
    else if (c3.high < c1.low) {
      const gap = c1.low - c3.high;
      const gapPct = (gap / c1.low) * 100;
      if (gapPct > 0.1) {
        fvgs.push({
          type: 'BEARISH_FVG',
          time: c3.time,
          gap: +gap.toFixed(2),
          gapPct: +gapPct.toFixed(2),
          zone: { top: c1.low, bottom: c3.high },
          message: `Bearish FVG ${c3.high}-${c1.low} (${gapPct.toFixed(1)}% gap)`
        });
      }
    }
  }
  return fvgs.slice(-5);
}

async function getSMCSignals(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const sixtyDaysAgo = now - 5184000;
  const bars = await fetchBars(symbol, sixtyDaysAgo, now, '1D');
  if (bars.length < 10) return null;
  return {
    fvg: detectFVGImproved(bars),
    orderBlocks: detectOrderBlocksImproved(bars),
    liquiditySweeps: detectLiquiditySweeps(bars),
    liquidityLevels: detectLiquidityLevels(bars),
    bos: detectBOS(bars),
    choch: detectCHOCH(bars),
    totalBars: bars.length,
    lastBar: bars[bars.length - 1]
  };
}

module.exports = { getSMCSignals };