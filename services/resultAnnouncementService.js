// resultAnnouncementService
const axios = require('axios');
const { getToken } = require('./stockIntelService');

const BASE = 'https://app.stockintel.com/api';

const TYPE_MAP = {
  'FR':  { label: 'Financial Result', icon: '📊', color: '#3b82f6', short: 'Results' },
  'DIV': { label: 'Dividend',         icon: '💰', color: '#22c55e', short: 'Dividend' },
  'BON': { label: 'Bonus Issue',      icon: '🎁', color: '#8b5cf6', short: 'Bonus' },
  'RGT': { label: 'Rights Issue',     icon: '📜', color: '#f59e0b', short: 'Rights' },
  'SPL': { label: 'Stock Split',      icon: '✂️',  color: '#06b6d4', short: 'Split' },
  'BM':  { label: 'Board Meeting',    icon: '📅', color: '#6366f1', short: 'Board' },
  'AGM': { label: 'AGM / EGM',        icon: '🏛️', color: '#ec4899', short: 'AGM' },
  'MI':  { label: 'Material Info',    icon: '📋', color: '#14b8a6', short: 'Material' },
  'U':   { label: 'Update',           icon: '📢', color: '#9ca3af', short: 'Update' },
  'E':   { label: 'Market Notice',    icon: '📡', color: '#6b7280', short: 'Notice' },
};

const MI_POSITIVE = [
  'arrival', 'expansion', 'new project', 'acquisition', 'merger', 'joint venture', 'jv',
  'contract', 'order', 'export', 'capacity', 'upgrade', 'approval', 'license', 'launch',
  'commencement', 'commercial operations', 'production', 'profit', 'growth', 'investment',
  'funding', 'secure', 'win', 'awarded', 'partnership', 'mou', 'agreement', 'signed',
  'operational', 'brownfield', 'greenfield', 'inauguration', 'procurement', 'imported',
  'import', 'purchase', 'addition', 'enhancement', 'diversification', 'heifers', 'cattle',
  'dairy', 'livestock', 'assets', 'fleet', 'vessels', 'vehicles', 'land', 'building',
  'factory', 'mill', 'machinery', 'equipment', 'solar', 'energy', 'power', 'renewable',
  'turnaround', 'capacity addition', 'plant',
];

const MI_NEGATIVE = [
  'fire', 'accident', 'explosion', 'casualty', 'death', 'injury', 'shutdown', 'closure',
  'suspension', 'delay', 'postpone', 'cancel', 'terminate', 'default', 'breach',
  'penalty', 'fine', 'litigation', 'lawsuit', 'dispute', 'loss', 'damage', 'theft',
  'fraud', 'investigation', 'auditor qualification', 'bankruptcy', 'insolvency', 'layoff',
  'demerge', 'withdraw', 'recall', 'rejection', 'non-compliance', 'violation', 'sanction',
  'ban', 'delisted', 'suspended', 'halt', 'liquidation', 'winding up', 'receiver',
  'court', 'nab', 'fia', 'reference', 'corruption', 'bribery',
];

function detectAnnouncementType(item) {
  const title = (item.title || '').toLowerCase();
  const code = (item.type || '').toUpperCase();

  if (title.startsWith('material information') || title.includes('material information -')) return 'MI';
  if (title.startsWith('financial result') || title.includes('financial results')) return 'FR';
  if (title.startsWith('dividend') || title.includes('cash dividend') || title.includes('final dividend')) return 'DIV';
  if (title.startsWith('bonus')) return 'BON';
  if (title.startsWith('right') || title.includes('rights issue')) return 'RGT';
  if (title.startsWith('stock split') || title.includes('share split')) return 'SPL';
  if (title.startsWith('board meeting') || title.includes('meeting of board')) return 'BM';
  if (title.startsWith('agm') || title.startsWith('egm') || title.includes('annual general meeting')) return 'AGM';

  if (TYPE_MAP[code] && code !== 'U' && code !== 'E') return code;

  const r = item.results || {};
  if (r.eps !== undefined || r.pat !== undefined || r.sales !== undefined) return 'FR';

  const p = item.payouts || {};
  if (p.dividend > 0) return 'DIV';
  if (p.bonus > 0) return 'BON';
  if (p.right_issue > 0 || p.right_price > 0) return 'RGT';
  if ((p.split_num > 0 && p.split_den > 0) || (p.rsplit_num > 0 && p.rsplit_den > 0)) return 'SPL';
  if (item.meeting && (item.meeting.time || item.meeting.date)) return 'BM';

  if (TYPE_MAP[code]) return code;
  if (item.category === 'E' || item.form_type === 'PSX_NOTICE') return 'E';
  return 'U';
}

