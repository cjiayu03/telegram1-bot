const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const app = express();
app.use(express.json());

// =========================
// CONFIG
// =========================

const token = process.env.TELEGRAM_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // IMPORTANT

const bot = new TelegramBot(token, { polling: true });

// =========================
// STORE REPORTS
// =========================

let reports = [];

// =========================
// HELPERS
// =========================

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

// =========================
// TELEGRAM → SYSTEM
// =========================

bot.on('message', async (msg) => {
  const text = msg.text || '';
  if (!text) return;
  if (msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  console.log(user, text);

  // ONLY /report
  if (!text.startsWith('/report')) return;

  const args = text.replace('/report', '').trim().split(' ');

  const validSeverities = ['low', 'medium', 'critical'];

  let severity = 'low';
  let startIndex = 0;

  if (validSeverities.includes(args[0]?.toLowerCase())) {
    severity = args[0].toLowerCase();
    startIndex = 1;
  }

  const reportText = args.slice(startIndex).join(' ') || '[empty]';

  const report = {
    id: Date.now(),
    user,
    severity,
    report: reportText,
    status: 'OPEN',
    source: 'telegram',
    time: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };

  reports.unshift(report);
  reports = reports.slice(0, 100);

  console.log('REPORT:', report);

  bot.sendMessage(
    chatId,
    `✅ Incident Created

ID: ${report.id}
Severity: ${severity.toUpperCase()}
Status: OPEN`
  );
});

// =========================
// DASHBOARD → TELEGRAM + STORE
// =========================

app.post('/api/report', (req, res) => {
  const { severity, message, user = 'dashboard' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  const report = {
    id: Date.now(),
    user,
    severity: severity || 'low',
    report: message,
    status: 'OPEN',
    source: 'dashboard',
    time: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };

  reports.unshift(report);
  reports = reports.slice(0, 100);

  // send to Telegram group
  bot.sendMessage(
    GROUP_CHAT_ID,
    `🚨 Dashboard Report

Severity: ${report.severity.toUpperCase()}
From: ${user}

${message}`
  );

  res.json({ success: true, report });
});

// =========================
// API → DASHBOARD DATA
// =========================

app.get('/api/reports', (req, res) => {
  res.json(reports);
});

// =========================
// DASHBOARD UI
// =========================

app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Incident Dashboard</title>

<style>
body { margin:0; background:#0f172a; font-family:Arial; color:white; }
.header { background:#111827; padding:20px; border-bottom:1px solid #1e293b; }
.title { font-size:28px; font-weight:bold; }
.subtitle { color:#94a3b8; margin-top:5px; }
.container { max-width:1100px; margin:auto; padding:20px; }

.stats {
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:15px;
  margin-bottom:25px;
}

.stat {
  background:#111827;
  padding:20px;
  border-radius:14px;
}

.stat-title { color:#94a3b8; font-size:14px; }
.stat-value { font-size:32px; margin-top:10px; }

.card {
  background:#111827;
  border:1px solid #1e293b;
  border-radius:14px;
  padding:18px;
  margin-bottom:16px;
}

.top { display:flex; justify-content:space-between; margin-bottom:10px; }

.user { color:#4ade80; font-weight:bold; }
.time { color:#94a3b8; font-size:12px; }

.report { line-height:1.6; margin-bottom:10px; }

.badge {
  display:inline-block;
  padding:5px 10px;
  border-radius:999px;
  font-size:12px;
  font-weight:bold;
}

.low { background:#14532d; color:#86efac; }
.medium { background:#78350f; color:#fcd34d; }
.critical { background:#7f1d1d; color:#fca5a5; }

.status { background:#1e3a8a; color:#bfdbfe; margin-left:8px; }

.input-box {
  margin-bottom:20px;
  display:flex;
  gap:10px;
}

input, select {
  padding:10px;
  border-radius:8px;
  border:none;
}

button {
  padding:10px 15px;
  border-radius:8px;
  border:none;
  background:#2563eb;
  color:white;
  cursor:pointer;
}

.empty { text-align:center; padding:50px; color:#94a3b8; }
</style>
</head>

<body>

<div class="header">
  <div class="title">🚨 Incident Dashboard</div>
  <div class="subtitle">Telegram + Dashboard 2-way system</div>
</div>

<div class="container">

  <div class="input-box">
    <input id="msg" placeholder="Type incident..." style="flex:1;" />
    <select id="severity">
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="critical">Critical</option>
    </select>
    <button onclick="sendReport()">Send</button>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-title">Total</div>
      <div class="stat-value" id="total">0</div>
    </div>

    <div class="stat">
      <div class="stat-title">Critical</div>
      <div class="stat-value" id="critical">0</div>
    </div>

    <div class="stat">
      <div class="stat-title">Open</div>
      <div class="stat-value" id="open">0</div>
    </div>
  </div>

  <div id="reports"></div>

</div>

<script>

async function loadReports() {
  const res = await fetch('/api/reports');
  const reports = await res.json();

  document.getElementById('total').innerText = reports.length;
  document.getElementById('critical').innerText =
    reports.filter(r => r.severity === 'critical').length;
  document.getElementById('open').innerText =
    reports.filter(r => r.status === 'OPEN').length;

  const container = document.getElementById('reports');

  if (reports.length === 0) {
    container.innerHTML = '<div class="empty">No incidents yet</div>';
    return;
  }

  container.innerHTML = reports.map(r => `
    <div class="card">

      <div class="top">
        <div class="user">@${r.user}</div>
        <div class="time">${r.time}</div>
      </div>

      <div class="report">${r.report}</div>

      <div>
        <span class="badge ${r.severity}">
          ${r.severity.toUpperCase()}
        </span>

        <span class="badge status">
          ${r.status}
        </span>
      </div>

    </div>
  `).join('');
}

async function sendReport() {
  const message = document.getElementById('msg').value;
  const severity = document.getElementById('severity').value;

  if (!message) return;

  await fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      severity,
      user: 'dashboard'
    })
  });

  document.getElementById('msg').value = '';
  loadReports();
}

loadReports();
setInterval(loadReports, 2000);

</script>

</body>
</html>
  `);
});

// =========================
// ROOT
// =========================

app.get('/', (req, res) => {
  res.send('Telegram Incident System Running');
});

// =========================
// START
// =========================

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
});
