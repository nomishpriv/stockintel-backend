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

  // 1. AI News picks (ALL of them, not just BUY)
  if (news?.topTrades?.length > 0) {
    for (const t of news.topTrades) {
      const sym = t.ticker?.toUpperCase();
      if (!sym) continue;
      symbols.add(sym);
      if (!meta.has(sym)) meta.set(sym, { sources: [], aiAction: null, aiReason: null });
      meta.get(sym).sources.push('AI News');
      meta.get(sym).aiAction = t.action;
      meta.get(sym).aiReason = t.reason;
    }
  }

  // 2. Shariah picks (ALL of them, not just STRONG_LONG)
  if (shariah?.recommendations?.length > 0) {
    for (const r of shariah.recommendations) {
      const sym = r.symbol?.toUpperCase();
      if (!sym) continue;
      symbols.add(sym);
      if (!meta.has(sym)) meta.set(sym, { sources: [], aiAction: null, aiReason: null });
      meta.get(sym).sources.push('Shariah');
      meta.get(sym).shariahRec = r.recommendation;
      meta.get(sym).shariahScore = r.score;
    }
  }

  if (symbols.size === 0) return null;

  // 3. Get unified analysis for EVERY symbol (no filtering)
  const unified = await unifiedService.getUnifiedSignalsForStocks(Array.from(symbols));

  // 4. Merge source tags + keep ALL (even WAIT/NEUTRAL)
  const allPicks = unified.map(u => {
    const m = meta.get(u.symbol) || { sources: [] };
    const isBoth = m.sources.length > 1;
    return {
      ...u,
      sources: [...new Set(m.sources)],
      aiAction: m.aiAction,
      aiReason: m.aiReason,
      shariahRec: m.shariahRec,
      shariahScore: m.shariahScore,
      isBoth
    };
  });

  // Sort: BUY first, then WAIT, then others
  const sortOrder = { STRONG_BUY: 0, BUY: 1, WAIT: 2, NEUTRAL: 3, SELL: 4, STRONG_SELL: 5 };
  allPicks.sort((a, b) => (sortOrder[a.signal] || 99) - (sortOrder[b.signal] || 99));

  return {
    marketContext: {
      newsSentiment: news?.sentiment || 'NEUTRAL',
      newsSignal:    news?.signal || 'HOLD',
      newsSummary:   news?.summary || '',
      shariahCount:  shariah?.recommendations?.length || 0,
      totalPicks:    allPicks.length
    },
    alerts: allPicks,
    timestamp: new Date().toISOString()
  };
}