function analyzeResult(item) {
  const r = item.results || {};
  const eps = r.eps || 0;
  const epsPrev = r.eps_sply || 0;
  const pat = r.pat || 0;
  let impact = 'NEUTRAL', score = 0, signal = '';
  const details = { eps, epsPrev, pat, sales: r.sales || 0, epsChange: 0 };

  if (epsPrev !== 0) {
    const epsChange = ((eps - epsPrev) / Math.abs(epsPrev)) * 100;
    details.epsChange = epsChange.toFixed(2) + '%';
    if (eps > 0 && epsChange > 50) { impact = 'STRONG_POSITIVE'; score = 10; signal = `🔥 EPS surged +${epsChange.toFixed(0)}%`; }
    else if (eps > 0 && epsChange > 20) { impact = 'POSITIVE'; score = 7; signal = `📈 EPS growth +${epsChange.toFixed(0)}%`; }
    else if (eps > 0 && epsChange > 0) { impact = 'SLIGHTLY_POSITIVE'; score = 4; signal = '✅ EPS improved'; }
    else if (eps > 0 && epsChange <= 0) { impact = 'NEUTRAL'; score = 0; signal = '➖ EPS flat/declined'; }
    else if (eps < 0 && epsPrev > 0) { impact = 'NEGATIVE'; score = -7; signal = '📉 EPS turned negative'; }
    else if (eps < 0 && epsChange < -50) { impact = 'STRONG_NEGATIVE'; score = -10; signal = `💥 EPS collapsed ${epsChange.toFixed(0)}%`; }
    else if (eps < 0 && epsChange < 0) { impact = 'NEGATIVE'; score = -5; signal = '🔻 Loss widened'; }
    else if (eps < 0 && epsChange > 0) { impact = 'SLIGHTLY_POSITIVE'; score = 3; signal = '📉 Loss narrowed'; }
  } else if (eps > 0) { impact = 'POSITIVE'; score = 5; signal = '💰 Turned profitable'; }
  else if (eps < 0) { impact = 'NEGATIVE'; score = -4; signal = '🔴 Loss reported'; }
  else { impact = 'NEUTRAL'; score = 0; signal = '⚪ No change'; }

  if (pat > 1000000) score += 2;
  if (pat < -1000000) score -= 2;
  return { impact, score, signal, details };
}

function analyzeDividend(item) {
  const p = item.payouts || {};
  const div = p.dividend || 0;
  let score = 0, signal = '', impact = 'NEUTRAL';
  if (div > 0) {
    score = Math.min(8, Math.max(2, div / 5));
    signal = `💰 Dividend ${div}%`;
    impact = 'POSITIVE';
    if (div >= 20) { score = 10; signal = `🔥 Generous dividend ${div}%`; impact = 'STRONG_POSITIVE'; }
    else if (div >= 10) { score = 7; signal = `📈 Good dividend ${div}%`; }
  } else { signal = '📢 Dividend announcement'; }
  return { impact, score, signal, details: { dividend: div, exDate: p.ex_date, entitlementDate: p.entitlement_date } };
}

function analyzeBonus(item) {
  const p = item.payouts || {};
  const bonus = p.bonus || 0;
  let score = 0, signal = '', impact = 'NEUTRAL';
  if (bonus > 0) {
    score = Math.min(8, Math.max(2, bonus / 10));
    signal = `🎁 Bonus ${bonus}%`;
    impact = 'POSITIVE';
    if (bonus >= 20) { score = 8; signal = `🔥 High bonus ${bonus}%`; }
  } else { signal = '📢 Bonus announcement'; }
  return { impact, score, signal, details: { bonus, ...p } };
}

