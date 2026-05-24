const express = require('express');
const router = express.Router();
const si = require('../services/stockIntelService');
const smcService = require('../services/smcService');
const predictService = require('../services/predictService');
const newsService = require('../services/newsService');
const shariahTradeService = require('../services/shariahTradeService');



// Get all stocks
router.get('/stocks', async (req, res) => {
  try {
    const stocks = await si.fetchAllStocks();
    res.json({ success: true, count: stocks.length, data: stocks });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get single stock
router.get('/stocks/:symbol', async (req, res) => {
  try {
    const stock = await si.getStock(req.params.symbol);
    if (!stock) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: stock });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Market summary
router.get('/market/summary', async (req, res) => {
  try {
    const summary = await si.getSummary();
    res.json({ success: true, data: summary });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Search stocks
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });
    const results = await si.searchStocks(q);
    res.json({ success: true, count: results.length, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Top opportunities
router.get('/opportunities', async (req, res) => {
  try {
    const { limit } = req.query;
    const data = await si.getOpportunities(+limit || 10);
    res.json({ success: true, count: data.length, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/sectors', async (req, res) => {
  try {
    const all = await si.fetchAllStocks();
    const sectors = {};
    
    for (const s of all) {
      if (!s.price) continue;
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

    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/smc/:symbol', async (req, res) => {
  try {
    const signals = await smcService.getSMCSignals(req.params.symbol.toUpperCase());
    res.json({ success: true, ...signals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Create prediction for a stock
router.get('/predict/:symbol', async (req, res) => {
  try {
    const stock = await si.getStock(req.params.symbol.toUpperCase());
    if (!stock) return res.status(404).json({ success: false, error: 'Not found' });
    const prediction = predictService.createPrediction(stock);
    res.json({ success: true, ...prediction });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Check predictions for a stock
router.get('/predict/check/:symbol', async (req, res) => {
  try {
    const stock = await si.getStock(req.params.symbol.toUpperCase());
    if (!stock) return res.status(404).json({ success: false, error: 'Not found' });
    const result = predictService.checkPrediction(
      stock.symbol, stock.price, stock.high, stock.low
    );
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get accuracy summary
router.get('/predict/accuracy/:symbol', async (req, res) => {
  try {
    const summary = predictService.getAccuracySummary(req.params.symbol.toUpperCase());
    res.json({ success: true, ...summary });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get all accuracies
router.get('/predict/accuracy', async (req, res) => {
  try {
    const results = predictService.getAllAccuracies();
    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/stats/daily — Today's signal performance
router.get('/stats/daily', async (req, res) => {
  try {
    const predictions = predictService.getAllAccuracies();
    const all = await si.fetchAllStocks();
    
    // Count today's signals
    const buySignals = all.filter(s => s.signal === 'BUY').length;
    const sellSignals = all.filter(s => s.signal === 'SELL').length;
    const highVolStocks = all.filter(s => s.volume > s.volAvg10d * 1.5).length;
    
    // Count successful predictions
    const totalPivot = predictions.reduce((sum, p) => sum + (p.pivotAccuracy || 0), 0);
    const totalATR = predictions.reduce((sum, p) => sum + (p.atrAccuracy || 0), 0);
    const count = predictions.length || 1;
    
    res.json({
      success: true,
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
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/predict/batch — Create predictions for top opportunities
router.post('/predict/batch', async (req, res) => {
  try {
    const opps = await si.getOpportunities(10);
    const results = [];
    
    for (const opp of opps) {
      const prediction = predictService.createPrediction(opp);
      results.push({ symbol: opp.symbol, ...prediction });
    }
    
    res.json({ success: true, created: results.length, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/stats/daily-report — Full daily performance report
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

    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/news/impact', async (req, res) => {
  try {
    const { forceRefresh } = req.query;
    const data = await newsService.getNewsImpact({ forceRefresh: forceRefresh === 'true' });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Quick signal for dashboard widget
router.get('/news/signal', async (req, res) => {
  try {
    const data = await newsService.getQuickSignal();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/kse100/volume', async (req, res) => {
  try {
    const data = await si.getKSE100Volume();
    if (!data) return res.status(404).json({ success: false, error: 'KSE100 data not available' });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/kse100/volume-speed', async (req, res) => {
  try {
    const data = await si.getVolumeSpeed();
    if (!data) return res.status(404).json({ success: false, error: 'Data not available' });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const orderFlowService = require('../services/orderFlowService');

router.get('/orderflow/:symbol', async (req, res) => {
  try {
    const analysis = orderFlowService.analyzeRatio(req.params.symbol.toUpperCase());
    res.json({ success: true, ...analysis });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/shariah/trades', async (req, res) => {
  try {
    const data = await shariahTradeService.getShariahTradeRecommendations();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Clear cache
router.post('/cache/clear', async (req, res) => {
  si.clearCache();
  res.json({ success: true, message: 'Cache cleared' });
});

module.exports = router;