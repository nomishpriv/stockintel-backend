// services/ahlResearchService.js
const axios = require('axios');
const { PdfReader } = require('pdfreader');

const AHL_API = 'https://arifhabibltd.com/api/research/list/res';
const AHL_PDF = 'https://arifhabibltd.com/api/research/open';

const CATEGORIES = [
  { id: '648c11830ffa16ff64800070', name: 'Daily Call', weight: 2.0, intraday: true },
  { id: '648c118a0ffa16ff64800075', name: 'AHL Technical', weight: 1.5, intraday: false },
  { id: '648c118b0ffa16ff64800076', name: 'From Trading Floor', weight: 1.8, intraday: true },
  { id: '648c11950ffa16ff648002ae', name: 'Alert', weight: 2.0, intraday: true },
  { id: '648c117a0ffa16ff647fff74', name: 'News Highlights', weight: 1.5, intraday: false },
];

// Primary: 48h for intraday. Fallback: 7 days if nothing fresh.
const MAX_AGE_HOURS = 48;
const FALLBACK_AGE_HOURS = 168; // 7 days

function isStale(crtDate, hours = MAX_AGE_HOURS) {
  if (!crtDate) return true;
  const age = (Date.now() - new Date(crtDate).getTime()) / 3_600_000;
  return age > hours;
}

async function fetchPDFText(filePath) {
  if (!filePath) return null;
  try {
    const url = `${AHL_PDF}?path=${encodeURIComponent(filePath)}`;
    const { data: buffer } = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    const text = await new Promise((resolve, reject) => {
      let fullText = '';
      const reader = new PdfReader();
      reader.parseBuffer(buffer, (err, item) => {
        if (err) reject(err);
        else if (!item) resolve(fullText);
        else if (item.text) fullText += item.text + ' ';
      });
    });

    console.log(`✅ PDF parsed: ${filePath} (${text.length} chars)`);
    return text.substring(0, 4000);

  } catch (e) {
    console.error(`❌ PDF failed: ${filePath} - ${e.message}`);
    return null;
  }
}

function extractTickersFromText(text) {
  if (!text) return [];
  const matches = text.match(/\b[A-Z]{3,6}\b/g) || [];
  const common = new Set([
    'THE','AND','FOR','ARE','BUT','NOT','YOU','ALL','ANY','CAN','HAD','HER','WAS','ONE','OUR','OUT','DAY','GET','HAS','HIM','HIS','HOW','MAN','NEW','NOW','OLD','SEE','TWO','WAY','WHO','BOY','DID','ITS','LET','PUT','SAY','SHE','TOO','USE',
    'EPS','PAT','PKR','USD','CAGR','ROE','DPS','BVPS','KSE','PSX','SBP','IMF','GDP','CPI','FCA','OMC','AUM','AHL','FY','CY','QoQ','YoY','MoM','SPLY',
    'BUY','SELL','HOLD','ADD','REDUCE','ACCUMULATE','OVERWEIGHT','UNDERWEIGHT','NEUTRAL','MARKET','PERFORM','OUTPERFORM','UNDERPERFORM',
    'SECTOR','RESULT','REVIEW','PREVIEW','UPDATE','WEEKLY','MONTHLY','DAILY','ANALYSIS','RESEARCH','REPORT','EARNINGS','PROFIT','SALES','REVENUE','MARGIN','COST','TAX','RATE','PRICE','TARGET','SUPPORT','RESISTANCE','INDEX','STOCK','SHARE','DIVIDEND','BONUS','RIGHTS','SPLIT','MERGER','ACQUISITION',
    'CONFIZ','CPEC','BFSI','TELCO','IT','UAE','USA','UK','EU','MENA','GCC','OPEC','Saudi','Middle','East','North','America','Europe','Asia','Pakistan','China','India','Iran','US','UN','IPO',
    'DMA','DEMA','SMA','EMA','RSI','MACD','ATR','OBV','ADX','CCI','ROC','STOCH','WILLR','MOM','TRIX','KST','PSAR','ICHIMOKU','BOLLINGER','FIBONACCI','PIVOT','CAMARILLA','WOODIE','FLOOR','CEILING',
    'LNG','LSEG','VLCC','MTD','HSI','SENSEX','NKY','UKX','SHASHR','CCMP','SPX','DJI','NDX','RUT','FTSE','DAX','CAC','SX5E','TSX','ASX','NZX','KOSPI','TSEC','SSE','SZSE','HSCI','HSCE','HSCC','BSE','NSE','NIFTY','BANKEX'
  ]);
  return [...new Set(matches.filter(m => m.length >= 3 && !common.has(m)))].slice(0, 10);
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  if (data?.status?.data && Array.isArray(data.status.data)) return data.status.data;
  if (data?.results && Array.isArray(data.results)) return data.results;
  
  for (const key of Object.keys(data || {})) {
    const val = data[key];
    if (Array.isArray(val) && val.length > 0 && (val[0].tt || val[0].title)) return val;
    if (typeof val === 'object' && val !== null) {
      for (const subKey of Object.keys(val)) {
        const subVal = val[subKey];
        if (Array.isArray(subVal) && subVal.length > 0 && (subVal[0].tt || subVal[0].title)) return subVal;
      }
    }
  }
  return [];
}

