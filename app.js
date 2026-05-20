const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const app = express();
app.use(express.json());

// =========================
// CONFIG
// =========================

const token = process.env.TELEGRAM_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

const bot = new TelegramBot(token, { polling: true });

// =========================
// DATA STORE
// =========================

let reports = [];

// =========================
// TELEGRAM → INCIDENTS
// =========================

bot.on('message', (msg) => {
  const text = msg.text || '';
  if (!text) return;
  if (msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  if (!text.startsWith('/report')) return;

  const args = text.replace('/report', '').trim().split(' ');

  const valid = ['low', 'medium', 'critical'];

  let severity = 'low';
  let start = 0;

  if (valid.includes(args[0]?.toLowerCase())) {
    severity = args[0].toLowerCase();
    start = 1;
  }

  const reportText = args.slice(start).join(' ') || '[empty]';

  const report = {
    id: Date.now(),
    user,
    severity,
    report: reportText,
    status: 'OPEN',
    source: 'telegram',
    time: new Date().toISOString().replace('T', ' ').slice(0, 19),
    comments: []
  };

  reports.unshift(report);

  bot.sendMessage(chatId, `✅ Incident Created\n\nID: ${report.id}\nSeverity: ${severity.toUpperCase()}`);
});

// =========================
// DASHBOARD → INCIDENTS
// =========================

app.post('/api/report', (req, res) => {
  const { severity, message, user = 'dashboard' } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const report = {
    id: Date.now(),
    user,
    severity: severity || 'low',
    report: message,
    status: 'OPEN',
    source: 'dashboard',
    time: new Date().toISOString().replace('T', ' ').slice(0, 19),
    comments: []
  };

  reports.unshift(report);

  bot.sendMessage(
    GROUP_CHAT_ID,
    `🚨 Dashboard Incident\n\nSeverity: ${report.severity.toUpperCase()}\nFrom: ${user}\n\n${message}`
  );

  res.json({ success: true, report });
});

// =========================
// ADD COMMENT TO INCIDENT
// =========================

app.post('/api/reports/:id/comment', (req, res) => {
  const { id } = req.params;
  const { message, user = 'dashboard' } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const report = reports.find(r => String(r.id) === String(id));

  if (!report) {
    return res.status(404).json({ error: 'Incident not found' });
  }

  const comment = {
    id: Date.now(),
    user,
    message,
    time: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };

  report.comments.push(comment);

  bot.sendMessage(
    GROUP_CHAT_ID,
    `💬 Comment on Incident ${id}\n\n@${user}: ${message}`
  );

  res.json({ success: true, comment });
});

// =========================
// GET INCIDENTS
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
.header { background:#111827; padding:20px; }
.title { font-size:26px; font-weight:bold; }

.container { padding:20px; max-width:1000px; margin:auto; }

.card {
  background:#111827;
  padding:16px;
  border-radius:12px;
  margin-bottom:12px;
}

.badge { padding:4px 10px; border-radius:999px; font-size:12px; }
.low { background:#14532d; }
.medium { background:#78350f; }
.critical { background:#7f1d1d; }

.comments {
  margin-top:10px;
  padding-left:10px;
  border-left:2px solid #334155;
}

input, select, button {
  padding:8px;
  margin-top:5px;
}

button {
  cursor:pointer;
  background:#2563eb;
  color:white;
  border:none;
  border-radius:6px;
}
</style>
</head>

<body>

<div class="header">
  <div class="title">🚨 Incident Dashboard</div>
</div>

<div class="container">

  <div id="reports"></div>

</div>

<script>

async function loadReports() {
  const res = await fetch('/api/reports');
  const reports = await res.json();

  const container = document.getElementById('reports');

container.innerHTML = reports.map(r =>
  '<div class="card">' +

    '<div class="top">' +
      '<div class="user">@' + r.user + '</div>' +
      '<div class="time">' + r.time + '</div>' +
    '</div>' +

    '<div class="report">' + r.report + '</div>' +

    '<div>' +
      '<span class="badge ' + r.severity + '">' +
        r.severity.toUpperCase() +
      '</span>' +

      '<span class="badge status">' +
        r.status +
      '</span>' +
    '</div>' +

  '</div>'
).join('');
}

async function addComment(id) {
  const input = document.getElementById('c-' + id);

  await fetch('/api/reports/' + id + '/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: input.value,
      user: 'dashboard'
    })
  });

  input.value = '';
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
  res.send('Incident System Running');
});

// =========================
// START SERVER
// =========================

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
});
