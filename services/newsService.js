//newsService
'use strict';

const axios = require('axios');
const Groq  = require('groq-sdk');

// const ahlService = require('./ahlResearchService');
// ─── CONFIG ───────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── NEWS SOURCES ───────────────────────────────────────────────────────────
// FIX: Commented out confirmed dead/blocked sources to eliminate startup noise.
// They can be re-enabled anytime. Health tracker handles transient failures
// for the remaining live sources.

const NEWS_SOURCES = [
  // Verified working Pakistani sources
  { name: 'Tribune Business',  url: 'https://tribune.com.pk/feed/business',       weight: 1.2 },
  { name: 'ARY News',          url: 'https://arynews.tv/feed/',                   weight: 1.0 },
  { name: 'Dawn Business',     url: 'https://www.dawn.com/feeds/business',        weight: 1.3 },

  // DISABLED — returns 403 / blocked by anti-bot
  // { name: 'Business Recorder', url: 'https://www.brecorder.com/feeds/latest-news', weight: 1.4 },

  // DISABLED — Google blocks automated RSS scraping ("audit rejected")
  // { name: 'Google News PSX',   url: 'https://news.google.com/rss/search?q=PSX+KSE100+Pakistan+stock+exchange&hl=en-PK&gl=PK&ceid=PK:en', weight: 1.0 },

  // DISABLED — endpoint returns error / internal server error
  // { name: 'Investing.com PK',  url: 'https://www.investing.com/rss/news_285.rss',  weight: 1.1 },
];

// ─── SOURCE HEALTH TRACKER ───────────────────────────────────────────────────
// Auto-disable sources that fail 3 times in a row (resets after 1 hour)
const sourceHealth = new Map();

function isSourceHealthy(name) {
  const health = sourceHealth.get(name);
  if (!health) return true;
  if (health.failCount >= 3 && Date.now() - health.lastFail < 3600000) {
    return false; // Disabled for 1 hour
  }
  return true;
}

function recordSourceFail(name) {
  const health = sourceHealth.get(name) || { failCount: 0, lastFail: 0 };
  health.failCount++;
  health.lastFail = Date.now();
  sourceHealth.set(name, health);
  console.log(`⚠️ ${name} failed ${health.failCount}x — auto-disabled for 1h`);
}

function recordSourceSuccess(name) {
  sourceHealth.delete(name);
}

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
  'Banking':     ['MEBL'],                           // Only Islamic bank compliant
  'Cement':      ['LUCK', 'DGKC', 'CHCC', 'MLCF', 'KOHC', 'FCCL','LUCK'],
  'Oil & Gas':   ['PPL', 'PSO', 'SNGP', 'SSGC', 'OGDC', 'MARI',],     // OGDC not in visible list; APL non-compliant
  'Fertilizer':  ['EFERT', 'FFC', 'FATIMA','ENGRO'],           // ENGRO not explicitly listed
  'Power':       ['HUBC', 'KEL'],                    // KAPCO non-compliant (17.79%), PKGP non-compliant (54.13%)
  'Steel':       ['ISL', 'MUGHAL'],                  // ASTL non-compliant (5.27%)
  'Textile':     ['GATM', 'GFIL','NML'],                   // NML / NCL not in verified chunks
  'Pharma':      ['SEARL', 'GLAXO', 'FEROZ', 'HINOON','AGP'],
  'Tech':        ['SYS', 'TELE'],                    // TRG non-compliant (100%)
  'Auto':        ['HCAR'],                           // INDU non-compliant (3.99%), ATLH non-compliant (1.94%)
  'Food & FMCG': ['COLG', 'UNITY'],                  // NESTLE not in Al Meezan chunks shown
  'Chemical': ['ARPL','LOTCHEM'],           // PACE non-compliant (8.12%)
  'Real State': ['DCR'],           // PACE non-compliant (8.12%)
};

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
let pendingPromise = null; // FIX: prevents duplicate concurrent fetches

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function decodeEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/<<[^>]+>/g, '')
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
// ─── RSS FETCHER (with health check + better headers) ─────────────────────────
async function fetchRSS(source) {
  if (!isSourceHealthy(source.name)) {
    console.log(`⏸ ${source.name} temporarily disabled (too many failures)`);
    return [];
  }

  try {
    const { data } = await axios.get(source.url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':    'https://www.google.com/',
      },
      maxRedirects: 5,
    });

    if (typeof data === 'string' && data.trim().startsWith('<!DOCTYPE html>')) {
      console.warn(`⚠️ ${source.name} returned HTML instead of RSS`);
      recordSourceFail(source.name);
      return [];
    }

    const items = [];
    const itemRx = /<item[\s\S]*?<\/item>/gi;
    let m;
    while ((m = itemRx.exec(data)) !== null) {
      const block = m[0];

      // FIX: corrected CDATA regex typo (was <<![CDATA[)
      const titleM = /<title>(?:<<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block);
      if (!titleM) continue;
      const title = decodeEntities(titleM[1]).trim();
      if (!title || title.length < 15) continue;

      // FIX: corrected pubDate regex typo (was <<\/pubDate>)
      const dateM = /<pubDate>([\s\S]*?)<<\/pubDate>/i.exec(block);
      const pubDate = dateM ? new Date(dateM[1].trim()) : null;
      if (isStale(pubDate)) continue;

      // FIX: extract <link> so headlines have clickable URLs
      const linkM = /<link>([\s\S]*?)<<\/link>/i.exec(block);
      const link = linkM ? decodeEntities(linkM[1]).trim() : null;

      items.push({ title, pubDate, source: source.name, weight: source.weight, isPSX: false, link });
    }

    if (items.length > 0) recordSourceSuccess(source.name);
    return items;

  } catch (err) {
    console.warn(`⚠️ ${source.name} failed: ${err.message}`);
    console.error(err.stack);
    recordSourceFail(source.name);
    return [];
  }
}