async function fetchAHLCategory(cat, limit = 5) {
  try {
    const url = `${AHL_API}?count=${limit}&offset=0&category=${cat.id}`;
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    if (typeof data === 'string') {
      console.warn(`⚠️ AHL ${cat.name}: Got HTML instead of JSON`);
      return [];
    }

    const items = extractItems(data);
    console.log(`📡 AHL ${cat.name}: extracted ${items.length} items`);

    let results = [];
    let fallbackResults = [];

    for (const item of items) {
      // FIX: Skip items with no title
      if (!item.tt || typeof item.tt !== 'string') continue;

      // Primary filter: 48 hours
      if (!isStale(item.crt, MAX_AGE_HOURS)) {
        const parsed = await parseItem(item, cat);
        if (parsed) results.push(parsed);
      }
      // Fallback filter: 7 days (collected but only used if primary is empty)
      else if (!isStale(item.crt, FALLBACK_AGE_HOURS)) {
        const parsed = await parseItem(item, cat);
        if (parsed) fallbackResults.push(parsed);
      } else {
        console.log(`   ⏸ Stale: ${item.tt.substring(0, 40)} (${item.crt})`);
      }
    }

    // If no recent items, use fallback (newest within 7 days)
    if (results.length === 0 && fallbackResults.length > 0) {
      fallbackResults.sort((a, b) => b.pubDate - a.pubDate);
      results = fallbackResults.slice(0, 2); // max 2 fallback per category
      console.log(`🔄 AHL ${cat.name}: using ${results.length} fallback items (7d)`);
    }

    console.log(`✅ AHL ${cat.name}: ${results.length} valid items`);
    return results;

  } catch (e) {
    console.error(`❌ AHL ${cat.name} failed: ${e.message}`);
    return [];
  }
}

// ─── PARSE SINGLE ITEM (shared for primary + fallback) ──────────────────────
async function parseItem(item, cat) {
  let text = item.dsc || '';
  let tickers = item.sy || [];

  if (!text || text.trim().length < 50) {
    const pdfText = await fetchPDFText(item.file);
    if (pdfText) {
      text = pdfText;
      if (!tickers || tickers.length === 0) {
        tickers = extractTickersFromText(pdfText);
      }
    }
  }

  if (!text || text.trim().length < 30) return null;

  if (!tickers || tickers.length === 0) {
    tickers = extractTickersFromText(`${item.tt} ${text}`);
  }

  const snippet = text.replace(/\s+/g, ' ').trim();
  const shortText = snippet.length > 180 ? snippet.substring(0, 180) + '...' : snippet;

  return {
    title: `[${cat.name}] ${item.tt}: ${shortText}`,
    fullText: text,
    tickers,
    pubDate: new Date(item.crt),
    source: `AHL ${cat.name}`,
    weight: cat.weight,
    isPSX: true,
    intraday: cat.intraday,
  };
}

async function fetchAHLResearch() {
  const all = [];
  for (const cat of CATEGORIES) {
    const items = await fetchAHLCategory(cat, 5);
    all.push(...items);
  }
  all.sort((a, b) => b.pubDate - a.pubDate);
  return all.slice(0, 15);
}

module.exports = { fetchAHLResearch, extractTickersFromText };