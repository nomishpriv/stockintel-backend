// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5001;

const cron = require('node-cron');
const { sendAlerts } = require('./services/alertService');
const { createKMI30Predictions, checkKMI30Predictions } = require('./services/kmi30PredictService');

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});


// Every 15 minutes, 24/7 (isMarketOpen inside filters non-trading hours)
cron.schedule('*/15 * * * *', async () => {
  console.log('⏰ Alert cycle triggered:', new Date().toISOString());
  await sendAlerts();
});

// KMI-30 Intraday Scanner: every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  if (!isMarketOpen()) return;
  console.log('🔥 KMI-30 scan triggered:', new Date().toISOString());
  await createKMI30Predictions();
  await checkKMI30Predictions();
});

// Start
app.listen(PORT, () => {
  console.log(`✅ StockIntel API running on http://localhost:${PORT}`);
});