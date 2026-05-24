require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const tokenFile = path.join(__dirname, '.token.json');
let token = process.env.STOCKINTEL_TOKEN;
try {
  const d = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (d.token) token = d.token;
} catch {}

const now = Math.floor(Date.now() / 1000);
const thirtyDaysAgo = now - 2592000;

(async () => {
  try {
    const { data } = await axios.get('https://app.stockintel.com/api/market/bars', {
      params: { symbol: 'KSE100', from: thirtyDaysAgo, to: now, freq: '1D' },
      headers: { Authorization: 'Bearer ' + token },
      timeout: 10000
    });
    const bars = data?.data || [];
    console.log('Got', bars.length, 'daily KSE100 bars');
    if (bars.length > 0) {
      console.log('First:', JSON.stringify(bars[0]));
      console.log('Last:', JSON.stringify(bars[bars.length - 1]));
      bars.slice(-10).forEach(b => console.log(
        new Date(b.time * 1000).toDateString(),
        '| Close:', b.close,
        '| Vol:', b.volume?.toLocaleString()
      ));
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
})();