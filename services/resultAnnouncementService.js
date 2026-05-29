// resultAnnouncementService
const axios = require('axios');
const { getToken } = require('./stockIntelService');

const BASE = 'https://app.stockintel.com/api';

// ========== FETCH TODAY'S RESULT ANNOUNCEMENTS ==========
async function fetchTodaysAnnouncements() {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const token = await getToken();
    const { data } = await axios.get(`${BASE}/data/notices`, {
      params: {
        type: 'fr',  // financial results
        from: today,
        to: today
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    return data?.data || [];
  } catch (e) {
    console.error('❌ Result announcements fetch failed:', e.message);
    return [];
  }
}

// ========== ANALYZE RESULT IMPACT ==========
function analyzeResultImpact(announcement) {
  const eps = announcement.results?.eps || 0;
  const epsPrev = announcement.results?.eps_sply || 0;
  const sales = announcement.results?.sales || 0;
  const pat = announcement.results?.pat || 0;

  let impact = 'NEUTRAL';
  let score = 0;
  let signal = '';

 // EPS comparison vs same period last year
  // EPS comparison vs same period last year
  if (epsPrev !== 0) {
    const epsChange = ((eps - epsPrev) / Math.abs(epsPrev)) * 100;
    
    if (eps > 0 && epsChange > 50) {
      impact = 'STRONG_POSITIVE';
      score = 10;
      signal = '🔥 EPS surged — strong buy';
    } else if (eps > 0 && epsChange > 20) {
      impact = 'POSITIVE';
      score = 7;
      signal = '📈 EPS growth — positive';
    } else if (eps > 0 && epsChange > 0) {
      impact = 'SLIGHTLY_POSITIVE';
      score = 4;
      signal = '✅ EPS improved — mild positive';
    } else if (eps > 0 && epsChange <= 0) {
      impact = 'NEUTRAL';
      score = 0;
      signal = '➖ EPS flat or declined but still profitable';
    } else if (eps < 0 && epsPrev > 0) {
      impact = 'NEGATIVE';
      score = -7;
      signal = '📉 EPS turned negative — sell';
    } else if (eps < 0 && epsChange < -50) {
      impact = 'STRONG_NEGATIVE';
      score = -10;
      signal = '💥 EPS collapsed — heavy sell';
    } else if (eps < 0 && epsChange < 0) {
      impact = 'NEGATIVE';
      score = -5;
      signal = '🔻 Loss widened — bearish';
    } else if (eps < 0 && epsChange > 0) {
      impact = 'SLIGHTLY_POSITIVE';
      score = 3;
      signal = '📉 Loss narrowed — improving';
    }
  } else if (eps > 0) {
    impact = 'POSITIVE';
    score = 5;
    signal = '💰 Turned profitable — positive';
  } else if (eps < 0) {
    impact = 'NEGATIVE';
    score = -4;
    signal = '🔴 Loss reported — negative';
  } else {
    impact = 'NEUTRAL';
    score = 0;
    signal = '⚪ No significant change';
  }

  // Adjust for PAT
  if (pat > 0 && pat > 1000000) score += 2; // Profit > 1M
  if (pat < 0 && pat < -1000000) score -= 2; // Loss > 1M

  return {
    symbol: announcement.symbol,
    title: announcement.title,
    quarter: announcement.quarter,
    eps,
    epsPrev,
    pat,
    sales,
    impact,
    score,
    signal,
    meetingTime: announcement.meeting?.time || 'N/A',
    color: score >= 7 ? '#22c55e' : score >= 3 ? '#84cc16' : score <= -7 ? '#ef4444' : score <= -3 ? '#f97316' : '#f59e0b'
  };
}

// ========== GET TODAY'S IMPACT ==========
let cachedResults = null;
let lastFetch = 0;
const CACHE_TTL = 300000; // 5 min

async function getTodayResultImpact() {
  const now = Date.now();
  if (cachedResults && (now - lastFetch) < CACHE_TTL) return cachedResults;

  const announcements = await fetchTodaysAnnouncements();
  
  if (announcements.length === 0) {
    const empty = { announcements: [], hasResults: false, message: 'No financial results announced today' };
    cachedResults = empty;
    lastFetch = now;
    return empty;
  }

  const analyzed = announcements
    .map(analyzeResultImpact)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  const result = {
    announcements: analyzed,
    hasResults: true,
    totalResults: announcements.length,
    positiveResults: analyzed.filter(a => a.score > 0).length,
    negativeResults: analyzed.filter(a => a.score < 0).length,
    topImpacts: analyzed.filter(a => Math.abs(a.score) >= 5).slice(0, 5),
    message: `${announcements.length} companies announcing results today`,
    timestamp: new Date().toISOString()
  };

  cachedResults = result;
  lastFetch = now;
  return result;
}

// ========== GET STOCK-SPECIFIC RESULT ==========
async function getStockResult(symbol) {
  const todayData = await getTodayResultImpact();
  return todayData.announcements.find(a => a.symbol === symbol.toUpperCase()) || null;
}

module.exports = { getTodayResultImpact, getStockResult };