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
const VALID_STATUSES   = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

function severityEmoji(s) { return { low: '🟡', medium: '🟠', critical: '🔴' }[s] || '⚪'; }
function statusEmoji(s)   { return { OPEN: '🆕', IN_PROGRESS: '🔧', RESOLVED: '✅' }[s] || '❓'; }
function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function formatLocation(r) {
  if (!r.latDeg && !r.locationCode) return 'N/A';
  const latStr = r.latDeg ? `${r.latDeg}°${r.latMin || '00'}'${r.latDir || 'N'}` : '';
  const codeStr = r.locationCode ? `[Code: ${r.locationCode}]` : '';
  return `${latStr} ${codeStr}`.trim();
}

function incidentKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '💬 Comment',     callback_data: `comment:${id}` },
      { text: '🔧 In Progress', callback_data: `status:${id}:IN_PROGRESS` },
      { text: '✅ Resolve',     callback_data: `status:${id}:RESOLVED` }
    ]]
  };
}

const pendingReply = {};

// ───────────────── TELEGRAM BOT ─────────────────
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const user   = query.from.username || query.from.first_name;
  const data   = query.data || '';
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  if (data.startsWith('comment:')) {
    const incidentId = data.split(':')[1];
    const report = reports.find(r => String(r.id) === String(incidentId));
    if (!report) return bot.answerCallbackQuery(query.id, { text: '❌ Incident not found.' });

    pendingReply[userId] = { incidentId, originMsgId: msgId };

    const prompt = await bot.sendMessage(chatId,
      `💬 @${user}, type your comment for incident \`${incidentId}\`.\n_(Just send your next message)_`,
      { parse_mode: 'Markdown', reply_to_message_id: msgId });

    pendingReply[userId].promptMsgId = prompt.message_id;
    return bot.answerCallbackQuery(query.id, { text: 'Go ahead — type your comment!' });
  }

  if (data.startsWith('status:')) {
    const [, incidentId, newStatus] = data.split(':');
    const report = reports.find(r => String(r.id) === String(incidentId));
    if (!report) return bot.answerCallbackQuery(query.id, { text: '❌ Incident not found.' });

    if (report.status === newStatus)
      return bot.answerCallbackQuery(query.id, { text: `Already ${newStatus}.` });

    report.status = newStatus;
    report.updatedAt = now();

    try {
      await bot.editMessageText(
        (query.message.text || '').replace(/Status:.+/g, '') +
        `\nStatus: ${statusEmoji(newStatus)} ${newStatus}`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: incidentKeyboard(incidentId)
        }
      );
    } catch {}

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(
      GROUP_CHAT_ID,
      `${statusEmoji(newStatus)} Status Update\n\nIncident ${incidentId} → ${newStatus} by @${user}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  bot.answerCallbackQuery(query.id);
});

bot.on('message', async (msg) => {
  const text = msg.text || msg.caption || '';
  if (!text || msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user   = msg.from.username || msg.from.first_name;

  if (pendingReply[userId] && !text.startsWith('/')) {
    const { incidentId, promptMsgId, originMsgId } = pendingReply[userId];
    delete pendingReply[userId];

    const report = reports.find(r => String(r.id) === String(incidentId));
    if (!report) return;

    report.comments.push({ id: Date.now(), user, message: text, time: now() });

    bot.deleteMessage(chatId, promptMsgId).catch(() => {});
    bot.sendMessage(GROUP_CHAT_ID,
      `💬 Comment on "${report.title || incidentId}"\n\n@${user}: ${text}`,
      { reply_markup: incidentKeyboard(incidentId) });

    return;
  }

  if (!text.startsWith('/report')) return;

  const get = (re, fb = '') => {
    const m = text.match(re);
    return m && m[1] ? m[1].trim() : fb;
  };

  const report = {
    id: Date.now(),
    user,
    severity: get(/^Severity:\s*(.+)$/m, 'medium'),
    title: get(/^Title:\s*(.+)$/m, 'Untitled'),
    description: get(/^Description:\s*([\s\S]*)$/m, ''),
    status: 'OPEN',
    time: now(),
    updatedAt: now(),
    comments: [],
    incidentType: get(/^Type:\s*(.+)$/m, 'General'),
    nature: get(/^Nature:\s*(.+)$/m, 'Unspecified'),
    sector: get(/^Sector:\s*(.+)$/m, 'Unassigned'),
    latDeg: get(/^Lat Deg:\s*(\d*)$/m, ''),
    latMin: get(/^Lat Min:\s*(\d*)$/m, ''),
    latDir: get(/^Lat Dir:\s*([NSEW])$/m, 'N'),
    locationCode: get(/^Loc Code:\s*(.+)$/m, ''),
    reportedBy: get(/^Reported By:\s*(.+)$/m, user),
    attachment: ''
  };

  reports.unshift(report);
  bot.sendMessage(chatId, `Incident created: ${report.id}`);
});

// ───────────────── API ─────────────────
app.get('/api/reports', (req, res) => res.json(reports));

app.post('/api/report', (req, res) => {
  const r = req.body;

  const report = {
    id: Date.now(),
    user: r.user || 'dashboard',
    severity: r.severity || 'low',
    title: r.title,
    description: r.description || '',
    incidentType: r.incidentType || 'General',
    nature: r.nature || 'General',
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

// ───────────────── DASHBOARD ─────────────────
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
  fetch('/api/reports').then(r=>r.json()).then(d=>{
    data = d;

    document.getElementById('c1').innerText =
      d.filter(x=>x.severity==='critical').length;

    document.getElementById('c2').innerText =
      d.filter(x=>x.status==='OPEN').length;

    document.getElementById('c3').innerText =
      d.filter(x=>x.status==='IN_PROGRESS').length;

    document.getElementById('c4').innerText =
      d.filter(x=>x.status==='RESOLVED').length;

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
  const r = data.find(x=>x.id==id);

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
  console.log('Server running');
});
