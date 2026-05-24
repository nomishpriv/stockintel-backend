'use strict';

const axios = require('axios');
const Groq  = require('groq-sdk');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const NEWS_SOURCES = [
  { name: 'Tribune Business',  url: 'https://tribune.com.pk/feed/business',                  weight: 1.2 },
  { name: 'ARY News',          url: 'https://arynews.tv/feed/',                              weight: 1.0 },
  { name: 'Dawn Business',     url: 'https://www.dawn.com/feeds/business-finance',           weight: 1.3 },
  { name: 'Geo Business',      url: 'https://www.geo.tv/rss/1009',                          weight: 1.1 },
  { name: 'Business Recorder', url: 'https://www.brecorder.com/feeds/latest-news',          weight: 1.4 },
  { name: 'Profit Pakistan',   url: 'https://profit.pakistantoday.com.pk/feed',             weight: 1.3 },
];

const METTIS_APIS = [
  { name: 'Mettis Equity',      url: 'https://mettisglobal.news/Home/GetEquitylatestnews'              },
  { name: 'Mettis Economy',     url: 'https://mettisglobal.news/Home/GetEconomylatestnews'             },
  { name: 'Mettis Forex',       url: 'https://mettisglobal.news/Home/GetForexlatestnews'               },
  { name: 'Mettis Global Biz',  url: 'https://mettisglobal.news/Home/GetGlobalBusinesslatestnews'     },
  { name: 'Mettis Opinion',     url: 'https://mettisglobal.news/Home/GetMGOpinionlatestnews'           },
  { name: 'Mettis Technical',   url: 'https://mettisglobal.news/Home/GetTechnicalAnalysislatestnews'  },
  { name: 'Mettis Company',     url: 'https://mettisglobal.news/Home/GetCompanyAnalysislatestnews'    },
  { name: 'Mettis Analyst',     url: 'https://mettisglobal.news/Home/GetAnalystBriefingSessionlatestnews' },
  { name: 'Mettis Stock Picks', url: 'https://mettisglobal.news/Home/GetStockPicks'                   },
];

const CACHE_TTL      = 90_000;  // 90 s
const HEADLINE_LIMIT = 12;
const MAX_AGE_HOURS  = 6;

// ─── PSX SECTOR → TICKERS ────────────────────────────────────────────────────
const SECTOR_TICKERS = {
  'Banking':     ['HBL', 'UBL', 'MCB', 'BAFL', 'ABL', 'MEBL'],
  'Cement':      ['LUCK', 'DGKC', 'CHCC', 'MLCF', 'KOHC', 'FCCL'],
  'Oil & Gas':   ['PPL', 'OGDC', 'PSO', 'SNGP', 'SSGC', 'APL'],
  'Fertilizer':  ['ENGRO', 'FFC', 'EFERT', 'FATIMA'],
  'Power':       ['HUBC', 'KAPCO', 'KEL', 'NCPL', 'PKGP'],
  'Steel':       ['ASTL', 'ISL', 'MUGHAL'],
  'Textile':     ['NML', 'NCL', 'GATM', 'GFIL'],
  'Pharma':      ['SEARL', 'GLAXO', 'FEROZ', 'HINOON'],
  'Tech':        ['TRG', 'SYS', 'TELE'],
  'Auto':        ['PSMC', 'INDU', 'HCAR', 'ATLH'],
  'Food & FMCG': ['NESTLE', 'ENGRO', 'UNITY', 'COLG'],
  'Real Estate': ['MLCF', 'PACE', 'ARPL'],
  'Economy':     ['KSE100'],
};

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = { data: null, ts: 0 };

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function decodeEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function isStale(pubDate) {
  // NOTE: Items without a valid date are kept indefinitely. This is
  // intentional for feeds that omit pubDate, but it means ancient undated
  // stories can only be removed by deduplication, not age filtering.
  if (!pubDate || isNaN(pubDate)) return false;
  return (Date.now() - pubDate.getTime()) / 3_600_000 > MAX_AGE_HOURS;
}

