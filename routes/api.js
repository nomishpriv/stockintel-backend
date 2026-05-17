const express = require('express');
const router = express.Router();
const si = require('../services/stockIntelService');
const smcService = require('../services/smcService');


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

// Clear cache
router.post('/cache/clear', async (req, res) => {
  si.clearCache();
  res.json({ success: true, message: 'Cache cleared' });
});

module.exports = router;