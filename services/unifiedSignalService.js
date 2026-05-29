// services/unifiedSignalService.js
const si = require('./stockIntelService');
const smcService = require('./smcService');
const predictService = require('./predictService');
const newsService = require('./newsService');
const institutionalService = require('./institutionalActivityService');
const orderFlowService = require('./orderFlowService');
const resultService = require('./resultAnnouncementService');

const CACHE = new Map();
const TTL = 15000; // 15 seconds per symbol

function getCache(symbol) {
  const e = CACHE.get(symbol);
  if (e && Date.now() - e.t < TTL) return e.d;
  return null;
}
function setCache(symbol, data) {
  CACHE.set(symbol, { d: data, t: Date.now() });
}

const SIGNAL_META = [
  { threshold: 60,  key: 'STRONG_BUY',  color: '#00c853', emoji: '🟢🟢', action: 'Strong Buy'  },
  { threshold: 35,  key: 'BUY',         color: '#22c55e', emoji: '🟢',   action: 'Buy'         },
  { threshold: 10,  key: 'WAIT',        color: '#f59e0b', emoji: '🟡',   action: 'Wait'        },
  { threshold: -10, key: 'NEUTRAL',     color: '#94a3b8', emoji: '⚪',   action: 'Neutral'     },
  { threshold: -35, key: 'SELL',        color: '#ef4444', emoji: '🔴',   action: 'Sell'        },
  { threshold: -100,key: 'STRONG_SELL', color: '#d50000', emoji: '🔴🔴', action: 'Strong Sell' }
];

function mapSignal(score) {
  for (const s of SIGNAL_META) {
    if (score >= s.threshold) return s;
  }
  return SIGNAL_META[SIGNAL_META.length - 1];
}

function calcRisk(stock, flowData) {
  if (!stock) return 'HIGH';
  if (stock.spreadPct > 0.3 || stock.volume < 50000) return 'HIGH';
  if (stock.spreadPct > 0.15 || stock.volume < 100000) return 'MEDIUM';
  return 'LOW';
}

function buildDescription(signal, factors, stock, flowData, predCheck) {
  const top3 = factors
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 3);

  if (top3.length === 0) {
    return `${signal.emoji} ${signal.action} — Insufficient data. Trade on technicals only.`;
  }

  const parts = top3.map(f => f.text);
  let desc = `${signal.emoji} ${signal.action} — ${parts.join(' + ')}`;

  const entry = (stock.s1 > 0) ? stock.s1 : (stock.pivot > 0 ? stock.pivot : null);
  const target = (stock.r1 > 0) ? stock.r1 : (stock.r2 > 0 ? stock.r2 : null);
  const sl = (stock.s2 > 0) ? stock.s2 : (stock.s1 > 0 ? stock.s1 : null);

  if (entry && target) {
    desc += `. Entry: ₨${entry.toFixed(2)}, Target: ₨${target.toFixed(2)}`;
    if (sl) desc += `, SL: ₨${sl.toFixed(2)}`;
  }

  if (predCheck?.bestMethod) {
    const acc = predCheck.bestMethod === 'PIVOT' ? predCheck.pivot.accuracy : predCheck.atr.accuracy;
    if (acc && acc > 0) {
      desc += ` | ${acc}% ${predCheck.bestMethod} track`;
    }
  }

  if (signal.key === 'STRONG_BUY' || signal.key === 'BUY') {
    if (flowData?.trend === 'BUYING_INCREASING') desc += `. Move likely in 15-30m`;
    else desc += `. Accumulate near entry`;
  } else if (signal.key === 'SELL' || signal.key === 'STRONG_SELL') {
    desc += `. Exit on rallies`;
  } else if (signal.key === 'WAIT') {
    desc += `. Await confirmation`;
  }

  return desc;
}

