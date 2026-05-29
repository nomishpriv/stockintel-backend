// services/alertLoggerService.js
const fs = require('fs').promises;
const path = require('path');

const ALERT_LOG = path.join(__dirname, '..', '.alerts.json');
const MAX_LOGS = 50;

async function loadLogs() {
  try {
    const raw = await fs.readFile(ALERT_LOG, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveLog(entry) {
  const logs = await loadLogs();
  logs.unshift({ ...entry, id: Date.now() });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  await fs.writeFile(ALERT_LOG, JSON.stringify(logs, null, 2));
}

async function logAlert(message, data) {
  await saveLog({
    time: new Date().toISOString(),
    timePKT: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }),
    message,
    symbols: data?.alerts?.map(a => a.symbol) || [],
    count: data?.alerts?.length || 0,
    marketContext: data?.marketContext || null
  });
}

async function getLogs(limit = 10) {
  const logs = await loadLogs();
  return logs.slice(0, limit);
}

async function getLatest() {
  const logs = await loadLogs();
  return logs[0] || null;
}

module.exports = { logAlert, getLogs, getLatest };