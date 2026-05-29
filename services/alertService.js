// services/alertService.js
const axios = require('axios');
const newsService = require('./newsService');
const shariahService = require('./shariahTradeService');
const unifiedService = require('./unifiedSignalService');
const logger = require('./alertLoggerService');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CALLMEBOT_APIKEY   = process.env.CALLMEBOT_APIKEY;
const CALLMEBOT_PHONE    = process.env.CALLMEBOT_PHONE;

function isMarketOpen() {
  const pkt  = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const day  = pkt.getUTCDay();
  const hour = pkt.getUTCHours();
  const min  = pkt.getUTCMinutes();
  const time = hour + min / 60;
  if (day === 0 || day === 6) return false;
  if (day >= 1 && day <= 4) return time >= 9.5 && time <= 15.5;
  if (day === 5) return (time >= 9.25 && time <= 12.0) || (time >= 14.5 && time <= 16.5);
  return false;
}

async function getAlertStocks() {
  const [news, shariah] = await Promise.all([
    newsService.getQuickSignal().catch(() => null),
    shariahService.getShariahTradeRecommendations().catch(() => null)
  ]);

  const symbols = new Set();
  const meta = new Map();

  if (news?.topTrades?.length > 0) {
    for (const t of news.topTrades) {
      if (t.ticker && (t.action === 'BUY' || t.action === 'STRONG_BUY')) {
        const sym = t.ticker.toUpperCase();
        symbols.add(sym);
        if (!meta.has(sym)) meta.set(sym, { sources: [] });
        meta.get(sym).sources.push('AI News');
      }
    }
  }

  if (shariah?.recommendations?.length > 0) {
    for (const r of shariah.recommendations) {
      if (r.symbol && (r.recommendation === 'STRONG_LONG' || r.recommendation === 'LONG')) {
        const sym = r.symbol.toUpperCase();
        symbols.add(sym);
        if (!meta.has(sym)) meta.set(sym, { sources: [] });
        meta.get(sym).sources.push('Shariah');
      }
    }
  }

  if (symbols.size === 0) return null;

  const unified = await unifiedService.getUnifiedSignalsForStocks(Array.from(symbols));
  const actionable = unified
    .map(u => ({ ...u, sources: [...new Set(meta.get(u.symbol)?.sources || [])] }))
    .filter(u => u.signal === 'BUY' || u.signal === 'STRONG_BUY');

  return {
    marketContext: {
      newsSentiment: news?.sentiment || 'NEUTRAL',
      newsSignal:    news?.signal || 'HOLD',
      newsSummary:   news?.summary || '',
      shariahCount:  shariah?.recommendations?.length || 0
    },
    alerts: actionable,
    timestamp: new Date().toISOString()
  };
}

function formatMessage(data) {
  const timePKT = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
  if (!data || data.alerts.length === 0) {
    return `🕌 PSX Alert | ${timePKT} PKT\n\nNo actionable BUY setups from AI News + Shariah right now.\n📰 Context: ${data?.marketContext?.newsSummary || 'N/A'}`;
  }
  let msg = `🕌 <b>PSX Auto Alert</b>\n⏰ <code>${timePKT} PKT</code>\n`;
  msg += `📰 News: ${data.marketContext.newsSentiment} (${data.marketContext.newsSignal})\n`;
  msg += `────────────────────\n`;
  for (const a of data.alerts) {
    const srcTags = a.sources.map(s => s === 'AI News' ? '📰' : '🕌').join('');
    const both = a.sources.length > 1 ? ' ⚡BOTH' : '';
    msg += `\n${a.signalMeta?.emoji || '🟢'} <b>${srcTags} ${a.symbol}${both}</b>\n`;
    msg += `💰 Price: ₨${a.price?.toFixed(2)}\n`;
    if (a.levels?.entry)    msg += `🎯 Entry:  ₨${a.levels.entry.toFixed(2)}\n`;
    if (a.levels?.target)   msg += `📈 Target: ₨${a.levels.target.toFixed(2)}\n`;
    if (a.levels?.stopLoss) msg += `🛑 SL:     ₨${a.levels.stopLoss.toFixed(2)}\n`;
    msg += `⚠️ Risk: ${a.risk} | Conf: ${a.confidence}%\n`;
    const short = a.description?.split('.')[0] || '';
    msg += `<i>${short}</i>\n`;
  }
  msg += `\n────────────────────\n<i>Auto 15-min alert. Trade at your own risk.</i>`;
  return msg;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML'
    }, { timeout: 8000 });
    return true;
  } catch (e) {
    console.error('❌ Telegram failed:', e.message);
    return false;
  }
}

async function sendWhatsApp(text) {
  if (!CALLMEBOT_APIKEY || !CALLMEBOT_PHONE) return false;
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${CALLMEBOT_PHONE}&text=${encodeURIComponent(text)}&apikey=${CALLMEBOT_APIKEY}`;
    await axios.get(url, { timeout: 8000 });
    return true;
  } catch (e) {
    console.error('❌ WhatsApp failed:', e.message);
    return false;
  }
}

async function sendAlerts() {
  const data = await getAlertStocks();
  const message = formatMessage(data);

  // Try Telegram/WhatsApp first
  const tgOk = await sendTelegram(message);
  const waOk = await sendWhatsApp(message);

  // ALWAYS save to local file (works even when internet is down)
  await logger.logAlert(message, data);

  if (!tgOk && !waOk) {
    console.log('💾 Alert saved to local file (.alerts.json) — Telegram/WhatsApp unreachable');
  }
}

module.exports = { getAlertStocks, formatMessage, sendAlerts, sendTelegram, sendWhatsApp };