async function getUnifiedSignal(symbol) {
  const cached = getCache(symbol);
  if (cached) return cached;

  const stock = await si.getStock(symbol);
  if (!stock) return null;

  const [smcData, flowData, predCheck, newsSignal, instData, resultData] = await Promise.all([
    smcService.getSMCSignals(symbol).catch(() => null),
    orderFlowService.analyzeRatio(symbol).catch(() => null),
    predictService.checkPrediction(symbol, stock.price, stock.high, stock.low).catch(() => null),
    newsService.getQuickSignal().catch(() => null),
    institutionalService.analyzeInstitutionalActivity().catch(() => null),
    resultService.getStockResult(symbol).catch(() => null)
  ]);

  let score = 0;
  const factors = [];

  // ─── TECHNICAL ───
  if (stock.pivot > 0 && stock.price > stock.pivot) {
    score += 6; factors.push({ text: 'Above pivot', weight: 6 });
  } else if (stock.pivot > 0 && stock.price < stock.pivot) {
    score -= 4; factors.push({ text: 'Below pivot', weight: -4 });
  }

  if (stock.s1 > 0 && stock.price > stock.s1) {
    score += 3; factors.push({ text: 'Above S1 support', weight: 3 });
  }

  if (stock.rsi > 40 && stock.rsi < 60) {
    score += 4; factors.push({ text: 'RSI healthy', weight: 4 });
  } else if (stock.rsi > 0 && stock.rsi < 35) {
    score += 6; factors.push({ text: 'RSI oversold bounce', weight: 6 });
  } else if (stock.rsi > 70) {
    score -= 5; factors.push({ text: 'RSI overbought', weight: -5 });
  }

  if (stock.volAvg10d > 0 && stock.volume > stock.volAvg10d * 1.5) {
    score += 6; factors.push({ text: 'Volume 150%+ avg', weight: 6 });
  } else if (stock.volAvg10d > 0 && stock.volume > stock.volAvg10d * 1.2) {
    score += 3; factors.push({ text: 'Volume above avg', weight: 3 });
  }

  if (stock.changePercent > 1.5) {
    score += 4; factors.push({ text: 'Strong momentum', weight: 4 });
  } else if (stock.changePercent < -1.5) {
    score -= 4; factors.push({ text: 'Negative momentum', weight: -4 });
  }

  if (stock.spreadPct > 0 && stock.spreadPct < 0.1) {
    score += 2; factors.push({ text: 'Tight spread', weight: 2 });
  }

  if (stock.open > 0 && stock.price > stock.open) {
    score += 3; factors.push({ text: 'Above open', weight: 3 });
  } else if (stock.open > 0 && stock.price < stock.open) {
    score -= 3; factors.push({ text: 'Below open', weight: -3 });
  }

  // ─── SMC ───
  if (smcData?.fvg?.length > 0) {
    const f = smcData.fvg[0];
    if (f.type === 'BULLISH_FVG') {
      score += 8; factors.push({ text: `Bullish FVG ${f.zone.bottom.toFixed(1)}-${f.zone.top.toFixed(1)}`, weight: 8 });
    } else {
      score -= 8; factors.push({ text: `Bearish FVG ${f.zone.top.toFixed(1)}-${f.zone.bottom.toFixed(1)}`, weight: -8 });
    }
  }

  if (smcData?.orderBlocks?.length > 0) {
    const ob = smcData.orderBlocks[0];
    if (ob.type === 'BULLISH_OB') {
      score += 7; factors.push({ text: `Bullish OB ${ob.zone.bottom.toFixed(1)}-${ob.zone.top.toFixed(1)}`, weight: 7 });
    } else {
      score -= 7; factors.push({ text: `Bearish OB ${ob.zone.top.toFixed(1)}-${ob.zone.bottom.toFixed(1)}`, weight: -7 });
    }
  }

  if (smcData?.liquiditySweeps?.length > 0) {
    const sw = smcData.liquiditySweeps[0];
    if (sw.type === 'BULLISH_SWEEP') {
      score += 6; factors.push({ text: 'Liquidity sweep (trapped sellers)', weight: 6 });
    } else {
      score -= 6; factors.push({ text: 'Liquidity sweep (trapped buyers)', weight: -6 });
    }
  }

  if (smcData?.bos?.length > 0) {
    const b = smcData.bos[smcData.bos.length - 1];
    if (b.type === 'BULLISH') {
      score += 5; factors.push({ text: 'Break of structure (bullish)', weight: 5 });
    } else {
      score -= 5; factors.push({ text: 'Break of structure (bearish)', weight: -5 });
    }
  }

  if (smcData?.choch?.length > 0) {
    const c = smcData.choch[smcData.choch.length - 1];
    if (c.type === 'BULLISH_CHOCH') {
      score += 6; factors.push({ text: 'Trend reversal to bullish', weight: 6 });
    } else {
      score -= 6; factors.push({ text: 'Trend reversal to bearish', weight: -6 });
    }
  }

  // ─── ORDER FLOW ───
  if (flowData?.ready) {
    if (flowData.trend === 'BUYING_INCREASING') {
      score += 10; factors.push({ text: `Bid pressure surging (ratio ${flowData.overallRatio})`, weight: 10 });
    } else if (flowData.trend === 'BUYERS_DOMINANT') {
      score += 7; factors.push({ text: `Buyers dominant (ratio ${flowData.overallRatio})`, weight: 7 });
    } else if (flowData.trend === 'SELLING_INCREASING') {
      score -= 10; factors.push({ text: `Sell pressure surging (ratio ${flowData.overallRatio})`, weight: -10 });
    } else if (flowData.trend === 'SELLERS_DOMINANT') {
      score -= 7; factors.push({ text: `Sellers dominant (ratio ${flowData.overallRatio})`, weight: -7 });
    } else {
      score += 1; factors.push({ text: 'Order flow balanced', weight: 1 });
    }
  }

  // ─── PREDICTIONS ───
  if (predCheck) {
    if (predCheck.pivot?.accuracy >= 60) {
      score += 5; factors.push({ text: `Pivot accuracy ${predCheck.pivot.accuracy}%`, weight: 5 });
    }
    if (predCheck.atr?.accuracy >= 60) {
      score += 4; factors.push({ text: `ATR accuracy ${predCheck.atr.accuracy}%`, weight: 4 });
    }
    if (predCheck.bestMethod && predCheck[predCheck.bestMethod.toLowerCase()]?.accuracy >= 60) {
      score += 3; factors.push({ text: `Best method: ${predCheck.bestMethod}`, weight: 3 });
    }
    if (predCheck.active > 0) {
      score += 3; factors.push({ text: `${predCheck.active} active prediction(s)`, weight: 3 });
    }
  }

  // ─── NEWS & MACRO ───
  if (newsSignal) {
    if (newsSignal.sentiment === 'BULLISH') {
      score += 4; factors.push({ text: 'News sentiment bullish', weight: 4 });
    } else if (newsSignal.sentiment === 'BEARISH') {
      score -= 4; factors.push({ text: 'News sentiment bearish', weight: -4 });
    }
    if (newsSignal.impactScore > 5) {
      score += 3; factors.push({ text: 'High news impact', weight: 3 });
    } else if (newsSignal.impactScore < -5) {
      score -= 3; factors.push({ text: 'Negative news impact', weight: -3 });
    }
  }

  if (instData) {
    if (instData.activityType === 'HEAVY_ACCUMULATION' || instData.activityType === 'ACCUMULATION') {
      score += 5; factors.push({ text: 'Institutional accumulation', weight: 5 });
    } else if (instData.activityType === 'HEAVY_DISTRIBUTION' || instData.activityType === 'DISTRIBUTION') {
      score -= 5; factors.push({ text: 'Institutional distribution', weight: -5 });
    } else if (instData.bullishTrigger) {
      score += 3; factors.push({ text: 'Consecutive accumulation days', weight: 3 });
    }
  }

  // ─── RESULTS ───
  if (resultData) {
    if (resultData.impact === 'STRONG_POSITIVE') {
      score += 8; factors.push({ text: 'Strong earnings surprise', weight: 8 });
    } else if (resultData.impact === 'POSITIVE') {
      score += 5; factors.push({ text: 'Positive earnings', weight: 5 });
    } else if (resultData.impact === 'STRONG_NEGATIVE') {
      score -= 8; factors.push({ text: 'Major earnings miss', weight: -8 });
    } else if (resultData.impact === 'NEGATIVE') {
      score -= 5; factors.push({ text: 'Negative earnings', weight: -5 });
    }
  }

  const signal = mapSignal(score);
  const confidence = Math.min(100, Math.max(0, Math.abs(score)));
  const risk = calcRisk(stock, flowData);
  const description = buildDescription(signal, factors, stock, flowData, predCheck);

  const result = {
    symbol: stock.symbol,
    name: stock.name,
    price: stock.price,
    changePercent: stock.changePercent,
    volume: stock.volume,
    volAvg10d: stock.volAvg10d || 0,
    rsi: stock.rsi,

    signal: signal.key,
    signalMeta: signal,
    score,
    confidence,
    risk,
    description,

    levels: {
      entry: stock.s1 > 0 ? stock.s1 : stock.pivot,
      target: stock.r1 > 0 ? stock.r1 : stock.r2,
      stopLoss: stock.s2 > 0 ? stock.s2 : stock.s1,
      pivot: stock.pivot,
      r1: stock.r1, r2: stock.r2, s1: stock.s1, s2: stock.s2
    },

    details: {
      smc: smcData,
      orderFlow: flowData,
      prediction: predCheck,
      news: newsSignal,
      institutional: instData,
      result: resultData
    },

    timestamp: new Date().toISOString()
  };

  setCache(symbol, result);
  return result;
}

async function getUnifiedSignalsForStocks(symbols) {
  const results = await Promise.all(
    symbols.map(sym => getUnifiedSignal(sym).catch(() => null))
  );
  return results.filter(Boolean).sort((a, b) => b.score - a.score);
}

module.exports = { getUnifiedSignal, getUnifiedSignalsForStocks };