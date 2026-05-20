const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const app = express();
app.use(express.json());

// =========================
// CONFIG
// =========================

const token = process.env.TELEGRAM_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

if (!token) throw new Error('Missing TELEGRAM_TOKEN env var');
if (!GROUP_CHAT_ID) throw new Error('Missing GROUP_CHAT_ID env var');

const bot = new TelegramBot(token, { polling: true });

// =========================
// DATA STORE
// =========================

let reports = [];

// =========================
// HELPERS
// =========================

const VALID_SEVERITIES = ['low', 'medium', 'critical'];
const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

function severityEmoji(severity) {
  return { low: '🟡', medium: '🟠', critical: '🔴' }[severity] || '⚪';
}

function statusEmoji(status) {
  return { OPEN: '🆕', IN_PROGRESS: '🔧', RESOLVED: '✅' }[status] || '❓';
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// =========================
// TELEGRAM → INCIDENTS
// =========================

bot.on('message', (msg) => {
  const text = msg.text || '';
  if (!text || msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  // ── /report [severity] <message> ──────────────────────────
  if (text.startsWith('/report')) {
    const args = text.replace('/report', '').trim().split(' ');
    let severity = 'low';
    let start = 0;

    if (VALID_SEVERITIES.includes(args[0]?.toLowerCase())) {
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
      time: now(),
      comments: []
    };

    reports.unshift(report);

    // ACK the reporter
    bot.sendMessage(
      chatId,
      `✅ *Incident Created*\n\nID: \`${report.id}\`\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\n\nUse /status ${report.id} <OPEN|IN_PROGRESS|RESOLVED> to update it.`,
      { parse_mode: 'Markdown' }
    );

    // FIX: notify the group too
    bot.sendMessage(
      GROUP_CHAT_ID,
      `🚨 *New Incident*\n\nID: \`${report.id}\`\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\nFrom: @${user}\n\n${reportText}`,
      { parse_mode: 'Markdown' }
    );

    return;
  }

  // ── /status <id> <STATUS> ─────────────────────────────────
  if (text.startsWith('/status')) {
    const parts = text.trim().split(' ');
    const id = parts[1];
    const newStatus = parts[2]?.toUpperCase();

    if (!id || !newStatus) {
      return bot.sendMessage(chatId, '⚠️ Usage: /status <id> <OPEN|IN_PROGRESS|RESOLVED>');
    }

    if (!VALID_STATUSES.includes(newStatus)) {
      return bot.sendMessage(chatId, `⚠️ Invalid status. Choose: ${VALID_STATUSES.join(', ')}`);
    }

    const report = reports.find(r => String(r.id) === String(id));
    if (!report) {
      return bot.sendMessage(chatId, `❌ Incident \`${id}\` not found.`, { parse_mode: 'Markdown' });
    }

    const oldStatus = report.status;
    report.status = newStatus;

    bot.sendMessage(
      chatId,
      `${statusEmoji(newStatus)} Incident \`${id}\` updated: *${oldStatus}* → *${newStatus}*`,
      { parse_mode: 'Markdown' }
    );

    bot.sendMessage(
      GROUP_CHAT_ID,
      `${statusEmoji(newStatus)} *Status Update*\n\nIncident \`${id}\` by @${user}\n${oldStatus} → *${newStatus}*`,
      { parse_mode: 'Markdown' }
    );

    return;
  }

  // ── /comment <id> <message> ───────────────────────────────
  if (text.startsWith('/comment')) {
    const parts = text.trim().split(' ');
    const id = parts[1];
    const message = parts.slice(2).join(' ');

    if (!id || !message) {
      return bot.sendMessage(chatId, '⚠️ Usage: /comment <id> <your message>');
    }

    const report = reports.find(r => String(r.id) === String(id));
    if (!report) {
      return bot.sendMessage(chatId, `❌ Incident \`${id}\` not found.`, { parse_mode: 'Markdown' });
    }

    const comment = { id: Date.now(), user, message, time: now() };
    report.comments.push(comment);

    bot.sendMessage(chatId, `💬 Comment added to incident \`${id}\`.`, { parse_mode: 'Markdown' });

    bot.sendMessage(
      GROUP_CHAT_ID,
      `💬 *Comment on Incident \`${id}\`*\n\n@${user}: ${message}`,
      { parse_mode: 'Markdown' }
    );

    return;
  }

  // ── /list ─────────────────────────────────────────────────
  if (text.startsWith('/list')) {
    if (reports.length === 0) {
      return bot.sendMessage(chatId, '📭 No incidents yet.');
    }

    const lines = reports.slice(0, 10).map(r =>
      `${statusEmoji(r.status)} ${severityEmoji(r.severity)} \`${r.id}\` [${r.status}] @${r.user}: ${r.report.slice(0, 60)}`
    );

    bot.sendMessage(
      chatId,
      `📋 *Recent Incidents*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );

    return;
  }

  // ── /help ─────────────────────────────────────────────────
  if (text.startsWith('/help')) {
    bot.sendMessage(
      chatId,
      `🤖 *Incident Bot Commands*\n\n` +
      `/report [low|medium|critical] <message>\n  Create a new incident\n\n` +
      `/status <id> <OPEN|IN_PROGRESS|RESOLVED>\n  Update incident status\n\n` +
      `/comment <id> <message>\n  Add a comment to an incident\n\n` +
      `/list\n  Show the 10 most recent incidents\n\n` +
      `/help\n  Show this message`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Log polling errors instead of crashing
bot.on('polling_error', (err) => {
  console.error('[Telegram polling error]', err.message);
});

// =========================
// DASHBOARD → INCIDENTS
// =========================

app.post('/api/report', (req, res) => {
  const { severity = 'low', message, user = 'dashboard' } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!VALID_SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `Severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
  }

  const report = {
    id: Date.now(),
    user,
    severity,
    report: message,
    status: 'OPEN',
    source: 'dashboard',
    time: now(),
    comments: []
  };

  reports.unshift(report);

  bot.sendMessage(
    GROUP_CHAT_ID,
    `🚨 *Dashboard Incident*\n\nID: \`${report.id}\`\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\nFrom: ${user}\n\n${message}`,
    { parse_mode: 'Markdown' }
  );

  res.json({ success: true, report });
});

// =========================
// UPDATE STATUS
// =========================

app.post('/api/reports/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, user = 'dashboard' } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const report = reports.find(r => String(r.id) === String(id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const oldStatus = report.status;
  report.status = status;

  bot.sendMessage(
    GROUP_CHAT_ID,
    `${statusEmoji(status)} *Status Update*\n\nIncident \`${id}\` by ${user}\n${oldStatus} → *${status}*`,
    { parse_mode: 'Markdown' }
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
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const comment = { id: Date.now(), user, message, time: now() };
  report.comments.push(comment);

  bot.sendMessage(
    GROUP_CHAT_ID,
    `💬 *Comment on Incident \`${id}\`*\n\n@${user}: ${message}`,
    { parse_mode: 'Markdown' }
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
  res.send(`<!DOCTYPE html>
<html>
<head>
<title>Incident Dashboard</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #0f172a; font-family: Arial, sans-serif; color: #f1f5f9; }

.header {
  background: #111827;
  padding: 20px 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #1e293b;
}
.title { font-size: 22px; font-weight: bold; }

.container { padding: 24px 28px; max-width: 900px; margin: auto; }

.new-form {
  background: #111827;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 24px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: flex-end;
}
.new-form label { font-size: 13px; color: #94a3b8; display: block; margin-bottom: 4px; }
.new-form input, .new-form select {
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 14px;
}
.new-form input { flex: 1; min-width: 200px; }

.card {
  background: #111827;
  padding: 18px 20px;
  border-radius: 12px;
  margin-bottom: 14px;
  border: 1px solid #1e293b;
}
.card-top {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: 13px;
  color: #94a3b8;
}
.report-text { font-size: 15px; margin-bottom: 12px; }

.badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.badge {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
}
.low      { background: #14532d; color: #86efac; }
.medium   { background: #78350f; color: #fcd34d; }
.critical { background: #7f1d1d; color: #fca5a5; }
.status-OPEN        { background: #1e3a5f; color: #93c5fd; }
.status-IN_PROGRESS { background: #3d2a00; color: #fcd34d; }
.status-RESOLVED    { background: #14532d; color: #86efac; }

.source-tag {
  font-size: 11px;
  color: #64748b;
  background: #1e293b;
  padding: 2px 8px;
  border-radius: 6px;
}

.comments {
  margin-top: 10px;
  padding-left: 12px;
  border-left: 2px solid #334155;
}
.comment {
  margin-bottom: 8px;
  font-size: 13px;
}
.comment strong { color: #93c5fd; }
.comment small   { color: #64748b; margin-left: 6px; }

.comment-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.comment-row input {
  flex: 1;
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 13px;
}
.comment-row select {
  background: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 13px;
}

button {
  cursor: pointer;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  white-space: nowrap;
}
button:hover { background: #1d4ed8; }
button.danger { background: #dc2626; }
button.success { background: #16a34a; }

.empty { color: #64748b; text-align: center; padding: 40px 0; }
</style>
</head>
<body>

<div class="header">
  <div class="title">🚨 Incident Dashboard</div>
  <div style="font-size:13px;color:#64748b" id="last-updated"></div>
</div>

<div class="container">

  <!-- New incident form -->
  <div class="new-form">
    <div>
      <label>Severity</label>
      <select id="new-severity">
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="critical">Critical</option>
      </select>
    </div>
    <div style="flex:1">
      <label>Description</label>
      <input id="new-message" placeholder="Describe the incident..." onkeydown="if(event.key==='Enter') createReport()">
    </div>
    <button onclick="createReport()">+ Create Incident</button>
  </div>

  <div id="reports"></div>
</div>

<script>
async function loadReports() {
  const res = await fetch('/api/reports');
  const reports = await res.json();

  document.getElementById('last-updated').textContent =
    'Updated ' + new Date().toLocaleTimeString();

  const container = document.getElementById('reports');

  if (reports.length === 0) {
    container.innerHTML = '<div class="empty">No incidents yet. Create one above or use /report in Telegram.</div>';
    return;
  }

  container.innerHTML = reports.map(r => \`
    <div class="card" id="card-\${r.id}">
      <div class="card-top">
        <span>@\${r.user} &nbsp;·&nbsp; \${r.time}</span>
        <span class="source-tag">\${r.source}</span>
      </div>

      <div class="report-text">\${escHtml(r.report)}</div>

      <div class="badges">
        <span class="badge \${r.severity}">\${r.severity}</span>
        <span class="badge status-\${r.status}">\${r.status.replace('_', ' ')}</span>
      </div>

      <!-- Status actions -->
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        \${r.status !== 'IN_PROGRESS' ? \`<button onclick="setStatus('\${r.id}','IN_PROGRESS')">🔧 In Progress</button>\` : ''}
        \${r.status !== 'RESOLVED'    ? \`<button class="success" onclick="setStatus('\${r.id}','RESOLVED')">✅ Resolve</button>\` : ''}
        \${r.status !== 'OPEN'        ? \`<button class="danger"  onclick="setStatus('\${r.id}','OPEN')">🆕 Reopen</button>\` : ''}
      </div>

      <!-- Comments -->
      <div class="comments">
        \${r.comments.length === 0
          ? '<div style="color:#64748b;font-size:13px">No comments yet.</div>'
          : r.comments.map(c => \`
              <div class="comment">
                <strong>@\${c.user}</strong><small>\${c.time}</small>
                <div>\${escHtml(c.message)}</div>
              </div>
            \`).join('')
        }
      </div>

      <!-- Add comment -->
      <div class="comment-row">
        <input id="c-\${r.id}" placeholder="Add a comment..." onkeydown="if(event.key==='Enter') addComment('\${r.id}')">
        <button onclick="addComment('\${r.id}')">Send</button>
      </div>
    </div>
  \`).join('');
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function createReport() {
  const severity = document.getElementById('new-severity').value;
  const message  = document.getElementById('new-message').value.trim();
  if (!message) return alert('Please enter a description.');

  await fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ severity, message, user: 'dashboard' })
  });

  document.getElementById('new-message').value = '';
  loadReports();
}

async function setStatus(id, status) {
  await fetch('/api/reports/' + id + '/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, user: 'dashboard' })
  });
  loadReports();
}

async function addComment(id) {
  const input = document.getElementById('c-' + id);
  const message = input.value.trim();
  if (!message) return;

  await fetch('/api/reports/' + id + '/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, user: 'dashboard' })
  });

  input.value = '';
  loadReports();
}

loadReports();
setInterval(loadReports, 3000);
</script>

</body>
</html>`);
});

// =========================
// ROOT
// =========================

app.get('/', (req, res) => {
  res.send('Incident System Running — <a href="/dashboard">Open Dashboard</a>');
});

// =========================
// START SERVER
// =========================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
});
