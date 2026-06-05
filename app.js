const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const token = process.env.TELEGRAM_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

if (!token) throw new Error('Missing TELEGRAM_TOKEN env var');
if (!GROUP_CHAT_ID) throw new Error('Missing GROUP_CHAT_ID env var');

const bot = new TelegramBot(token, { polling: true });
let reports = [];

const VALID_SEVERITIES = ['low', 'medium', 'critical'];
const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function incidentKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: 'Comment', callback_data: `comment:${id}` },
      { text: 'In Progress', callback_data: `status:${id}:IN_PROGRESS` },
      { text: 'Resolve', callback_data: `status:${id}:RESOLVED` }
    ]]
  };
}

const pendingReply = {};

// ───────── BOT ─────────
bot.on('message', async (msg) => {
  const text = msg.text || '';
  if (!text || msg.from.is_bot) return;

  const user = msg.from.username || msg.from.first_name;

  if (!text.startsWith('/report')) return;

  const get = (re, fb = '') => {
    const m = text.match(re);
    return m && m[1] ? m[1].trim() : fb;
  };

  const report = {
    id: Date.now(),
    user,
    title: get(/^Title:\s*(.+)$/m, 'Untitled'),
    severity: get(/^Severity:\s*(.+)$/m, 'medium'),
    incidentType: get(/^Type:\s*(.+)$/m, 'General'),
    nature: get(/^Nature:\s*(.+)$/m, 'Unspecified'),
    sector: get(/^Sector:\s*(.+)$/m, 'Unassigned'),
    reportedBy: get(/^Reported By:\s*(.+)$/m, user),
    status: 'OPEN',
    time: now(),
    updatedAt: now(),
    comments: []
  };

  reports.unshift(report);
  msg.chat.id && bot.sendMessage(msg.chat.id, `Created: ${report.id}`);
});

// ───────── API ─────────
app.get('/api/reports', (req, res) => res.json(reports));

app.post('/api/report', (req, res) => {
  const r = req.body;

  const report = {
    id: Date.now(),
    user: r.user || 'dashboard',
    title: r.title,
    severity: r.severity || 'low',
    incidentType: r.incidentType || 'General',
    nature: r.nature || '',
    sector: r.sector || '',
    reportedBy: r.reportedBy || 'dashboard',
    status: 'OPEN',
    time: now(),
    updatedAt: now(),
    comments: []
  };

  reports.unshift(report);
  res.json(report);
});

app.post('/api/reports/:id/status', (req, res) => {
  const r = reports.find(x => String(x.id) === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });

  r.status = req.body.status;
  r.updatedAt = now();

  res.json(r);
});

// ───────── DASHBOARD ─────────
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Incident Command</title>

<style>
body{margin:0;font-family:Arial;background:#0b0f14;color:#fff}
.header{padding:12px 20px;background:#111827}
.stats{display:flex;background:#0f172a}
.stat{padding:10px 20px;border-right:1px solid #1f2937}
.layout{display:flex;height:calc(100vh - 90px)}
.left{width:280px;border-right:1px solid #1f2937}
.card{padding:10px;border-bottom:1px solid #1f2937;cursor:pointer}
.card-title{font-weight:600}
.meta{font-size:12px;color:#9ca3af}
.detail{flex:1;padding:20px}
.label{font-size:11px;color:#9ca3af;margin-top:12px}
.box{background:#111827;padding:10px;border-radius:6px;margin-top:4px}
</style>

</head>

<body>

<div class="header">Incident Command</div>

<div class="stats">
  <div class="stat">Critical <span id="c1">0</span></div>
  <div class="stat">Open <span id="c2">0</span></div>
  <div class="stat">In Progress <span id="c3">0</span></div>
  <div class="stat">Resolved <span id="c4">0</span></div>
</div>

<div class="layout">
  <div class="left" id="list"></div>
  <div class="detail" id="detail"></div>
</div>

<script>
let data = [];

function load(){
  fetch('/api/reports')
    .then(r => r.json())
    .then(d => {
      data = d;

      document.getElementById('c1').innerText = d.filter(x=>x.severity==='critical').length;
      document.getElementById('c2').innerText = d.filter(x=>x.status==='OPEN').length;
      document.getElementById('c3').innerText = d.filter(x=>x.status==='IN_PROGRESS').length;
      document.getElementById('c4').innerText = d.filter(x=>x.status==='RESOLVED').length;

      document.getElementById('list').innerHTML =
        d.map(function(r){
          return '<div class="card" onclick="show(' + r.id + ')">' +
            '<div class="card-title">' + r.title + '</div>' +
            '<div class="meta">' + r.status + '</div>' +
          '</div>';
        }).join('');
    });
}

function show(id){
  const r = data.find(x => x.id == id);

  document.getElementById('detail').innerHTML =
    '<div class="label">Title</div><div class="box">' + r.title + '</div>' +
    '<div class="label">Type</div><div class="box">' + r.incidentType + '</div>' +
    '<div class="label">Nature</div><div class="box">' + r.nature + '</div>' +
    '<div class="label">Sector</div><div class="box">' + r.sector + '</div>' +
    '<div class="label">Status</div><div class="box">' + r.status + '</div>' +
    '<div class="label">Reported By</div><div class="box">' + r.reportedBy + '</div>';
}

load();
setInterval(load, 3000);
</script>

</body>
</html>
`;

app.get('/dashboard', (req, res) => res.send(DASHBOARD_HTML));

app.listen(process.env.PORT || 3000, () => {
  console.log('Running server');
});
