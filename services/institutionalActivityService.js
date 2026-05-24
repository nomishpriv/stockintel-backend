const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Use getToken from stockIntelService instead of re-declaring
const { getToken } = require('./stockIntelService');

// ========== FETCH HISTORICAL KSE-100 BARS ==========
async function fetchKSE100History(days = 20) {
  // FIX: Guard against nonsensical input that would produce invalid timestamps.
  if (!Number.isFinite(days) || days <= 0) days = 20;

  const now = Math.floor(Date.now() / 1000);
  const from = now - (days * 86400);

  try {
    const token = await getToken();

    const barsRes = await axios.get('https://app.stockintel.com/api/market/bars', {
      params: { symbol: 'KSE100', from, to: now, freq: '1D' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    return barsRes.data?.data || [];
  } catch (e) {
    // FIX: Return empty array instead of letting the exception bubble up and
    // crash the caller. The upstream analyzeInstitutionalActivity already
    // checks for < 10 bars and will return null gracefully.
    console.error('❌ fetchKSE100History failed:', e.response?.status || e.message);
    return [];
  }
}

// ========== CALCULATE STATISTICS ==========
function calculateStats(volumes) {
  // FIX: Guard against empty array. The old code would divide by zero (n=0)
  // and Math.min(...[]) / Math.max(...[]) would return Infinity / -Infinity.
  const n = volumes.length;
  if (n === 0) return { mean: 0, stdDev: 0, min: 0, max: 0, count: 0 };

  const mean = volumes.reduce((a, b) => a + b, 0) / n;
  const variance = volumes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  return { mean, stdDev, min: Math.min(...volumes), max: Math.max(...volumes), count: n };
}

// ========== ANALYZE INSTITUTIONAL ACTIVITY ==========
async function analyzeInstitutionalActivity() {
  try {
    const bars = await fetchKSE100History(20);
    if (bars.length < 10) return null;

    // FIX: Filter out bars with missing or zero volume/close so they don't
    // pollute the mean/stdDev or crash downstream calculations.
    const cleanBars = bars.filter(b => b.volume > 0 && b.close > 0);
    if (cleanBars.length < 10) return null;

    const volumes = cleanBars.map(b => b.volume);
    const stats = calculateStats(volumes);

    // Last 5 days for trend
    const recent5 = cleanBars.slice(-5);
    const recentVolumes = recent5.map(b => b.volume);
    const recentAvg = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

    // Today's data (last bar)
    const today = cleanBars[cleanBars.length - 1];
    const yesterday = cleanBars[cleanBars.length - 2];
    const todayVol = today.volume;
    const yesterdayVol = yesterday.volume;

    // Volume vs historical
    // FIX: Guard against stdDev === 0 (all volumes identical). Without this,
    // volSigma becomes NaN / Infinity and no activity branch matches.
    const volSigma = stats.stdDev > 0 ? (todayVol - stats.mean) / stats.stdDev : 0;

    // Price change
    const priceChange = today.close - yesterday.close;
    // FIX: Guard against yesterday.close === 0 to prevent division by zero
    // producing NaN in priceChangePct.
    const priceChangePct = yesterday.close > 0 ? ((priceChange / yesterday.close) * 100) : 0;

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
    // FIX: Completely replaced the broken indexOf-based loop. The old code
    // used bars.indexOf(bar) which returns the FIRST matching reference in
    // the array, not the index immediately before the current bar. This
    // meant prevBar was often wrong (or -1 → undefined) when duplicate
    // objects existed, breaking the consecutive count entirely.
    let consecutiveAccumulation = 0;
    for (let i = recent5.length - 1; i >= 0; i--) {
      const idx = cleanBars.length - recent5.length + i;
      const bar = cleanBars[idx];
      const prevBar = cleanBars[idx - 1];
      if (prevBar && bar.volume > stats.mean + stats.stdDev && bar.close > prevBar.close) {
        consecutiveAccumulation++;
      } else {
        break;
      }
    }

    // Volume trend (increasing or decreasing)
    // FIX: Divide by actual slice length instead of hardcoded 2. Although
    // recent5 is guaranteed 5 items here, using .length makes the code
    // resilient if the window size is ever changed.
    const firstHalf = recent5.slice(0, Math.floor(recent5.length / 2));
    const secondHalf = recent5.slice(Math.floor(recent5.length / 2));
    const firstHalfVol = firstHalf.length > 0
      ? firstHalf.reduce((a, b) => a + b.volume, 0) / firstHalf.length
      : 0;
    const secondHalfVol = secondHalf.length > 0
      ? secondHalf.reduce((a, b) => a + b.volume, 0) / secondHalf.length
      : 0;
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
  } catch (e) {
    // FIX: Top-level safety net so any unexpected error (e.g., require()
    // failure, math edge case, malformed API response) returns null instead
    // of crashing the caller with an unhandled rejection.
    console.error('❌ analyzeInstitutionalActivity failed:', e.message);
    return null;
  }
}

module.exports = { analyzeInstitutionalActivity };