// ─── METTIS FETCHER ───────────────────────────────────────────────────────────
async function fetchMettisAPI(source) {
  try {
    const { data: rawData } = await axios.get(source.url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    // FIX 1: APIs return JSON as a string — parse it
    let data = rawData;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        console.warn(`⚠️ ${source.name} returned unparseable string`);
        return [];
      }
    }

    if (!Array.isArray(data)) {
      console.warn(`⚠️ ${source.name} data is not array:`, typeof data);
      return [];
    }

    return data
      .map(item => {
        const headingRaw = item?.Headings?.Heading;
        const descRaw    = item?.Descriptions?.Description;
        const title =
          (Array.isArray(headingRaw) ? headingRaw[0] : headingRaw) ||
          (Array.isArray(descRaw)    ? descRaw[0]    : descRaw)    ||
          '';
        if (!title || title.length < 10) return null;

        // FIX 2: Use ModifyDateTime, not PublishedTime
        const dateField = item?.ModifyDateTime || item?.PublishedDate || item?.PublishedTime;
        const pubDate = dateField ? new Date(dateField) : null;
        if (isStale(pubDate)) return null;

        // FIX 3: Defensive Tags check (field may be missing)
        const tagNode = item?.Tags?.Tag;
        const tags = Array.isArray(tagNode) ? tagNode : (tagNode ? [tagNode] : []);
        const isPSX = tags.some(
          t => t?.TagName === 'KSE100' || t?.TagType === 'Indices' || t?.TagType === 'Companies'
        ) || false;

        // Fallback: auto-mark PSX if category is Equity/Forex/Economy
        const psxCategories = ['Equity', 'FOREX', 'Economy', 'Technical Analysis', 'Company Analysis Research'];
        const categoryName = item?.CategoryName || '';
        const isPSXByCategory = psxCategories.some(c => categoryName.includes(c));

        return {
          title,
          pubDate,
          source: source.name,
          weight: 1.5,
          isPSX: isPSX || isPSXByCategory,
          link: item?.Link ? `https://mettisglobal.news/news/${item.Link}` : null,
        };
      })
      .filter(Boolean);

  } catch (err) {
    console.warn(`⚠️ ${source.name} failed: ${err.message}`);
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

  // FIX: Return in-flight promise instead of spawning duplicate fetches
  if (pendingPromise) {
    console.log('⏳ Awaiting in-flight fetch...');
    return pendingPromise;
  }

  console.log('📰 Fetching fresh news from all sources...');
  const startTime = Date.now();

  pendingPromise = (async () => {
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
        const aTime = (a.pubDate && !isNaN(a.pubDate)) ? a.pubDate.getTime() : Date.now();
        const bTime = (b.pubDate && !isNaN(b.pubDate)) ? b.pubDate.getTime() : Date.now();
        return bTime - aTime;
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
          url:     h.link || null,   // FIX: now populated for both RSS and Mettis
        })),
        aiAnalysis,
        signalMeta: signalMeta(aiAnalysis.signal),
        meta: {
          totalFetched,
          uniqueHeadlines: deduped.length,
          psxRelevant:     totalRelevant,
          analyzedCount:   finalList.length,
          fetchedAt:       new Date(now).toISOString(),
          nextRefreshAt:   new Date(now + CACHE_TTL).toISOString(),
        },
      };

      cache = { data: result, ts: now };
      return result;
    } catch (e) {
      console.error('❌ getNewsImpact failed:', e.message);
      if (cache.data) {
        console.log('📦 Serving stale cache due to error');
        return cache.data;
      }
      const fallback = {
        headlines: [],
        aiAnalysis: {
          sentiment: 'NEUTRAL', signal: 'HOLD', impactScore: 0, confidence: 0,
          kse100Outlook: 'SIDEWAYS', affectedSectors: [], topTrades: [],
          keyRisk: 'Service unavailable', summary: 'News fetch failed',
          immediateAction: 'Check connection or retry', _model: 'none',
        },
        signalMeta: signalMeta('HOLD'),
        meta: { totalFetched: 0, uniqueHeadlines: 0, psxRelevant: 0, analyzedCount: 0, fetchedAt: new Date(now).toISOString(), nextRefreshAt: new Date(now + CACHE_TTL).toISOString() },
      };
      return fallback;
    } finally {
      pendingPromise = null; // FIX: clear lock so next call can fetch fresh
    }
  })();

  return pendingPromise;
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