function analyzeRights(item) {
  const p = item.payouts || {};
  const rp = p.right_price || 0, ri = p.right_issue || 0;
  let score = -1, signal = '📜 Rights announcement', impact = 'NEUTRAL';
  if (rp > 0 && ri > 0) { signal = `📜 Rights ${ri} @ PKR ${rp}`; impact = 'SLIGHTLY_NEGATIVE'; score = -2; }
  else if (rp > 0) { signal = `📜 Rights @ PKR ${rp}`; }
  return { impact, score, signal, details: { rightPrice: rp, rightIssue: ri, ...p } };
}

function analyzeSplit(item) {
  const p = item.payouts || {};
  const num = p.split_num || p.rsplit_num || 0, den = p.split_den || p.rsplit_den || 0;
  let signal = '📢 Split announcement', impact = 'NEUTRAL', score = 0;
  if (num > 0 && den > 0) {
    const ratio = num / den;
    if (ratio > 1) { signal = `✂️ Forward split ${num}:${den}`; impact = 'POSITIVE'; score = 3; }
    else if (ratio < 1) { signal = `🔻 Reverse split ${num}:${den}`; impact = 'SLIGHTLY_NEGATIVE'; score = -2; }
  }
  return { impact, score, signal, details: { splitNum: num, splitDen: den, ...p } };
}

function analyzeBoardMeeting(item) {
  const title = (item.title || '').toLowerCase();
  let score = 0, signal = '📅 Board meeting scheduled', impact = 'NEUTRAL';
  if (title.includes('dividend') || title.includes('payout') || title.includes('bonus')) {
    signal = '📅 Board meeting — payout likely'; impact = 'POSITIVE'; score = 2;
  } else if (title.includes('result') || title.includes('financial') || title.includes('eps')) {
    signal = '📅 Board meeting — results likely'; impact = 'NEUTRAL'; score = 1;
  }
  return { impact, score, signal, details: { meetingTime: item.meeting?.time, meetingDate: item.meeting?.date, meetingVenue: item.meeting?.venue } };
}

function analyzeMaterialInfo(item) {
  const title = (item.title || '').toLowerCase();
  const subject = item.title.replace(/^material information\s*[-–—:]\s*/i, '').trim();
  let score = 0, signal = '', impact = 'NEUTRAL';
  const matched = [];

  MI_POSITIVE.forEach(kw => { if (title.includes(kw)) { score += 2; matched.push(kw); } });
  MI_NEGATIVE.forEach(kw => { if (title.includes(kw)) { score -= 3; matched.push(kw); } });

  score = Math.max(-10, Math.min(10, score));
  if (score >= 7) impact = 'STRONG_POSITIVE';
  else if (score >= 4) impact = 'POSITIVE';
  else if (score > 0) impact = 'SLIGHTLY_POSITIVE';
  else if (score === 0) impact = 'NEUTRAL';
  else if (score > -4) impact = 'SLIGHTLY_NEGATIVE';
  else if (score > -7) impact = 'NEGATIVE';
  else impact = 'STRONG_NEGATIVE';

  if (score >= 5) signal = `📋 Positive: ${subject}`;
  else if (score > 0) signal = `📋 Mildly positive: ${subject}`;
  else if (score === 0) signal = `📋 Routine: ${subject}`;
  else if (score > -5) signal = `📋 Slight concern: ${subject}`;
  else signal = `📋 Negative alert: ${subject}`;

  return { impact, score, signal, details: { materialSubject: subject, matchedKeywords: [...new Set(matched)].slice(0, 8) } };
}

function analyzeMarketNotice(item) {
  return { impact: 'NEUTRAL', score: 0, signal: '📡 Market notice', details: { formType: item.form_type, category: item.category } };
}

function analyzeGeneral(item) {
  return { impact: 'NEUTRAL', score: 0, signal: '📢 Corporate update', details: { type: item.type, category: item.category } };
}

