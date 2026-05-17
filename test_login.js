require('dotenv').config();
const axios = require('axios');

(async () => {
  try {
    const { data } = await axios.post('https://app.stockintel.com/api/login', {
      phone: process.env.STOCKINTEL_PHONE,
      password: process.env.STOCKINTEL_PASSWORD,
      device: { id: 'test', name: 'Chrome', os: 'windows', type: 'desktop' }
    }, { timeout: 10000 });
    console.log('RESPONSE:', JSON.stringify(data));
  } catch (e) {
    console.log('STATUS:', e.response?.status);
    console.log('DATA:', e.response?.data);
  }
})();