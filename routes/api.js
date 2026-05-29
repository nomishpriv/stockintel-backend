const express = require('express');
const router = express.Router();
const si = require('../services/stockIntelService');
const smcService = require('../services/smcService');
const predictService = require('../services/predictService');
const newsService = require('../services/newsService');
const shariahTradeService = require('../services/shariahTradeService');
const institutionalService = require('../services/institutionalActivityService');
const orderFlowService = require('../services/orderFlowService');
const resultService = require('../services/resultAnnouncementService');
const { getUnifiedSignal, getUnifiedSignalsForStocks } = require('../services/unifiedSignalService');
const alertService = require('../services/alertService');
const alertLogger  = require('../services/alertLoggerService');


// ─── HELPERS ──────────────────────────────────────────────────────────────────
// FIX: Unified error response helper so every endpoint returns the same shape
// on failure, making client-side error handling predictable.
function errorRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// FIX: Unified success response helper for consistency.
function successRes(res, data, extra = {}) {
  return res.json({ success: true, ...extra, ...data });
}

// ─── STOCKS ───────────────────────────────────────────────────────────────────
router.get('/stocks', async (req, res) => {
  try {
    const stocks = await si.fetchAllStocks();
    successRes(res, { data: stocks }, { count: stocks.length });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/stocks/:symbol', async (req, res) => {
  try {
    const stock = await si.getStock(req.params.symbol);
    if (!stock) return errorRes(res, 404, 'Not found');
    successRes(res, { data: stock });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/market/summary', async (req, res) => {
  try {
    const summary = await si.getSummary();
    successRes(res, { data: summary });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string') return successRes(res, { data: [] });
    const results = await si.searchStocks(q);
    successRes(res, { data: results }, { count: results.length });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/opportunities', async (req, res) => {
  try {
    const { limit } = req.query;
    // FIX: Guard against NaN and negative limit so the API doesn't crash
    // or return garbage when the client sends ?limit=abc or ?limit=-5.
    const n = Number.isFinite(+limit) && +limit > 0 ? +limit : 10;
    const data = await si.getOpportunities(n);
    successRes(res, { data }, { count: data.length });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── SECTORS ──────────────────────────────────────────────────────────────────
router.get('/sectors', async (req, res) => {
  try {
    const all = await si.fetchAllStocks();
    if (!Array.isArray(all)) return errorRes(res, 500, 'Invalid stock data');

    const sectors = {};
    for (const s of all) {
      if (!s.price) continue;
      // FIX: Guard against missing or non-string name so .toLowerCase() doesn't
      // throw when the API omits the company name field.
      if (!s.name || typeof s.name !== 'string') continue;

      let sector = 'Other';
      const n = s.name.toLowerCase();
      if (n.includes('cement')) sector = 'Cement';
      else if (n.includes('fertilizer')) sector = 'Fertilizer';
      else if (n.includes('bank')) sector = 'Banking';
      else if (n.includes('oil') || n.includes('petroleum')) sector = 'Oil & Gas';
      else if (n.includes('power') || n.includes('energy')) sector = 'Power';
      else if (n.includes('pharma') || n.includes('lab')) sector = 'Pharma';
      else if (n.includes('textile') || n.includes('mills')) sector = 'Textile';
      else if (n.includes('steel') || n.includes('iron')) sector = 'Steel';
      else if (n.includes('auto') || n.includes('motor')) sector = 'Automobile';
      else if (n.includes('tech') || n.includes('system')) sector = 'Technology';
      else if (n.includes('sugar') || n.includes('food')) sector = 'Food';
      else if (n.includes('chemical')) sector = 'Chemicals';
      else if (n.includes('glass')) sector = 'Glass';
      else if (n.includes('insurance')) sector = 'Insurance';

      if (!sectors[sector]) sectors[sector] = { name: sector, count: 0, avgChange: 0 };
      sectors[sector].count++;
      sectors[sector].avgChange += s.changePercent;
    }

    const data = Object.values(sectors).map(s => ({
      ...s,
      avgChange: +(s.avgChange / s.count).toFixed(2)
    })).sort((a, b) => b.avgChange - a.avgChange);

    successRes(res, { data });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── SMC ──────────────────────────────────────────────────────────────────────
router.get('/smc/:symbol', async (req, res) => {
  try {
    const signals = await smcService.getSMCSignals(req.params.symbol.toUpperCase());
    successRes(res, signals);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── PREDICTIONS ──────────────────────────────────────────────────────────────
// FIX: Added await on predictService.createPrediction. The old code called
// the sync-looking function without await, but predictService.createPrediction
// is now async (after the file-write fix). Without await the response would
// be a Promise object instead of the actual prediction data.


// FIX: Added await on predictService.checkPrediction for the same reason —
// the function is now async and returns a Promise.



// GENERAL route FIRST
router.get('/predict/accuracy', async (req, res) => {
  try {
    const results = await predictService.getAllAccuracies();
    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PARAMETERIZED route SECOND
router.get('/predict/accuracy/:symbol', async (req, res) => {
  try {
    const summary = await predictService.getAccuracySummary(req.params.symbol.toUpperCase());
    res.json({ success: true, ...summary });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/predict/check/:symbol', async (req, res) => {
  try {
    const stock = await si.getStock(req.params.symbol);
    if (!stock) return errorRes(res, 404, 'Not found');
    const result = await predictService.checkPrediction(
      stock.symbol, stock.price, stock.high, stock.low
    );
    successRes(res, result);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/predict/:symbol', async (req, res) => {
  try {
    const stock = await si.getStock(req.params.symbol);
    if (!stock) return errorRes(res, 404, 'Not found');
    const prediction = await predictService.createPrediction(stock);
    successRes(res, prediction);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// FIX: Added await on predictService.getAllAccuracies — now async.
router.get('/stats/daily', async (req, res) => {
  try {
    const predictions = await predictService.getAllAccuracies();
    const all = await si.fetchAllStocks();
    if (!Array.isArray(all)) return errorRes(res, 500, 'Invalid stock data');

    const buySignals = all.filter(s => s.signal === 'BUY').length;
    const sellSignals = all.filter(s => s.signal === 'SELL').length;
    const highVolStocks = all.filter(s => s.volAvg10d > 0 && s.volume > s.volAvg10d * 1.5).length;

    const totalPivot = predictions.reduce((sum, p) => sum + (p.pivotAccuracy || 0), 0);
    const totalATR = predictions.reduce((sum, p) => sum + (p.atrAccuracy || 0), 0);
    const count = predictions.length || 1;

    successRes(res, {
      data: {
        totalStocks: all.length,
        buySignals,
        sellSignals,
        highVolStocks,
        avgPivotAccuracy: +(totalPivot / count).toFixed(1),
        avgATRAccuracy: +(totalATR / count).toFixed(1),
        predictionsTracked: predictions.length
      }
    });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// FIX: Added await on predictService.createPrediction inside the loop.
// Also added a guard so opps is an array before iterating.
router.post('/predict/batch', async (req, res) => {
  try {
    const opps = await si.getOpportunities(10);
    if (!Array.isArray(opps)) return errorRes(res, 500, 'Invalid opportunities data');

    const results = [];
    for (const opp of opps) {
      const prediction = await predictService.createPrediction(opp);
      results.push({ symbol: opp.symbol, ...prediction });
    }

    successRes(res, { data: results }, { created: results.length });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── DAILY REPORT ─────────────────────────────────────────────────────────────
router.get('/stats/daily-report', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const PREDICT_FILE = path.join(__dirname, '..', '.predictions.json');

    let allPredictions = {};
    try {
      if (fs.existsSync(PREDICT_FILE)) {
        allPredictions = JSON.parse(fs.readFileSync(PREDICT_FILE, 'utf8'));
      }
    } catch {}

    const report = {
      date: new Date().toISOString().split('T')[0],
      totalStocks: Object.keys(allPredictions).length,
      details: []
    };

    let totalPivotWins = 0, totalPivotLosses = 0;
    let totalATRWins = 0, totalATRLosses = 0;

    for (const [symbol, predictions] of Object.entries(allPredictions)) {
      // FIX: Guard against non-array predictions so .filter() doesn't throw
      // when the JSON file is corrupted or manually edited.
      if (!Array.isArray(predictions)) continue;

      const completed = predictions.filter(p => p.checked);
      const pivotWins = completed.filter(p => p.pivot?.result === 'WIN').length;
      const pivotLosses = completed.filter(p => p.pivot?.result === 'LOSS').length;
      const atrWins = completed.filter(p => p.atr?.result === 'WIN').length;
      const atrLosses = completed.filter(p => p.atr?.result === 'LOSS').length;

      totalPivotWins += pivotWins;
      totalPivotLosses += pivotLosses;
      totalATRWins += atrWins;
      totalATRLosses += atrLosses;

      if (completed.length > 0) {
        report.details.push({
          symbol,
          predictions: completed.length,
          pivot: { wins: pivotWins, losses: pivotLosses, accuracy: pivotWins + pivotLosses > 0 ? +((pivotWins / (pivotWins + pivotLosses)) * 100).toFixed(0) : 0 },
          atr: { wins: atrWins, losses: atrLosses, accuracy: atrWins + atrLosses > 0 ? +((atrWins / (atrWins + atrLosses)) * 100).toFixed(0) : 0 }
        });
      }
    }

    report.summary = {
      totalPredictions: totalPivotWins + totalPivotLosses + totalATRWins + totalATRLosses,
      pivot: { wins: totalPivotWins, losses: totalPivotLosses, accuracy: totalPivotWins + totalPivotLosses > 0 ? +((totalPivotWins / (totalPivotWins + totalPivotLosses)) * 100).toFixed(0) : 0 },
      atr: { wins: totalATRWins, losses: totalATRLosses, accuracy: totalATRWins + totalATRLosses > 0 ? +((totalATRWins / (totalATRWins + totalATRLosses)) * 100).toFixed(0) : 0 },
      bestMethod: totalPivotWins + totalATRWins > 0
        ? (totalPivotWins > totalATRWins ? 'PIVOT' : 'ATR')
        : 'NONE'
    };

    successRes(res, { report });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── NEWS ─────────────────────────────────────────────────────────────────────
router.get('/news/impact', async (req, res) => {
  try {
    const { forceRefresh } = req.query;
    const data = await newsService.getNewsImpact({ forceRefresh: forceRefresh === 'true' });
    successRes(res, data);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/news/signal', async (req, res) => {
  try {
    const data = await newsService.getQuickSignal();
    successRes(res, data);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── KSE100 ───────────────────────────────────────────────────────────────────
router.get('/kse100/volume', async (req, res) => {
  try {
    const data = await si.getKSE100Volume();
    if (!data) return errorRes(res, 404, 'KSE100 data not available');
    successRes(res, data);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/kse100/volume-speed', async (req, res) => {
  try {
    const data = await si.getVolumeSpeed();
    if (!data) return errorRes(res, 404, 'Data not available');
    successRes(res, data);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── ORDER FLOW ───────────────────────────────────────────────────────────────
// FIX: Added await on orderFlowService.analyzeRatio — the function is now
// async after the file-write / batch fix. Without await the response would
// be a Promise instead of the analysis object.
router.get('/orderflow/:symbol', async (req, res) => {
  try {
    const analysis = await orderFlowService.analyzeRatio(req.params.symbol.toUpperCase());
    successRes(res, analysis);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── SHARIAH ──────────────────────────────────────────────────────────────────
router.get('/shariah/trades', async (req, res) => {
  try {
    const data = await shariahTradeService.getShariahTradeRecommendations();
    successRes(res, data);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// ─── INSTITUTIONAL ────────────────────────────────────────────────────────────
router.get('/institutional', async (req, res) => {
  try {
    const data = await institutionalService.analyzeInstitutionalActivity();
    if (!data) return errorRes(res, 404, 'Data not available');
    successRes(res, data);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/results/today', async (req, res) => {
  try {
    const data = await resultService.getTodayResultImpact();
    successRes(res, data);
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

router.get('/results/:symbol', async (req, res) => {
  try {
    const data = await resultService.getStockResult(req.params.symbol.toUpperCase());
    successRes(res, { data });
  } catch (e) {
    errorRes(res, 500, e.message);
  }
});

// Single stock super signal
router.get('/unified-signal/:symbol', async (req, res) => {
  try {
    const data = await getUnifiedSignal(req.params.symbol);
    if (!data) return res.status(404).json({ success: false, message: 'Stock not found' });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Bulk for watchlist / top picks (optional)
router.post('/unified-signals', async (req, res) => {
  try {
    const { symbols } = req.body;
    if (!Array.isArray(symbols)) return res.status(400).json({ success: false, message: 'symbols array required' });
    const data = await getUnifiedSignalsForStocks(symbols);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Preview (no message sent)
router.get('/alerts/preview', async (req, res) => {
  try {
    const data = await alertService.getAlertStocks();
    const msg  = alertService.formatMessage(data);
    res.json({ success: true, data, message: msg });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Force test — sends NOW, bypasses market hours
router.get('/alerts/test', async (req, res) => {
  try {
    const result = await alertService.forceSendAlerts();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Mobile page
router.get('/alerts/mobile', async (req, res) => {
  try {
    const latest = await alertLogger.getLatest();
    const logs   = await alertLogger.getLogs(20);
    const timePKT = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>PSX Alerts</title>
  <meta http-equiv="refresh" content="15">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 16px; padding-bottom: 80px; }
    .header { text-align: center; margin-bottom: 16px; }
    .header h1 { font-size: 18px; color: #fbbf24; }
    .time { font-size: 12px; color: #64748b; margin-top: 4px; }
    
    .alert-box { background: #1e293b; border-radius: 12px; padding: 14px; margin-bottom: 14px; border-left: 4px solid #22c55e; }
    .alert-box.no-alert { border-left-color: #f59e0b; }
    .alert-box pre { white-space: pre-wrap; word-wrap: break-word; font-size: 13px; line-height: 1.5; color: #e2e8f0; font-family: inherit; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; margin-bottom: 8px; }
    .badge.ok { background: #22c55e20; color: #22c55e; }
    .badge.no { background: #f59e0b20; color: #f59e0b; }
    
    .history { margin-top: 10px; }
    .history h2 { font-size: 14px; color: #94a3b8; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    
    .hist-item { background: #1e293b; border-radius: 10px; margin-bottom: 8px; overflow: hidden; cursor: pointer; transition: background 0.15s; }
    .hist-item:active { background: #334155; }
    .hist-header { padding: 12px; display: flex; justify-content: space-between; align-items: center; }
    .hist-left { display: flex; flex-direction: column; gap: 2px; }
    .hist-time { color: #94a3b8; font-size: 11px; }
    .hist-symbols { font-size: 13px; font-weight: 600; color: #e2e8f0; }
    .hist-count { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 10px; }
    .hist-count.ok { background: #22c55e20; color: #22c55e; }
    .hist-count.none { background: #47556920; color: #94a3b8; }
    .hist-arrow { font-size: 12px; color: #64748b; transition: transform 0.2s; }
    .hist-item.open .hist-arrow { transform: rotate(180deg); }
    
    /* FIX: Use very large max-height so even 10-stock alerts show fully */
    .hist-body { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; }
    .hist-item.open .hist-body { max-height: 5000px; }
    .hist-body-inner { padding: 0 12px 14px; border-top: 1px solid #334155; }
    .hist-body-inner pre { white-space: pre-wrap; word-wrap: break-word; font-size: 12px; line-height: 1.55; color: #cbd5e1; font-family: inherit; margin-top: 10px; }
    
    .sound-btn { position: fixed; bottom: 20px; right: 20px; background: #22c55e; color: white; border: none; border-radius: 50px; padding: 12px 20px; font-size: 13px; font-weight: 700; cursor: pointer; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .sound-btn.off { background: #ef4444; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🕌 PSX Live Alerts</h1>
    <div class="time">Auto-refresh every 15s • ${timePKT} PKT</div>
  </div>
  
  <div class="alert-box ${latest && latest.count > 0 ? '' : 'no-alert'}">
    <div class="badge ${latest && latest.count > 0 ? 'ok' : 'no'}">
      ${latest && latest.count > 0 ? `🔥 ${latest.count} PICKS` : '⏸ NO PICKS'}
    </div>
    <pre>${latest ? latest.message : 'Waiting for first alert...'}</pre>
  </div>

  <div class="history">
    <h2>📜 Recent Cycles <span style="font-weight:400;color:#64748b;font-size:12px">(tap to expand)</span></h2>
    ${logs.map((l, i) => `
      <div class="hist-item" onclick="this.classList.toggle('open')">
        <div class="hist-header">
          <div class="hist-left">
            <div class="hist-time">${l.timePKT}</div>
            <div class="hist-symbols">${l.symbols.join(', ') || 'No setups'}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="hist-count ${l.count > 0 ? 'ok' : 'none'}">${l.count} setup${l.count !== 1 ? 's' : ''}</div>
            <div class="hist-arrow">▼</div>
          </div>
        </div>
        <div class="hist-body">
          <div class="hist-body-inner">
            <pre>${l.message}</pre>
          </div>
        </div>
      </div>
    `).join('')}
  </div>

  <button class="sound-btn" id="soundBtn" onclick="toggleSound()">🔔 Sound ON</button>

  <script>
    let soundEnabled = true;
    let lastId = ${latest?.id || 0};

    function toggleSound() {
      soundEnabled = !soundEnabled;
      const btn = document.getElementById('soundBtn');
      btn.textContent = soundEnabled ? '🔔 Sound ON' : '🔕 Sound OFF';
      btn.classList.toggle('off', !soundEnabled);
    }

    function playBeep() {
      if (!soundEnabled) return;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        gain.gain.value = 0.3;
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
        setTimeout(() => {
          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx.destination);
          osc2.frequency.value = 1000;
          gain2.gain.value = 0.3;
          osc2.start();
          osc2.stop(ctx.currentTime + 0.15);
        }, 200);
      } catch(e) {}
    }

    setInterval(() => {
      fetch('/api/alerts/latest')
        .then(r => r.json())
        .then(data => {
          const newId = data?.latest?.id;
          if (newId && newId !== lastId) {
            lastId = newId;
            if (data.latest.count > 0) playBeep();
          }
        })
        .catch(() => {});
    }, 15000);
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    res.status(500).send('Error loading alerts');
  }
});

// ─── CACHE ────────────────────────────────────────────────────────────────────
router.post('/cache/clear', async (req, res) => {
  si.clearCache();
  successRes(res, { message: 'Cache cleared' });
});

module.exports = router;