function formatMessage(data) {
  const timePKT = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });

  if (!data || data.alerts.length === 0) {
    return `🕌 PSX Alert | ${timePKT} PKT\n\nNo picks from AI News or Shariah right now.`;
  }

  let msg = `🕌 <b>PSX Auto Alert</b>\n⏰ <code>${timePKT} PKT</code>\n`;
  msg += `📰 News: ${data.marketContext.newsSentiment} (${data.marketContext.newsSignal})\n`;
  msg += `🕌 Shariah picks: ${data.marketContext.shariahCount}\n`;
  msg += `📊 Total scanned: ${data.marketContext.totalPicks}\n`;
  msg += `────────────────────\n`;

  for (const a of data.alerts) {
    const srcTags = a.sources.map(s => s === 'AI News' ? '📰' : '🕌').join('');
    const both    = a.isBoth ? ' ⚡BOTH' : '';
    const sigEmoji = a.signalMeta?.emoji || '⚪';
    const sigLabel = a.signalMeta?.action || a.signal;

    msg += `\n${sigEmoji} <b>${srcTags} ${a.symbol}${both}</b> — ${sigLabel}\n`;
    msg += `💰 Price: ₨${a.price?.toFixed(2)} | ${a.changePercent > 0 ? '+' : ''}${a.changePercent?.toFixed(2)}%\n`;

    // Volume with average comparison
    const volK = (a.volume / 1000).toFixed(0);
    if (a.volAvg10d > 0) {
      const volRatio = (a.volume / a.volAvg10d).toFixed(1);
      const volTrend = a.volume > a.volAvg10d * 1.5 ? '🔥 Surging' :
                       a.volume > a.volAvg10d * 1.2 ? '⬆️ Above avg' :
                       a.volume > a.volAvg10d * 0.8 ? '➡️ Normal' : '⬇️ Below avg';
      msg += `📊 Vol: ${volK}K (${volRatio}x vs 10d avg) ${volTrend}\n`;
    } else {
      msg += `📊 Vol: ${volK}K\n`;
    }

    if (a.rsi) msg += `📈 RSI: ${a.rsi.toFixed(0)} | `;
    msg += `Conf: ${a.confidence}% | Risk: ${a.risk}\n`;

    // Entry / Target / SL
    if (a.levels?.entry)    msg += `🎯 Entry:  ₨${a.levels.entry.toFixed(2)}\n`;
    if (a.levels?.target)   msg += `📈 Target: ₨${a.levels.target.toFixed(2)}\n`;
    if (a.levels?.stopLoss) msg += `🛑 SL:     ₨${a.levels.stopLoss.toFixed(2)}\n`;

    // FULL unified description — no truncation
    if (a.description) {
      msg += `🧠 <i>${a.description}</i>\n`;
    }

    // SMC Details (full, not truncated)
    const smc = a.details?.smc;
    if (smc) {
      const parts = [];
      if (smc.fvg?.length > 0) {
        const f = smc.fvg[0];
        parts.push(`${f.type.includes('BULLISH') ? '🟢' : '🔴'} FVG ${f.zone?.bottom?.toFixed(1)}-${f.zone?.top?.toFixed(1)} (${f.gapPct}%)`);
      }
      if (smc.orderBlocks?.length > 0) {
        const ob = smc.orderBlocks[0];
        parts.push(`${ob.type.includes('BULLISH') ? '🟢' : '🔴'} OB ${ob.zone?.bottom?.toFixed(1)}-${ob.zone?.top?.toFixed(1)}`);
      }
      if (smc.liquiditySweeps?.length > 0) {
        const sw = smc.liquiditySweeps[0];
        parts.push(`${sw.type.includes('BULLISH') ? '🟢' : '🔴'} Sweep @ ${sw.level?.toFixed(1)}`);
      }
      if (smc.bos?.length > 0) {
        const b = smc.bos[smc.bos.length - 1];
        parts.push(`${b.type === 'BULLISH' ? '🟢' : '🔴'} BOS`);
      }
      if (smc.choch?.length > 0) {
        const c = smc.choch[smc.choch.length - 1];
        parts.push(`${c.type.includes('BULLISH') ? '🟢' : '🔴'} CHOCH`);
      }
      if (parts.length > 0) {
        msg += `📐 SMC: ${parts.join(' | ')}\n`;
      }
    }

    // Order Flow (full)
    const flow = a.details?.orderFlow;
    if (flow?.ready) {
      const flowEmoji = flow.trend === 'BUYING_INCREASING' ? '🟢' :
                        flow.trend === 'SELLING_INCREASING' ? '🔴' :
                        flow.trend === 'BUYERS_DOMINANT' ? '🟢' :
                        flow.trend === 'SELLERS_DOMINANT' ? '🔴' : '⚪';
      msg += `⚖️ Flow: ${flowEmoji} ${flow.trend} (ratio ${flow.overallRatio}) | ${flow.snapshots} snaps\n`;
    }

    // Source-specific notes (full AI reason, not truncated)
    if (a.aiReason) msg += `📰 AI News: ${a.aiReason}\n`;
    if (a.shariahScore) msg += `🕌 Shariah Score: ${a.shariahScore}/100\n`;
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
  if (!isMarketOpen()) {
    console.log('⏸ Market closed — skipping alert cycle');
    return;
  }

  const data    = await getAlertStocks();
  const message = formatMessage(data);

  const tgOk = await sendTelegram(message);
  const waOk = await sendWhatsApp(message);
  await logger.logAlert(message, data);

  if (!tgOk && !waOk) {
    console.log('💾 Alert saved to local file (.alerts.json)');
  }
}

// Force-send regardless of market hours (for testing)
async function forceSendAlerts() {
  const data    = await getAlertStocks();
  const message = formatMessage(data);

  const tgOk = await sendTelegram(message);
  const waOk = await sendWhatsApp(message);
  await logger.logAlert(message, data);

  return { telegram: tgOk, whatsapp: waOk, logged: true, data };
}

module.exports = { getAlertStocks, formatMessage, sendAlerts, forceSendAlerts, sendTelegram, sendWhatsApp };