const predictService = require('./services/predictService');

(async () => {
  const all = await predictService.getAllAccuracies();
  console.log('Count:', all.length);
  
  if (all.length === 0) {
    const data = require('./.predictions.json');
    for (const [sym, preds] of Object.entries(data)) {
      const completed = preds.filter(p => p.checked);
      console.log(sym, 'total:', preds.length, 'checked:', completed.length);
    }
  } else {
    console.log(JSON.stringify(all, null, 2));
  }
})();