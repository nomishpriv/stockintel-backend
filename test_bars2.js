require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const tokenFile = path.join(__dirname, '.token.json');
let token = process.env.STOCKINTEL_TOKEN;
try {
  if (fs.existsSync(tokenFile)) {
    const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (data.token) token = data.token;
  }
} catch {}

// Try last 24 hours
const now = Math.floor(Date.now() / 1000);
const yesterday = now - 86400;

(async () => {
  try {
    const { data } = await axios.get(
      'https://app.stockintel.com/api/market/bars',
      {
        params: { from: yesterday, to: now, freq: 1, symbol: 'FFC' },
        headers: { Authorization: 'Bearer ' + token },
        timeout: 10000
      }
    );

    console.log('Status:', data.status);
    console.log('Data type:', typeof data.data);
    console.log('Data length:', Array.isArray(data.data) ? data.data.length : 'not array');
    
    if (Array.isArray(data.data) && data.data.length > 0) {
      console.log('First bar:', JSON.stringify(data.data[0]));
      console.log('Last bar:', JSON.stringify(data.data[data.data.length - 1]));
    } else {
      console.log('Empty — trying FFC with freq=5...');
      
      const { data: data2 } = await axios.get(
        'https://app.stockintel.com/api/market/bars',
        {
          params: { from: yesterday, to: now, freq: 5, symbol: 'FFC' },
          headers: { Authorization: 'Bearer ' + token },
          timeout: 10000
        }
      );
      console.log('freq=5:', JSON.stringify(data2).slice(0, 500));
    }
  } catch (e) {
    console.log('Error:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
  }
})();