/** Token-based dedup — keeps the first (freshest) copy of near-duplicate titles */
function deduplicate(items) {
  const seen   = new Set();
  const result = [];
  for (const item of items) {
    // FIX: Guard against missing or empty titles that would crash toLowerCase().
    if (!item.title || typeof item.title !== 'string') continue;
    const key = item.title.toLowerCase().replace(/\W+/g, ' ').split(' ').slice(0, 6).join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

// ─── PSX RELEVANCE ───────────────────────────────────────────────────────────
const PSX_KEYWORDS = [
  'karachi stock', 'kse', 'psx', 'pkr', 'rupee', 'sbp', 'state bank',
  'imf', 'gdp', 'inflation', 'cpi', 'interest rate', 'fiscal', 'budget',
  'revenue', 'profit', 'earnings', 'dividend', 'listing', 'ipo',
  'oil price', 'gas', 'electricity', 'cement', 'steel', 'bank', 'textile',
  'export', 'import', 'current account', 'foreign reserve', 'dollar',
  'brent', 'crude', 'tax', 'duty', 'policy rate', 'mpd', 'monetary',
  'economic', 'economy', 'trade', 'investment', 'fdi', 'remittance',
];

function isPSXRelevant(title) {
  const lower = title.toLowerCase();
  return PSX_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── RSS FETCHER ──────────────────────────────────────────────────────────────
// NOTE: This uses regex-based XML scraping. It works for well-formed RSS
// but is brittle against CDATA edge cases, nested tags inside titles, or
// non-RSS XML responses. For production robustness consider swapping to a
// proper XML parser (fast-xml-parser, xml2js) if feeds start breaking.
async function fetchRSS(source) {
  try {
    const { data } = await axios.get(source.url, {
      timeout: 7000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PSX-Analyzer/2.0)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
    });

    const items  = [];
    const itemRx = /<item[\s\S]*?<\/item>/gi;
    let   m;

    while ((m = itemRx.exec(data)) !== null) {
      const block = m[0];

      const titleM = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block);
      if (!titleM) continue;
      const title = decodeEntities(titleM[1]).trim();
      if (!title || title.length < 15) continue;

      const dateM  = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block);
      const pubDate = dateM ? new Date(dateM[1].trim()) : null;

      if (isStale(pubDate)) continue;

      items.push({ title, pubDate, source: source.name, weight: source.weight, isPSX: false });
    }
    return items;
  } catch (err) {
    console.warn(`⚠️  ${source.name} failed: ${err.message}`);
    return [];
  }
}

// ─── METTIS FETCHER ───────────────────────────────────────────────────────────
async function fetchMettisAPI(source) {
  try {
    const { data } = await axios.get(source.url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json',
      },
    });

    if (!Array.isArray(data)) return [];

    return data
      .map(item => {
        // FIX: Mettis sometimes returns a single object for Heading / Description
        // instead of an array. The old code did item?.Headings?.Heading?.[0] which
        // would return the first character of a string instead of the full title.
        const headingRaw = item?.Headings?.Heading;
        const descRaw    = item?.Descriptions?.Description;
        const title =
          (Array.isArray(headingRaw) ? headingRaw[0] : headingRaw) ||
          (Array.isArray(descRaw)    ? descRaw[0]    : descRaw)    ||
          '';
        if (!title || title.length < 10) return null;

        const pubDate = item?.PublishedTime ? new Date(item.PublishedTime) : null;
        if (isStale(pubDate)) return null;

        // FIX: Tags.Tag may be a single object instead of an array.
        // The old .some() would throw TypeError in that case.
        const tagNode = item?.Tags?.Tag;
        const tags = Array.isArray(tagNode) ? tagNode : (tagNode ? [tagNode] : []);
        const isPSX = tags.some(
          t => t.TagName === 'KSE100' || t.TagType === 'Indices' || t.TagType === 'Companies'
        ) || false;

        return { title, pubDate, source: source.name, weight: 1.5, isPSX };
      })
      .filter(Boolean);

  } catch (err) {
    console.warn(`⚠️  ${source.name} failed: ${err.message}`);
    return [];
  }
}

// ─── GROQ AI ANALYSIS ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert PSX (Pakistan Stock Exchange) intraday analyst with deep knowledge of KSE-100, sector dynamics, SBP monetary policy, IMF program impacts, and Pakistani macroeconomics.
Your job: read breaking news headlines and give a precise, actionable intraday trading signal.
Rules:
- Be decisive. Intraday traders need clear BUY/SELL/HOLD signals, not vague advice.
- Consider sector correlations (e.g., rate cuts → Banks up, higher oil → E&P up, PKR appreciation → Importers up).
- Weigh each headline by its likely immediate market impact.
- Return ONLY raw JSON. No markdown, no explanation outside JSON.`;

const USER_PROMPT = (headlines) => `
Today's date/time: ${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} PKT

