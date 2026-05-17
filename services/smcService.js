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

async function getSMCSignals(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const sixtyDaysAgo = now - 5184000;
  const bars = await fetchBars(symbol, sixtyDaysAgo, now, '1D');
  if (bars.length < 10) return null;
  return {
    fvg: detectFVG(bars),
    orderBlocks: detectOrderBlocks(bars),
    bos: detectBOS(bars),
    choch: detectCHOCH(bars),
    totalBars: bars.length,
    lastBar: bars[bars.length - 1]
  };
}

module.exports = { getSMCSignals };