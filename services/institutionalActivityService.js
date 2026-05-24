const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Use getToken from stockIntelService instead of re-declaring
const { getToken } = require('./stockIntelService');

// ========== FETCH HISTORICAL KSE-100 BARS ==========
async function fetchKSE100History(days = 20) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - (days * 86400);
  
  const token = await getToken();  // ← Add await here
  
  const barsRes = await axios.get('https://app.stockintel.com/api/market/bars', {
    params: { symbol: 'KSE100', from, to: now, freq: '1D' },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000
  });
  return barsRes.data?.data || [];
}

// ========== CALCULATE STATISTICS ==========
function calculateStats(volumes) {
  const n = volumes.length;
  const mean = volumes.reduce((a, b) => a + b, 0) / n;
  const variance = volumes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  
  return { mean, stdDev, min: Math.min(...volumes), max: Math.max(...volumes), count: n };
}

// ========== ANALYZE INSTITUTIONAL ACTIVITY ==========
async function analyzeInstitutionalActivity() {
  const bars = await fetchKSE100History(20);
  if (bars.length < 10) return null;

  const volumes = bars.map(b => b.volume);
  const stats = calculateStats(volumes);

  // Last 5 days for trend
  const recent5 = bars.slice(-5);
  const recentVolumes = recent5.map(b => b.volume);
  const recentAvg = recentVolumes.reduce((a, b) => a + b, 0) / 5;

  // Today's data (last bar)
  const today = bars[bars.length - 1];
  const yesterday = bars[bars.length - 2];
  const todayVol = today.volume;
  const yesterdayVol = yesterday.volume;

  // Volume vs historical
  const volSigma = (todayVol - stats.mean) / stats.stdDev;

  // Price change
  const priceChange = today.close - yesterday.close;
  const priceChangePct = ((priceChange / yesterday.close) * 100);

  // Accumulation / Distribution detection
  let activityType = 'NORMAL';
  let activityLevel = 0;
  let signal = '';
  let color = '#64748b';

  if (volSigma > 3 && priceChange > 0) {
    activityType = 'HEAVY_ACCUMULATION';
    activityLevel = 100;
    signal = '🔴🔴 Major institutional buying — strong bullish signal';
    color = '#22c55e';
  } else if (volSigma > 2 && priceChange > 0) {
    activityType = 'ACCUMULATION';
    activityLevel = 75;
    signal = '🔴 Institutional buying — bullish';
    color = '#22c55e';
  } else if (volSigma > 3 && priceChange < 0) {
    activityType = 'HEAVY_DISTRIBUTION';
    activityLevel = -100;
    signal = '🔴🔴 Major institutional selling — strong bearish signal';
    color = '#ef4444';
  } else if (volSigma > 2 && priceChange < 0) {
    activityType = 'DISTRIBUTION';
    activityLevel = -75;
    signal = '🔴 Institutional selling — bearish';
    color = '#ef4444';
  } else if (volSigma > 1.5 && priceChange > 0) {
    activityType = 'BUYING_INTEREST';
    activityLevel = 40;
    signal = '🟡 Above average volume with buying — watch for follow-through';
    color = '#f59e0b';
  } else if (volSigma > 1.5 && priceChange < 0) {
    activityType = 'SELLING_PRESSURE';
    activityLevel = -40;
    signal = '🟡 Above average volume with selling — cautious';
    color = '#f59e0b';
  } else if (volSigma > 1) {
    activityType = 'ELEVATED';
    activityLevel = volSigma > 1.2 ? 20 : 10;
    signal = '🟢 Slightly above normal volume';
    color = '#84cc16';
  } else {
    activityType = 'NORMAL';
    activityLevel = 0;
    signal = '⚪ Normal market activity';
  }

  // Consecutive accumulation days
  let consecutiveAccumulation = 0;
  for (let i = recent5.length - 1; i >= 0; i--) {
    const bar = recent5[i];
    const prevBar = bars[bars.indexOf(bar) - 1];
    if (prevBar && bar.volume > stats.mean + stats.stdDev && bar.close > prevBar.close) {
      consecutiveAccumulation++;
    } else {
      break;
    }
  }

  // Volume trend (increasing or decreasing)
  const firstHalfVol = recent5.slice(0, 2).reduce((a, b) => a + b.volume, 0) / 2;
  const secondHalfVol = recent5.slice(-2).reduce((a, b) => a + b.volume, 0) / 2;
  const volumeTrend = secondHalfVol > firstHalfVol * 1.15 ? 'INCREASING' :
                       secondHalfVol < firstHalfVol * 0.85 ? 'DECREASING' : 'STABLE';

  return {
    today: {
      volume: todayVol,
      close: today.close,
      change: +priceChange.toFixed(2),
      changePct: +priceChangePct.toFixed(2)
    },
    volumeSigma: +volSigma.toFixed(2),
    stats: {
      mean20Day: +stats.mean.toFixed(0),
      stdDev: +stats.stdDev.toFixed(0),
      min: stats.min,
      max: stats.max
    },
    activityType,
    activityLevel,
    signal,
    color,
    consecutiveAccumulationDays: consecutiveAccumulation,
    volumeTrend,
    bullishTrigger: consecutiveAccumulation >= 2 && volumeTrend === 'INCREASING',
    message: consecutiveAccumulation >= 2 
      ? `🟢 ${consecutiveAccumulation} consecutive accumulation days — institutions buying`
      : activityType.includes('DISTRIBUTION')
        ? '🔴 Institutions distributing — be cautious with longs'
        : signal,
    recommendation: consecutiveAccumulation >= 2 && volumeTrend === 'INCREASING'
      ? 'Strong bullish — follow institutional buying'
      : activityType.includes('DISTRIBUTION')
        ? 'Bearish — avoid new longs, consider profit-taking'
        : 'Trade based on individual stock setups'
  };
}

module.exports = { analyzeInstitutionalActivity };