require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Read saved token
const tokenFile = path.join(__dirname, '.token.json');
let token = process.env.STOCKINTEL_TOKEN;

try {
  if (fs.existsSync(tokenFile)) {
    const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (data.token) token = data.token;
  }
} catch {}

console.log('Token starts with:', token?.slice(0, 20) + '...');

const from = 1778794200;
const to = 1778815800;

(async () => {
  try {
    const { data } = await axios.get(
      'https://app.stockintel.com/api/market/bars',
      {
        params: { from, to, freq: 1, symbol: 'FFC' },
        headers: { Authorization: 'Bearer ' + token },
        timeout: 10000
      }
    );

    console.log('Response keys:', Object.keys(data));
    console.log('Full:', JSON.stringify(data).slice(0, 1000));
  } catch (e) {
    console.log('Status:', e.response?.status);
    console.log('Error:', JSON.stringify(e.response?.data || e.message).slice(0, 300));
  }
})();