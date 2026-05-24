const si = require('./stockIntelService');
const newsService = require('./newsService');

// Shariah-compliant stocks only (no conventional banks, no insurance, no leverage)
const SHARIAH_SYMBOLS = [
  'FFC', 'EFERT', 'FATIMA', 'LUCK', 'DGKC', 'MLCF', 'CHCC', 'PIOC',
  'OGDC', 'PPL', 'MARI', 'POL', 'HUBC', 'KAPCO', 'APL', 'SHEL', 'PSO',
  'INDU', 'HCAR', 'ATLH', 'SAZEW', 'SEARL', 'GLAXO', 'ABOT', 'AGP',
  'LOTCHEM', 'EPCL', 'ICI', 'COLG', 'NESTLE', 'NATF', 'SYS', 'TRG', 'AVN',
  'MEBL', 'ISL', 'ASTL', 'MUGHAL', 'NCL', 'NML', 'GATM', 'PKGS', 'GHGL', 'TGL', 'PAEL', 'PICT'
];

async function getShariahTradeRecommendations() {
  const allStocks = await si.fetchAllStocks();

  // FIX: Guard against non-array returns (network failure, unexpected error)
  // so the downstream .filter() doesn't throw and crash the caller.
  if (!Array.isArray(allStocks)) {
    return {
      recommendations: [],
      marketContext: null,
      totalShariahStocks: 0,
      timestamp: new Date().toISOString()
    };
  }

  const newsImpact = await newsService.getQuickSignal().catch(() => null);

  const shariahStocks = allStocks.filter(s => SHARIAH_SYMBOLS.includes(s.symbol));

  // Score each stock for LONG only
  const scored = shariahStocks.map(stock => {
    let score = 0;
    const reasons = [];

    // 1. Technical Score (0-40)
    // FIX: Added > 0 checks on pivot/support data. stockIntelService defaults
    // missing nested fields to 0, so without this guard almost every stock
    // gets "Above pivot" points even when no pivot was calculated.
    if (stock.s1 > 0 && stock.pivot > 0 && stock.price > stock.s1 && stock.price > stock.pivot) {
      score += 10; reasons.push('Above pivot');
    }
    if (stock.rsi > 40 && stock.rsi < 65) {
      score += 8; reasons.push('RSI healthy');
    }
    // FIX: Added stock.rsi > 0 guard. Missing RSI defaults to 0 in the
    // upstream service, which would falsely trigger "Oversold bounce".
    if (stock.rsi > 0 && stock.rsi < 35) {
      score += 6; reasons.push('Oversold bounce');
    }
    // FIX: Added stock.volAvg10d > 0 guard. When the API omits the 10-day
    // average, the value is 0 and volume > 0 * 1.2 is always true.
    if (stock.changePercent > 0 && stock.volAvg10d > 0 && stock.volume > stock.volAvg10d * 1.2) {
      score += 10; reasons.push('Volume confirming up');
    }
    // FIX: Removed dead stock.ema9 reference — that field is not emitted by
    // stockIntelService so the left side of the || was always false.
    // Added stock.open > 0 guard for the same reason (missing open defaults to 0).
    if (stock.open > 0 && stock.price > stock.open) {
      score += 6; reasons.push('Above open');
    }
    if (stock.signal === 'BUY' || stock.signal === 'STRONG_BUY') {
      score += 6; reasons.push('Buy signal');
    }

    // 2. Volume Score (0-20)
    // FIX: Only calculate ratios when volAvg10d is actually present (> 0).
    // Without this, a missing average (0) makes volRatio = volume/1, which
    // can be huge and falsely awards the highest volume tier.
    if (stock.volAvg10d > 0) {
      const volRatio = stock.volume / stock.volAvg10d;
      if (volRatio > 1.5) { score += 12; reasons.push('Volume 150%+'); }
      else if (volRatio > 1.2) { score += 8; reasons.push('Volume 120%+'); }
      else if (volRatio > 0.8) { score += 4; reasons.push('Normal volume'); }
    }

    // Volume trend (bid vs ask)
    if (stock.bidAskRatio > 1.5) { score += 8; reasons.push('Strong bid side'); }
    else if (stock.bidAskRatio > 1.2) { score += 4; reasons.push('Bid pressure'); }

    // 3. News & Global Score (0-20)
    if (newsImpact) {
      if (newsImpact.sentiment === 'BULLISH') { score += 10; reasons.push('News bullish'); }
      else if (newsImpact.sentiment === 'BEARISH') { score -= 5; reasons.push('News bearish'); }
      if (newsImpact.impactScore > 3) { score += 5; reasons.push('Strong news impact'); }
    }

    // Oil price impact (affects many sectors)
    // FIX: Wrapped oilComment in String() before toLowerCase(). The old
    // chain newsImpact?.oilComment?.toLowerCase().includes(...) crashes with
    // TypeError when oilComment is undefined because undefined.includes() is
    // not a function.
    const oilComment = String(newsImpact?.oilComment ?? '').toLowerCase();
    if (['OGDC', 'PPL', 'MARI', 'POL', 'APL', 'SHEL', 'PSO'].includes(stock.symbol)) {
      if (oilComment.includes('rise')) { score += 5; reasons.push('Oil up = E&P benefit'); }
      if (oilComment.includes('fall')) { score -= 3; reasons.push('Oil down = E&P pressure'); }
    }

    // 4. Sector Momentum (0-10)
    if (stock.changePercent > 1) { score += 5; reasons.push('Strong momentum'); }
    if (stock.changePercent > 2) { score += 5; reasons.push('Very strong momentum'); }

    // 5. Liquidity Score (0-10)
    // FIX: Added spreadPct > 0 guard. When bid/ask is missing, spreadPct is
    // 0 in the upstream service, which would falsely award "Tight spread".
    if (stock.spreadPct > 0 && stock.spreadPct < 0.1) { score += 5; reasons.push('Tight spread'); }
    else if (stock.spreadPct > 0 && stock.spreadPct < 0.2) { score += 3; reasons.push('Liquid'); }
    if (stock.volume > 100000) { score += 2; reasons.push('Active'); }

    return {
      symbol: stock.symbol,
      name: stock.name,
      price: stock.price,
      changePercent: stock.changePercent,
      volume: stock.volume,
      rsi: stock.rsi,
      score,
      maxScore: 100,
      reasons: reasons.slice(0, 5),
      recommendation: score >= 55 ? 'STRONG_LONG' : score >= 40 ? 'LONG' : score >= 25 ? 'WATCH' : 'SKIP',
      color: score >= 55 ? '#22c55e' : score >= 40 ? '#84cc16' : score >= 25 ? '#f59e0b' : '#64748b',
      // FIX: Use > 0 checks instead of truthy || so a calculated value of 0
      // doesn't hide behind fallback strings when the level is genuinely missing.
      entryZone: stock.s1 > 0 ? `Near ${stock.s1}` : 'At market',
      target: stock.r1 > 0 ? stock.r1 : stock.r2 > 0 ? stock.r2 : '---',
      stopLoss: stock.s2 > 0 ? stock.s2 : stock.pivot > 0 ? stock.pivot : '---'
    };
  });

  // Sort by score, LONG only, no shorts
  const recommendations = scored
    .filter(s => s.recommendation !== 'SKIP')
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    recommendations,
    marketContext: newsImpact ? {
      sentiment: newsImpact.sentiment,
      signal: newsImpact.signal,
      summary: newsImpact.summary,
      immediateAction: newsImpact.immediateAction
    } : null,
    totalShariahStocks: shariahStocks.length,
    timestamp: new Date().toISOString()
  };
}

module.exports = { getShariahTradeRecommendations };