function analyzeAnnouncement(item) {
  const typeCode = detectAnnouncementType(item);
  const meta = TYPE_MAP[typeCode] || TYPE_MAP['U'];
  let analysis;
  switch (typeCode) {
    case 'FR': analysis = analyzeResult(item); break;
    case 'DIV': analysis = analyzeDividend(item); break;
    case 'BON': analysis = analyzeBonus(item); break;
    case 'RGT': analysis = analyzeRights(item); break;
    case 'SPL': analysis = analyzeSplit(item); break;
    case 'BM': analysis = analyzeBoardMeeting(item); break;
    case 'MI': analysis = analyzeMaterialInfo(item); break;
    case 'E': analysis = analyzeMarketNotice(item); break;
    default: analysis = analyzeGeneral(item);
  }

  const color = analysis.score >= 7 ? '#22c55e' : analysis.score >= 3 ? '#84cc16' : analysis.score <= -7 ? '#ef4444' : analysis.score <= -3 ? '#f97316' : '#f59e0b';

  return {
    id: item.id,
    symbol: item.symbol,
    title: item.title,
    quarter: item.quarter || '',
    date: item.date,
    lastAction: item.last_action,
    isRevised: item.is_revised,
    pdf: item.pdf,
    docs: item.docs || [],
    announcementType: typeCode,
    typeLabel: meta.label,
    typeIcon: meta.icon,
    typeColor: meta.color,
    typeShort: meta.short,
    impact: analysis.impact,
    score: analysis.score,
    signal: analysis.signal,
    details: analysis.details,
    color,
    meetingTime: item.meeting?.time || 'N/A',
    periodEnded: item.period_ended,
  };
}

async function fetchTodaysAnnouncements(dateOverride) {
  const target = dateOverride || new Date().toISOString().split('T')[0];
  try {
    const token = await getToken();
    const { data } = await axios.get(`${BASE}/data/notices`, {
      params: { from: target, to: target },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    return data?.data || [];
  } catch (e) {
    console.error('❌ Announcements fetch failed:', e.message);
    return [];
  }
}

let cachedResults = null, lastFetch = 0;
const CACHE_TTL = 300000;

async function getTodayResultImpact(dateOverride) {
  const now = Date.now();
  if (!dateOverride && cachedResults && (now - lastFetch) < CACHE_TTL) return cachedResults;

  const announcements = await fetchTodaysAnnouncements(dateOverride);
  if (announcements.length === 0) {
    const empty = {
      announcements: [], hasResults: false, hasAnnouncements: false,
      byType: {}, typeCounts: {}, highImpact: [], materialInfo: [],
      message: dateOverride ? `No announcements on ${dateOverride}` : 'No announcements today',
      timestamp: new Date().toISOString()
    };
    if (!dateOverride) { cachedResults = empty; lastFetch = now; }
    return empty;
  }

  const analyzed = announcements.map(analyzeAnnouncement).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  const byType = {};
  analyzed.forEach(a => { if (!byType[a.announcementType]) byType[a.announcementType] = []; byType[a.announcementType].push(a); });

  // NEW: type counts for frontend badges
  const typeCounts = {};
  Object.keys(byType).forEach(k => { typeCounts[k] = byType[k].length; });

  const frItems = analyzed.filter(a => a.announcementType === 'FR');
  const result = {
    announcements: analyzed,
    hasResults: frItems.length > 0,
    hasAnnouncements: true,
    totalResults: frItems.length,
    totalAnnouncements: analyzed.length,
    positiveResults: frItems.filter(a => a.score > 0).length,
    negativeResults: frItems.filter(a => a.score < 0).length,
    topImpacts: analyzed.filter(a => Math.abs(a.score) >= 5).slice(0, 8),
    highImpact: analyzed.filter(a => Math.abs(a.score) >= 5), // all high impact
    materialInfo: analyzed.filter(a => a.announcementType === 'MI'),
    byType,
    typeCounts,
    message: `${analyzed.length} announcements • ${Object.keys(byType).length} types`,
    timestamp: new Date().toISOString()
  };

  if (!dateOverride) { cachedResults = result; lastFetch = now; }
  return result;
}

async function getStockResult(symbol, dateOverride) {
  const data = await getTodayResultImpact(dateOverride);
  return data.announcements.find(a => a.symbol === symbol.toUpperCase()) || null;
}

module.exports = { getTodayResultImpact, getStockResult };