Fresh PSX-relevant news headlines (last ${MAX_AGE_HOURS} hours):
${headlines.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n')}

Analyze and return this exact JSON structure:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "signal": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
  "impactScore": <integer -10 to +10>,
  "confidence": <integer 0-100>,
  "kse100Outlook": "UP" | "DOWN" | "SIDEWAYS",
  "affectedSectors": [
    { "sector": "<name>", "impact": "POSITIVE" | "NEGATIVE" | "NEUTRAL", "reason": "<1 line>" }
  ],
  "topTrades": [
    { "ticker": "<PSX symbol>", "action": "BUY" | "SELL", "reason": "<1 line>", "riskLevel": "LOW" | "MEDIUM" | "HIGH" }
  ],
  "keyRisk": "<biggest risk to this call in one line>",
  "summary": "<2-line intraday summary — Urdu/English mix OK>",
  "immediateAction": "<what to do in next 30 minutes>"
}`;

async function analyzeWithGroq(headlines) {
  if (!process.env.GROQ_API_KEY || headlines.length === 0) return null;

  const MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

  for (const model of MODELS) {
    try {
      console.log(`🤖 Trying model: ${model}`);
      const chat = await groq.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens:  600,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: USER_PROMPT(headlines) },
        ],
      });

      const raw   = chat.choices[0].message.content;
      const text  = raw.replace(/```json|```/gi, '').trim();
      const start = text.indexOf('{');
      const end   = text.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON found');

      const parsed  = JSON.parse(text.slice(start, end + 1));
      parsed._model = model;
      return parsed;

    } catch (err) {
      console.warn(`⚠️  ${model} failed: ${err.message}`);
    }
  }
  return null;
}

// ─── ENRICHMENT ───────────────────────────────────────────────────────────────
function enrichWithTickers(ai) {
  if (ai?.affectedSectors) {
    ai.affectedSectors = ai.affectedSectors.map(s => ({
      ...s,
      watchlist: SECTOR_TICKERS[s.sector] || [],
    }));
  }
  if (ai?.topTrades) {
    ai.topTrades = ai.topTrades.map(t => ({
      ...t,
      ticker: t.ticker?.toUpperCase() || 'N/A',
    }));
  }
  return ai;
}

function signalMeta(signal) {
  const map = {
    STRONG_BUY:  { emoji: '🟢🟢', color: '#00c853', label: 'Strong Buy'  },
    BUY:         { emoji: '🟢',   color: '#69f0ae', label: 'Buy'         },
    HOLD:        { emoji: '🟡',   color: '#ffd740', label: 'Hold'        },
    SELL:        { emoji: '🔴',   color: '#ff6d00', label: 'Sell'        },
    STRONG_SELL: { emoji: '🔴🔴', color: '#d50000', label: 'Strong Sell' },
  };
  return map[signal] || map['HOLD'];
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
async function getNewsImpact({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.data && (now - cache.ts) < CACHE_TTL) {
    console.log('📦 Returning cached news impact');
    return cache.data;
  }

  console.log('📰 Fetching fresh news from all sources...');
  const startTime = Date.now();

  try {
    // Fetch everything in parallel
    const [rssResults, mettisResults] = await Promise.all([
      Promise.all(NEWS_SOURCES.map(fetchRSS)),
      Promise.all(METTIS_APIS.map(fetchMettisAPI)),
    ]);

    // Merge — Mettis first (higher weight/priority)
    const allItems = [
      ...mettisResults.flat(),
      ...rssResults.flat(),
    ];

    // Sort newest-first so dedup keeps the freshest copy of each story
    allItems.sort((a, b) => {
      if (!a.pubDate || isNaN(a.pubDate)) return 1;
      if (!b.pubDate || isNaN(b.pubDate)) return -1;
      return b.pubDate - a.pubDate;
    });

    // Single dedup pass over the merged array
    const deduped = deduplicate(allItems);

    // PSX-relevant headlines first, others as padding
    const relevant  = deduped.filter(h => h.isPSX || isPSXRelevant(h.title));
    const fallback  = deduped.filter(h => !h.isPSX && !isPSXRelevant(h.title));
    const finalList = [...relevant, ...fallback].slice(0, HEADLINE_LIMIT);

    const totalFetched  = allItems.length;
    const totalRelevant = relevant.length;

    console.log(`✅ ${mettisResults.flat().length} Mettis + ${rssResults.flat().length} RSS = ${totalFetched} total (${totalRelevant} PSX-relevant) in ${Date.now() - startTime}ms`);

    // AI analysis
    const rawAI      = await analyzeWithGroq(finalList);
    const aiAnalysis = rawAI
      ? enrichWithTickers(rawAI)
      : {
          sentiment:       'NEUTRAL',
          signal:          'HOLD',
          impactScore:     0,
          confidence:      0,
          kse100Outlook:   'SIDEWAYS',
          affectedSectors: [],
          topTrades:       [],
          keyRisk:         'AI analysis unavailable',
          summary:         'AI offline — trade on technicals only',
          immediateAction: 'Wait for AI to recover or use manual analysis',
          _model:          'none',
        };

    const result = {
      headlines: finalList.map(h => ({
        title:   h.title,
        source:  h.source,
        pubDate: h.pubDate instanceof Date ? h.pubDate.toISOString() : (h.pubDate || null),
      })),
      aiAnalysis,
      signalMeta: signalMeta(aiAnalysis.signal),
      meta: {
        totalFetched,
        uniqueHeadlines: deduped.length,
        psxRelevant:     totalRelevant,
        analyzedCount:   finalList.length,
        fetchedAt:       new Date().toISOString(),
        nextRefreshAt:   new Date(now + CACHE_TTL).toISOString(),
      },
    };

    cache = { data: result, ts: now };
    return result;
  } catch (e) {
    // FIX: Top-level safety net. If anything unexpected throws (network
    // failure, JSON parse bug, memory issue), return the last cached
    // result when available instead of crashing the caller with an
    // unhandled rejection.
    console.error('❌ getNewsImpact failed:', e.message);
    if (cache.data) {
      console.log('📦 Serving stale cache due to error');
      return cache.data;
    }
    // No cache available — return a minimal safe structure so callers
    // can destructure without null-checks.
    const fallback = {
      headlines: [],
      aiAnalysis: {
        sentiment: 'NEUTRAL', signal: 'HOLD', impactScore: 0, confidence: 0,
        kse100Outlook: 'SIDEWAYS', affectedSectors: [], topTrades: [],
        keyRisk: 'Service unavailable', summary: 'News fetch failed',
        immediateAction: 'Check connection or retry', _model: 'none',
      },
      signalMeta: signalMeta('HOLD'),
      meta: { totalFetched: 0, uniqueHeadlines: 0, psxRelevant: 0, analyzedCount: 0, fetchedAt: new Date().toISOString(), nextRefreshAt: new Date(now + CACHE_TTL).toISOString() },
    };
    return fallback;
  }
}

async function getQuickSignal() {
  try {
    const impact = await getNewsImpact();
    const { aiAnalysis, signalMeta: meta } = impact;
    return {
      signal:          aiAnalysis.signal,
      emoji:           meta.emoji,
      sentiment:       aiAnalysis.sentiment,
      impactScore:     aiAnalysis.impactScore,
      confidence:      aiAnalysis.confidence,
      immediateAction: aiAnalysis.immediateAction,
      summary:         aiAnalysis.summary,
      topTrades:       aiAnalysis.topTrades || [],
      fetchedAt:       impact.meta.fetchedAt,
    };
  } catch (e) {
    // FIX: If getNewsImpact somehow still throws (e.g., cache corruption),
    // return a safe fallback so the caller in shariahService doesn't crash.
    console.error('❌ getQuickSignal failed:', e.message);
    return {
      signal: 'HOLD', emoji: '🟡', sentiment: 'NEUTRAL',
      impactScore: 0, confidence: 0,
      immediateAction: 'Wait for data', summary: 'News service unavailable',
      topTrades: [], fetchedAt: new Date().toISOString(),
    };
  }
}

module.exports = { getNewsImpact, getQuickSignal, SECTOR_TICKERS };