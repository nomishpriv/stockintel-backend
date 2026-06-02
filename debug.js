async function diagnoseFilter() {
  const data = await fetchMarketData();
  const raw = data?.data?.eq;
  if (!raw) return;

  const all = Object.entries(raw);
  const stats = { total: all.length, dropped: 0, reasons: {} };

  for (const [sym, s] of all) {
    let reason = null;
    if (/R$|PREF|ETF|FUT|-/.test(sym)) reason = 'regex';
    else if (s.st !== 1) reason = `st=${s.st}`;
    else if (!s.c || +s.c <= 0) reason = `no_price(c=${s.c})`;
    
    if (reason) {
      stats.dropped++;
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    }
  }

  console.log('📊 Filter diagnosis:');
  console.log(`   Total from API: ${stats.total}`);
  console.log(`   Kept:           ${stats.total - stats.dropped}`);
  console.log(`   Dropped:        ${stats.dropped}`);
  console.log('   Reasons:', stats.reasons);
}

diagnoseFilter();