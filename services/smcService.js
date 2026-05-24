const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = 'https://app.stockintel.com/api';

// FIX: Switched to async token loader so sync file I/O doesn't block the
// event loop inside an async path. Also adds expiry check so stale tokens
// are rejected instead of being sent to the API.
async function getToken() {
  try {
    const tokenFile = path.join(__dirname, '..', '.token.json');
    const raw = await fs.promises.readFile(tokenFile, 'utf8');
    const data = JSON.parse(raw);
    if (data.expiry > Date.now()) return data.token;
  } catch {
    // File missing, malformed, or expired — fall back to env
  }
  return process.env.STOCKINTEL_TOKEN || '';
}

// FIX: Added input validation and try/catch so a network or auth failure
// returns an empty array instead of throwing uncaught and crashing the caller.
async function fetchBars(symbol, from, to, freq = '1D') {
  if (!symbol || typeof symbol !== 'string') return [];
  try {
    const { data } = await axios.get(`${BASE}/market/bars`, {
      params: { symbol, from, to, freq, div_adj: 1 },
      headers: { Authorization: `Bearer ${await getToken()}` },
      timeout: 10000
    });
    return data?.data || [];
  } catch (e) {
    console.error(`❌ fetchBars failed for ${symbol}:`, e.response?.status || e.message);
    return [];
  }
}

// Legacy FVG detector — kept for backward compatibility.
// getSMCSignals now uses detectFVGImproved instead.
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

// Legacy order-block detector — kept for backward compatibility.
// getSMCSignals now uses detectOrderBlocksImproved instead.
function detectOrderBlocks(bars) {
  const obs = [];
  for (let i = 3; i < bars.length; i++) {
    const prev = bars[i - 1], curr = bars[i];
    // FIX: Guard against zero open to prevent NaN / Infinity in percent move.
    if (!curr.open || curr.open <= 0) continue;
    const move = ((curr.close - curr.open) / curr.open) * 100;
    if (move > 2 && prev.close < prev.open) {
      obs.push({ type: 'BULLISH', time: prev.time, zone: { top: prev.high, bottom: prev.low }, message: `Bullish OB at ${prev.low}-${prev.high}` });
    } else if (move < -2 && prev.close > prev.open) {
      obs.push({ type: 'BEARISH', time: prev.time, zone: { top: prev.high, bottom: prev.low }, message: `Bearish OB at ${prev.low}-${prev.high}` });
    }
  }
  return obs.slice(-5);
}

// FIX: Completely rewrote swing-comparison logic.
// Old code compared adjacent items in the swings array (HIGH, LOW, HIGH, LOW…),
// so same-type matches were almost impossible and BOS almost never fired.
// Now we track the last swing high and last swing low independently and
// compare the current swing against the previous one of the same type.
function detectBOS(bars) {
  const swings = [];
  for (let i = 2; i < bars.length - 1; i++) {
    if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i + 1].high) {
      swings.push({ type: 'HIGH', time: bars[i].time, price: bars[i].high });
    }
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i + 1].low) {
      swings.push({ type: 'LOW', time: bars[i].time, price: bars[i].low });
    }
  }

  const bos = [];
  let lastHigh = null;
  let lastLow = null;

  for (const swing of swings) {
    if (swing.type === 'HIGH') {
      if (lastHigh && swing.price > lastHigh.price) {
        bos.push({ type: 'BULLISH', time: swing.time, price: swing.price, message: `BOS: Break above ${lastHigh.price}` });
      }
      lastHigh = swing;
    } else if (swing.type === 'LOW') {
      if (lastLow && swing.price < lastLow.price) {
        bos.push({ type: 'BEARISH', time: swing.time, price: swing.price, message: `BOS: Break below ${lastLow.price}` });
      }
      lastLow = swing;
    }
  }

  return bos.slice(-3);
}

// CHOCH depends on detectBOS; it works correctly once BOS is fixed.
function detectCHOCH(bars) {
  const bosList = detectBOS(bars), choch = [];
  for (let i = 1; i < bosList.length; i++) {
    if (bosList[i - 1].type === 'BEARISH' && bosList[i].type === 'BULLISH') {
      choch.push({ type: 'BULLISH_CHOCH', time: bosList[i].time, message: 'Trend reversal — now bullish' });
    }
    if (bosList[i - 1].type === 'BULLISH' && bosList[i].type === 'BEARISH') {
      choch.push({ type: 'BEARISH_CHOCH', time: bosList[i].time, message: 'Trend reversal — now bearish' });
    }
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
    // FIX: Guard against zero open to prevent NaN / Infinity in percent move.
    if (!curr.open || curr.open <= 0) continue;
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

    // FIX: Guard against maxHigh === 0 to avoid division by zero in tolerance check.
    if (maxHigh > 0) {
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
    }

    const lows = recent.map(b => b.low);
    const minLow = Math.min(...lows);

    // FIX: Guard against minLow === 0 to avoid division by zero in tolerance check.
    if (minLow > 0) {
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
      // FIX: Guard against c1.high === 0 to avoid division by zero when
      // calculating gap percentage.
      if (c1.high > 0) {
        const gap = c3.low - c1.high;
        const gapPct = (gap / c1.high) * 100;
        if (gapPct > 0.1) {
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
    }
    // Bearish FVG: gap down
    else if (c3.high < c1.low) {
      if (c1.low > 0) {
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
  }
  return fvgs.slice(-5);
}

async function getSMCSignals(symbol) {
  // FIX: Guard so null / non-string symbols fail gracefully instead of
  // reaching the API with an invalid request.
  if (!symbol || typeof symbol !== 'string') {
    return { fvg: [], orderBlocks: [], liquiditySweeps: [], liquidityLevels: [], bos: [], choch: [], totalBars: 0, lastBar: null };
  }

  const now = Math.floor(Date.now() / 1000);
  const sixtyDaysAgo = now - 5184000;

  try {
    const bars = await fetchBars(symbol, sixtyDaysAgo, now, '1D');
    if (bars.length < 10) {
      // FIX: Return an empty structured object instead of null so the caller
      // can safely destructure without checking for null everywhere.
      return { fvg: [], orderBlocks: [], liquiditySweeps: [], liquidityLevels: [], bos: [], choch: [], totalBars: bars.length, lastBar: null };
    }
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
  } catch (e) {
    // FIX: Catch any unexpected error and return a safe empty structure
    // instead of letting an exception bubble up and crash the consumer.
    console.error('❌ getSMCSignals failed:', e.message);
    return { fvg: [], orderBlocks: [], liquiditySweeps: [], liquidityLevels: [], bos: [], choch: [], totalBars: 0, lastBar: null };
  }
}

module.exports = { getSMCSignals };