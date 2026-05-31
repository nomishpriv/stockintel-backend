const axios = require('axios');

async function debug() {
  const url = 'https://arifhabibltd.com/api/research/list/res?count=3&offset=0&category=648c11830ffa16ff64800070';
  
  try {
    const { data, headers } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    console.log('Content-Type:', headers['content-type']);
    console.log('Type of data:', typeof data);
    console.log('Is Array:', Array.isArray(data));
    
    if (Array.isArray(data)) {
      console.log('✅ data IS the array. Length:', data.length);
      if (data.length > 0) {
        console.log('First item keys:', Object.keys(data[0]));
        console.log('First item tt:', data[0].tt);
        console.log('First item crt:', data[0].crt);
      }
      return;
    }

    if (typeof data === 'object' && data !== null) {
      console.log('Top-level keys:', Object.keys(data));
      
      // Check common paths
      const paths = ['status', 'data', 'results', 'items', 'posts', 'response', 'body'];
      for (const key of paths) {
        if (data[key] !== undefined) {
          const val = data[key];
          console.log(`\n--- data.${key} ---`);
          console.log('Type:', typeof val, '| Is Array:', Array.isArray(val));
          if (Array.isArray(val)) {
            console.log('Length:', val.length);
            if (val.length > 0) {
              console.log('First item keys:', Object.keys(val[0]));
              console.log('First item tt:', val[0].tt);
            }
          } else if (typeof val === 'object' && val !== null) {
            console.log('Keys:', Object.keys(val));
            if (val.data !== undefined) {
              console.log('val.data is array?', Array.isArray(val.data), 'length:', val.data?.length);
            }
          }
        }
      }
    }

    if (typeof data === 'string') {
      console.log('⚠️ Got HTML/string instead of JSON');
      console.log(data.substring(0, 200));
    }

  } catch (e) {
    console.error('Error:', e.response?.status, e.response?.statusText);
    console.error('Response data:', e.response?.data?.substring?.(0, 200) || e.response?.data);
  }
}

debug();