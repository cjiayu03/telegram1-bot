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
const VALID_STATUSES   = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];
const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function severityEmoji(s) {
  return { low: '🟡', medium: '🟠', critical: '🔴' }[s] || '⚪';
}
function statusEmoji(s) {
  return { OPEN: '🆕', IN_PROGRESS: '🔧', RESOLVED: '✅' }[s] || '❓';
}
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

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
      { text: '✅ Resolve',    callback_data: `status:${id}:RESOLVED` }
    ]]
  };
}

// =========================
// TELEGRAM → INCIDENTS
// =========================

const pendingReply = {};

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
    const prompt = await bot.sendMessage(
      chatId,
      `💬 @${user}, type your comment for incident \`${incidentId}\` and I'll add it.\n_(Just send your next message here)_`,
      { parse_mode: 'Markdown', reply_to_message_id: msgId }
    );
    pendingReply[userId].promptMsgId = prompt.message_id;
    bot.answerCallbackQuery(query.id, { text: 'Go ahead — type your comment!' });
    return;
  }

  if (data.startsWith('status:')) {
    const [, incidentId, newStatus] = data.split(':');
    const report = reports.find(r => String(r.id) === String(incidentId));
    if (!report) return bot.answerCallbackQuery(query.id, { text: '❌ Incident not found.' });

    const oldStatus = report.status;
    if (oldStatus === newStatus) return bot.answerCallbackQuery(query.id, { text: `Already ${newStatus}.` });

    report.status    = newStatus;
    report.updatedAt = now();

    try {
      const originalText = query.message.text || '';
      const updatedText  = originalText.replace(/Status:.+/g, '') +
        `\nStatus: ${statusEmoji(newStatus)} *${newStatus}*\nUpdated by @${user}`;
      await bot.editMessageText(updatedText, {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown', reply_markup: incidentKeyboard(incidentId)
      });
    } catch (_) {}

    bot.answerCallbackQuery(query.id, { text: `${statusEmoji(newStatus)} Marked ${newStatus}` });
    bot.sendMessage(GROUP_CHAT_ID,
      `${statusEmoji(newStatus)} *Status Update*\n\nIncident \`${incidentId}\` → *${newStatus}* by @${user}`,
      { parse_mode: 'Markdown' });
    return;
  }

  bot.answerCallbackQuery(query.id);
});

bot.on('message', (msg) => {
  const text = msg.text || '';
  if (!text || msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user   = msg.from.username || msg.from.first_name;

  if (pendingReply[userId] && !text.startsWith('/')) {
    const { incidentId, promptMsgId, originMsgId } = pendingReply[userId];
    delete pendingReply[userId];

    const report = reports.find(r => String(r.id) === String(incidentId));
    if (!report) return bot.sendMessage(chatId, `❌ Incident \`${incidentId}\` not found.`, { parse_mode: 'Markdown' });

    const comment = { id: Date.now(), user, message: text, time: now() };
    report.comments.push(comment);
    bot.deleteMessage(chatId, promptMsgId).catch(() => {});

    bot.sendMessage(GROUP_CHAT_ID,
      `💬 *Comment on "${report.title || incidentId}"*\n\n@${user}: ${text}`,
      { parse_mode: 'Markdown', reply_to_message_id: originMsgId, reply_markup: incidentKeyboard(incidentId) });
    return;
  }

  if (text.startsWith('/template')) {
    const exampleTemplate =
      `📝 *Copy the template below, paste it, fill it out, and send it back:*\n\n` +
      `\`\`\`\n` +
      `/report\n` +
      `Title: \n` +
      `Type: General\n` +
      `Severity: medium\n` +
      `Sector: \n` +
      `Lat Deg: \n` +
      `Lat Min: \n` +
      `Lat Dir: N\n` +
      `Loc Code: \n` +
      `Description: \n` +
      `\`\`\``;
    return bot.sendMessage(chatId, exampleTemplate, { parse_mode: 'Markdown' });
  }

  if (text.startsWith('/report')) {
    if (text.trim() === '/report') {
      return bot.sendMessage(chatId, "⚠️ Please specify details or match the format layout. Type `/template` to get a structured fillable pattern.", { parse_mode: 'Markdown' });
    }

    const getField = (regex, fallback = '') => {
      const match = text.match(regex);
      return match && match[1] ? match[1].trim() : fallback;
    };

    const titleText    = getField(/^Title:\s*(.+)$/m, 'Untitled Telegram Report');
    const incidentType = getField(/^Type:\s*(.+)$/m, 'General');
    const severityRaw  = getField(/^Severity:\s*(.+)$/m, 'medium').toLowerCase();
    const sector       = getField(/^Sector:\s*(.+)$/m, 'Unassigned');
    const latDeg       = getField(/^Lat Deg:\s*(\d*)$/m, '');
    const latMin       = getField(/^Lat Min:\s*(\d*)$/m, '');
    const latDir       = getField(/^Lat Dir:\s*([NSEWnsew])$/m, 'N').toUpperCase();
    const locationCode = getField(/^Loc Code:\s*(.+)$/m, '');
    const description  = getField(/^Description:\s*([\s\S]*)$/m, `Reported via Telegram Template by @${user}.`);

    const severity = VALID_SEVERITIES.includes(severityRaw) ? severityRaw : 'medium';

    const report = {
      id: Date.now(),
      user: `@${user}`,
      severity,
      report: titleText,
      title: titleText.slice(0, 60),
      description,
      assignee: '',
      tags: ['telegram', 'template'],
      priority: severity === 'critical' ? 'high' : 'normal',
      status: 'OPEN',
      source: 'telegram',
      time: now(),
      updatedAt: now(),
      comments: [],
      incidentType,
      sector,
      latDeg, latMin, latDir, locationCode
    };

    reports.unshift(report);

    const locStr = formatLocation(report) !== 'N/A' ? `\n📍 *Location*: ${formatLocation(report)}` : '';

    bot.sendMessage(chatId,
      `✅ *Incident Synchronized from Template*\n\n` +
      `*ID*: \`${report.id}\`\n*Type*: ${incidentType}\n*Sector*: ${sector}\n` +
      `*Severity*: ${severityEmoji(severity)} ${severity.toUpperCase()}${locStr}\n\nIncident is live on the CommandCenter dashboard.`,
      { parse_mode: 'Markdown' });

    bot.sendMessage(GROUP_CHAT_ID,
      `🚨 *New Incident* [${report.incidentType.toUpperCase()}]\n\n` +
      `*Title*: ${report.title}\n*ID*: \`${report.id}\`\n` +
      `*Severity*: ${severityEmoji(severity)} ${severity.toUpperCase()}\n` +
      `*Sector*: ${sector}${locStr}\n*Reporter*: @${user}\n*Status*: 🆕 OPEN`,
      { parse_mode: 'Markdown', reply_markup: incidentKeyboard(report.id) });
    return;
  }

  if (!text.startsWith('/') && String(chatId) === String(GROUP_CHAT_ID)) {
    const report = {
      id: Date.now(), user, severity: 'low', report: text,
      title: text.slice(0, 60), description: '', assignee: '',
      tags: [], priority: 'normal', status: 'OPEN',
      source: 'telegram', time: now(), updatedAt: now(), comments: [],
      incidentType: 'Unspecified', sector: 'Unassigned',
      latDeg: '', latMin: '', latDir: 'N', locationCode: ''
    };
    reports.unshift(report);
    bot.sendMessage(chatId,
      `✅ *Incident Created from group message*\n\nID: \`${report.id}\`\nSeverity: 🟡 LOW\nFrom: @${user}\n\nUse /status ${report.id} IN_PROGRESS or /status ${report.id} RESOLVED to update.`,
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id, reply_markup: incidentKeyboard(report.id) });
    return;
  }
});

bot.on('polling_error', (err) => console.error('[Telegram polling error]', err.message));

// =========================
// DASHBOARD → INCIDENTS
// =========================

app.post('/api/report', (req, res) => {
  const {
    severity = 'low', message, user = 'dashboard',
    title = '', description = '', assignee = '',
    tags = [], priority = 'normal',
    incidentType = 'General', sector = '',
    latDeg = '', latMin = '', latDir = 'N',
    lonDeg = '', lonMin = '', lonDir = 'E',
    locationCode = '', gridRef = ''
  } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!VALID_SEVERITIES.includes(severity)) return res.status(400).json({ error: `Severity must be one of: ${VALID_SEVERITIES.join(', ')}` });

  const report = {
    id: Date.now(), user, severity, report: message,
    title: title || message.slice(0, 60),
    description, assignee,
    tags: Array.isArray(tags) ? tags : [],
    priority, status: 'OPEN', source: 'dashboard',
    time: now(), updatedAt: now(), comments: [],
    incidentType, sector: sector || 'Unassigned',
    latDeg, latMin, latDir,
    lonDeg, lonMin, lonDir,
    locationCode, gridRef
  };

  reports.unshift(report);

  const tagStr    = report.tags.length ? `\nTags: ${report.tags.join(', ')}` : '';
  const assignStr = assignee ? `\nAssignee: ${assignee}` : '';
  const sectorStr = report.sector ? `\nSector: ${report.sector}` : '';
  const locStr    = formatLocation(report) !== 'N/A' ? `\nLocation: ${formatLocation(report)}` : '';

  bot.sendMessage(GROUP_CHAT_ID,
    `🚨 *Dashboard Incident* [${report.incidentType.toUpperCase()}]\n\nID: \`${report.id}\`\nTitle: ${report.title}\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\nPriority: ${priority.toUpperCase()}\nFrom: ${user}${assignStr}${sectorStr}${locStr}${tagStr}\nStatus: 🆕 OPEN\n\n${message}`,
    { parse_mode: 'Markdown', reply_markup: incidentKeyboard(report.id) });

  res.json({ success: true, report });
});

app.patch('/api/reports/:id', (req, res) => {
  const { id } = req.params;
  const report = reports.find(r => String(r.id) === String(id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const allowed = ['title','description','assignee','tags','priority','severity','incidentType','sector','latDeg','latMin','latDir','lonDeg','lonMin','lonDir','locationCode','gridRef'];
  allowed.forEach(k => { if (req.body[k] !== undefined) report[k] = req.body[k]; });
  report.updatedAt = now();
  res.json({ success: true, report });
});

app.post('/api/reports/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, user = 'dashboard' } = req.body;

  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
  const report = reports.find(r => String(r.id) === String(id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const oldStatus = report.status;
  report.status    = status;
  report.updatedAt = now();

  bot.sendMessage(GROUP_CHAT_ID,
    `${statusEmoji(status)} *Status Update*\n\nIncident \`${id}\` by ${user}\n${oldStatus} → *${status}*`,
    { parse_mode: 'Markdown' });

  res.json({ success: true, report });
});

app.post('/api/reports/:id/comment', (req, res) => {
  const { id } = req.params;
  const { message, user = 'dashboard' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const report = reports.find(r => String(r.id) === String(id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const comment = { id: Date.now(), user, message, time: now() };
  report.comments.push(comment);
  report.updatedAt = now();

  bot.sendMessage(GROUP_CHAT_ID,
    `💬 *Comment on "${report.title || id}"*\n\n@${user}: ${message}`,
    { parse_mode: 'Markdown', reply_markup: incidentKeyboard(id) });

  res.json({ success: true, comment });
});

app.get('/api/reports', (req, res) => res.json(reports));

// =========================
// DASHBOARD UI
// =========================

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Incident Command Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&family=Source+Sans+3:wght@300;400;600&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<style>
:root {
  --bg:        #0e1015;
  --surface:  #161a22;
  --surface2: #1c2130;
  --surface3: #222736;
  --border:   #2a3145;
  --border2:  #333d52;
  --text:     #cdd6e8;
  --text-dim: #7d8fa8;
  --text-bright: #e8eef8;
  --accent:   #4a7fd4;
  --accent2:  #2d5fab;
  --accent-glow: rgba(74,127,212,0.18);

  --sev-low:      #1a3a2a;
  --sev-low-t:    #5bc98a;
  --sev-med:      #3a2a0a;
  --sev-med-t:    #e8a832;
  --sev-crit:     #3a0f0f;
  --sev-crit-t:   #e85c5c;

  --st-open:      #0f2744;
  --st-open-t:    #5ba0f0;
  --st-prog:      #2d2000;
  --st-prog-t:    #f0b84a;
  --st-res:       #0d3020;
  --st-res-t:     #4cc98a;

  --font-ui:   'Source Sans 3', sans-serif;
  --font-mono: 'Share Tech Mono', monospace;
  --font-head: 'Rajdhani', sans-serif;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  font-family: var(--font-ui);
  color: var(--text);
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.5;
}

/* ── TOPBAR ── */
.topbar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 100;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}
.system-logo {
  font-family: var(--font-head);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-bright);
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo-pulse {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #e85c5c;
  box-shadow: 0 0 0 0 rgba(232,92,92,.5);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(232,92,92,.5); }
  50%      { box-shadow: 0 0 0 7px rgba(232,92,92,0); }
}
.system-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: .1em;
  color: var(--text-dim);
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 3px;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.live-clock {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-dim);
  letter-spacing: .06em;
}
.live-clock span { color: var(--accent); }
.btn-new {
  font-family: var(--font-head);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 7px 18px;
  border-radius: 4px;
  cursor: pointer;
  transition: background .15s;
}
.btn-new:hover { background: var(--accent2); }

/* ── STATS ROW ── */
.stats-row {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  overflow-x: auto;
}
.stat-cell {
  padding: 10px 24px;
  border-right: 1px solid var(--border);
  min-width: 120px;
  cursor: pointer;
  transition: background .12s;
}
.stat-cell:hover, .stat-cell.active { background: var(--surface2); }
.stat-cell:last-child { border-right: none; }
.stat-val {
  font-family: var(--font-head);
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  margin-bottom: 2px;
}
.stat-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.stat-cell.s-crit .stat-val { color: var(--sev-crit-t); }
.stat-cell.s-open .stat-val { color: var(--st-open-t); }
.stat-cell.s-prog .stat-val { color: var(--st-prog-t); }
.stat-cell.s-res  .stat-val { color: var(--st-res-t); }
.stat-cell.s-all  .stat-val { color: var(--text-bright); }

/* ── LAYOUT ── */
.layout {
  display: flex;
  height: calc(100vh - 104px);
}

/* ── LEFT PANEL ── */
.left-panel {
  width: 340px;
  min-width: 260px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
}
.panel-search {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.search-wrap {
  position: relative;
}
.search-icon {
  position: absolute;
  left: 10px; top: 50%;
  transform: translateY(-50%);
  color: var(--text-dim);
  font-size: 13px;
  pointer-events: none;
}
.search-input {
  width: 100%;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 7px 10px 7px 30px;
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 13px;
  outline: none;
  transition: border-color .15s;
}
.search-input:focus { border-color: var(--accent); }
.search-input::placeholder { color: var(--text-dim); }

.filter-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  flex-shrink: 0;
}
.ftab {
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .05em;
  text-transform: uppercase;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--border2);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: all .12s;
}
.ftab:hover { border-color: var(--accent); color: var(--accent); }
.ftab.active { background: var(--accent); border-color: var(--accent); color: #fff; }

.record-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  letter-spacing: .06em;
}

.inc-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.inc-list::-webkit-scrollbar { width: 3px; }
.inc-list::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

.inc-row {
  padding: 10px 10px 10px 16px;
  border-radius: 4px;
  border: 1px solid transparent;
  margin-bottom: 2px;
  cursor: pointer;
  position: relative;
  transition: all .1s;
}
.inc-row:hover { background: var(--surface2); border-color: var(--border); }
.inc-row.active { background: var(--surface2); border-color: var(--accent); }
.sev-stripe {
  position: absolute;
  left: 5px; top: 8px; bottom: 8px;
  width: 3px;
  border-radius: 2px;
}
.sev-stripe.low      { background: var(--sev-low-t); }
.sev-stripe.medium   { background: var(--sev-med-t); }
.sev-stripe.critical { background: var(--sev-crit-t); }

.inc-row-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 5px;
}
.inc-row-type {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 5px;
}
.inc-row-meta {
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: .04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.sev-low      { background: var(--sev-low);  color: var(--sev-low-t); }
.sev-medium   { background: var(--sev-med);  color: var(--sev-med-t); }
.sev-critical { background: var(--sev-crit); color: var(--sev-crit-t); }
.st-OPEN        { background: var(--st-open); color: var(--st-open-t); }
.st-IN_PROGRESS { background: var(--st-prog); color: var(--st-prog-t); }
.st-RESOLVED    { background: var(--st-res);  color: var(--st-res-t); }
.src-badge { background: var(--surface3); border: 1px solid var(--border2); color: var(--text-dim); }

.inc-time {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-dim);
  margin-left: auto;
}

/* ── DETAIL PANEL ── */
.detail-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

/* Detail header */
.detail-topbar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.detail-topbar-title {
  font-family: var(--font-head);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--text-bright);
}
.detail-topbar-id {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 2px 10px;
  border-radius: 3px;
}

/* Detail body */
.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}
.detail-body::-webkit-scrollbar { width: 4px; }
.detail-body::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

/* Field card */
.field-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 18px 20px;
  margin-bottom: 14px;
}
.field-card-title {
  font-family: var(--font-head);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-card-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* Field rows */
.frow {
  display: grid;
  gap: 14px;
  margin-bottom: 14px;
}
.frow:last-child { margin-bottom: 0; }
.frow-2 { grid-template-columns: 1fr 1fr; }
.frow-3 { grid-template-columns: 1fr 1fr 1fr; }

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.field-label .req { color: var(--sev-crit-t); margin-left: 2px; }

/* Read-only field display */
.field-val {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-bright);
  min-height: 36px;
  display: flex;
  align-items: center;
  word-break: break-word;
}
.field-val.mono { font-family: var(--font-mono); }
.field-val.empty { color: var(--text-dim); font-style: italic; }

/* Badges row */
.status-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 14px;
}

/* Actions */
.action-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.btn {
  font-family: var(--font-head);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
  padding: 7px 16px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: all .12s;
  white-space: nowrap;
}
.btn-open   { background: var(--st-open); color: var(--st-open-t); border-color: #1c3d6a; }
.btn-open:hover { background: #1c3d6a; }
.btn-prog   { background: var(--st-prog); color: var(--st-prog-t); border-color: #5a3f00; }
.btn-prog:hover { background: #5a3f00; }
.btn-res    { background: var(--st-res); color: var(--st-res-t); border-color: #1a5c38; }
.btn-res:hover { background: #1a5c38; }
.btn-ghost  { background: var(--surface2); color: var(--text); border-color: var(--border2); }
.btn-ghost:hover { border-color: var(--accent); color: var(--accent); }

/* Description block */
.desc-val {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-bright);
  white-space: pre-wrap;
  line-height: 1.6;
  min-height: 60px;
}
.desc-val.empty { color: var(--text-dim); font-style: italic; }

/* Comments section */
.comment-thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.comment-row {
  display: flex;
  gap: 10px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
}
.c-avatar {
  width: 28px; height: 28px;
  border-radius: 50%;
  background: var(--accent2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
  color: #fff;
}
.c-body { flex: 1; }
.c-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 3px;
}
.c-user { font-size: 12px; font-weight: 700; color: var(--accent); }
.c-time { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.c-text { font-size: 13px; color: var(--text); line-height: 1.5; }

.comment-input-bar {
  display: flex;
  gap: 8px;
  padding: 10px 24px;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}
.comment-textarea {
  flex: 1;
  background: var(--surface2);
  border: 1px solid var(--border2);
  border-radius: 4px;
  padding: 8px 12px;
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 13px;
  outline: none;
  resize: none;
  height: 38px;
  transition: border-color .15s, height .15s;
}
.comment-textarea:focus { border-color: var(--accent); height: 70px; }
.btn-send {
  font-family: var(--font-head);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 8px 18px;
  border-radius: 4px;
  cursor: pointer;
  transition: background .15s;
  align-self: flex-end;
}
.btn-send:hover { background: var(--accent2); }

/* Tags */
.tags-wrap { display: flex; gap: 6px; flex-wrap: wrap; }
.tag-chip {
  padding: 2px 10px;
  border-radius: 3px;
  background: var(--surface3);
  border: 1px solid var(--border2);
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

/* Empty state */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-dim);
}
.empty-icon {
  font-size: 48px;
  opacity: .25;
}
.empty-label { font-family: var(--font-head); font-size: 14px; letter-spacing: .08em; text-transform: uppercase; }

/* ── CREATE MODAL ── */
#modal-overlay {
  display: none;
}
#modal-overlay.open {
  display: flex;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.82);
  align-items: flex-start;
  justify-content: center;
  z-index: 9999;
  padding: 30px 20px;
  overflow-y: auto;
}

.modal-box {
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 8px;
  width: 100%;
  max-width: 720px;
  padding: 0;
  display: flex;
  flex-direction: column;
  margin: auto;
}

/* Modal header */
.modal-header {
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: 8px 8px 0 0;
}
.modal-title {
  font-family: var(--font-head);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--text-bright);
}
.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  cursor: pointer;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color .1s;
}
.modal-close:hover { color: var(--text-bright); }

.modal-body {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Modal field groups */
.modal-section-title {
  font-family: var(--font-head);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-section-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.m-field { display: flex; flex-direction: column; gap: 4px; }
.m-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.m-label .req { color: var(--sev-crit-t); }
.m-input, .m-select, .m-textarea {
  background: var(--surface2);
  border: 1px solid var(--border2);
  border-radius: 4px;
  padding: 8px 12px;
  color: var(--text-bright);
  font-family: var(--font-ui);
  font-size: 13px;
  outline: none;
  transition: border-color .15s;
  width: 100%;
}
.m-input:focus, .m-select:focus, .m-textarea:focus { border-color: var(--accent); }
.m-input::placeholder { color: var(--text-dim); }
.m-select { 
  appearance: none; 
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237d8fa8'/%3E%3C/svg%3E"); 
  background-repeat: no-repeat; 
  background-position: right 10px center; 
  padding-right: 28px; 
  cursor: pointer; 
}
.m-textarea { resize: vertical; min-height: 80px; }
.m-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.m-row-4 { display: grid; grid-template-columns: 1.2fr 1.2fr 0.7fr 2fr; gap: 10px; }
.m-row-5 { display: grid; grid-template-columns: 1fr 1fr 0.7fr 1.4fr 1fr; gap: 10px; }

.modal-footer {
  padding: 14px 24px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-radius: 0 0 8px 8px;
  background: var(--surface2);
}
.btn-cancel {
  font-family: var(--font-head);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border2);
  padding: 8px 20px;
  border-radius: 4px;
  cursor: pointer;
  transition: all .12s;
}
.btn-cancel:hover { border-color: var(--text-dim); color: var(--text); }
.btn-create {
  font-family: var(--font-head);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .07em;
  text-transform: uppercase;
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 8px 24px;
  border-radius: 4px;
  cursor: pointer;
  transition: background .12s;
}
.btn-create:hover { background: var(--accent2); }

hr.divider { border: none; border-top: 1px solid var(--border); margin: 4px 0; }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <div class="system-logo">
      <div class="logo-pulse"></div>
      Incident Command
    </div>
    <span class="system-tag">MSCC</span>
  </div>
  <div class="topbar-right">
    <div class="live-clock" id="live-clock">—</div>
    <button class="btn-new" id="new-btn">+ Create Report</button>
  </div>
</div>

<div class="stats-row">
  <div class="stat-cell s-crit" id="stat-crit">
    <div class="stat-val" id="cnt-critical">0</div>
    <div class="stat-label">Critical</div>
  </div>
  <div class="stat-cell s-open" id="stat-open">
    <div class="stat-val" id="cnt-open">0</div>
    <div class="stat-label">Open</div>
  </div>
  <div class="stat-cell s-prog" id="stat-prog">
    <div class="stat-val" id="cnt-prog">0</div>
    <div class="stat-label">In Progress</div>
  </div>
  <div class="stat-cell s-res" id="stat-res">
    <div class="stat-val" id="cnt-res">0</div>
    <div class="stat-label">Resolved</div>
  </div>
  <div class="stat-cell s-all" id="stat-all">
    <div class="stat-val" id="cnt-all">0</div>
    <div class="stat-label">Total</div>
  </div>
  <div class="stat-cell" style="margin-left:auto;border-left:1px solid var(--border);border-right:none;min-width:auto;cursor:default;">
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:.06em;" id="sync-label">SYNCING...</div>
    <div class="stat-label">Last Sync</div>
  </div>
</div>

<div class="layout">

  <div class="left-panel">
    <div class="panel-search">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input class="search-input" id="search-input" placeholder="Search reports...">
      </div>
    </div>
    <div class="filter-tabs">
      <button class="ftab active" data-f="">All</button>
      <button class="ftab" data-f="OPEN">Open</button>
      <button class="ftab" data-f="IN_PROGRESS">In Progress</button>
      <button class="ftab" data-f="RESOLVED">Resolved</button>
      <button class="ftab" data-f="critical">Critical</button>
      <button class="ftab" data-f="medium">Medium</button>
      <button class="ftab" data-f="low">Low</button>
    </div>
    <div class="record-count" id="record-count">0 records</div>
    <div class="inc-list" id="inc-list"></div>
  </div>

  <div class="detail-panel" id="detail-panel">
    <div class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-label">Select a report to view</div>
      <div style="font-size:12px;margin-top:4px;">or create one with + Create Report</div>
    </div>
  </div>

</div>

<div id="modal-overlay">
  <div class="modal-box">
    <div class="modal-header">
      <div class="modal-title">Create Report</div>
      <button class="modal-close" id="modal-close">✕</button>
    </div>
    <div class="modal-body">

      <div class="m-row-2">
        <div class="m-field">
          <label class="m-label">Report Title (Auto Generated) <span class="req">*</span></label>
          <input class="m-input" id="f-title" placeholder="e.g. EM SHONA, OPERATIONAL BUNKER SPILL...">
        </div>
        <div class="m-field">
          <label class="m-label">Report Type</label>
          <input class="m-input" id="f-type" placeholder="INCIDENT REPORT">
        </div>
      </div>

      <div class="m-row-2">
        <div class="m-field">
          <label class="m-label">Report Date &amp; Time</label>
          <input class="m-input" id="f-datetime" type="datetime-local">
        </div>
        <div class="m-field">
          <label class="m-label">Nature of Incident <span class="req">*</span></label>
          <input class="m-input" id="f-nature" placeholder="e.g. OPERATIONAL BUNKER SPILL">
        </div>
      </div>

      <div class="m-row-2">
        <div class="m-field">
          <label class="m-label">Reported By</label>
          <input class="m-input" id="f-reporter" placeholder="Full name or handle">
        </div>
        <div class="m-field">
          <label class="m-label">Severity</label>
          <select class="m-select" id="f-severity">
            <option value="low">L1 — Low</option>
            <option value="medium" selected>L2 — Medium</option>
            <option value="critical">L3 — Critical</option>
          </select>
        </div>
      </div>

      <hr class="divider">
      <div class="modal-section-title">📍 Location</div>

      <div class="m-row-4">
        <div class="m-field">
          <label class="m-label">Lat Deg °</label>
          <input class="m-input" id="f-latdeg" type="number" placeholder="e.g. 1">
        </div>
        <div class="m-field">
          <label class="m-label">Lat Min '</label>
          <input class="m-input" id="f-latmin" type="number" placeholder="e.g. 19.067">
        </div>
        <div class="m-field">
          <label class="m-label">Lat Dir</label>
          <select class="m-select" id="f-latdir">
            <option value="N">N</option>
            <option value="S">S</option>
          </select>
        </div>
        <div class="m-field">
          <label class="m-label">Location Code <span class="req">*</span></label>
          <input class="m-input" id="f-loccode" placeholder="e.g. CHANGI GENERAL PURPOSE ANCHORAGE">
        </div>
      </div>

      <div class="m-row-5">
        <div class="m-field">
          <label class="m-label">Lon Deg °</label>
          <input class="m-input" id="f-londeg" type="number" placeholder="e.g. 104">
        </div>
        <div class="m-field">
          <label class="m-label">Lon Min '</label>
          <input class="m-input" id="f-lonmin" type="number" placeholder="e.g. 3.883">
        </div>
        <div class="m-field">
          <label class="m-label">Lon Dir</label>
          <select class="m-select" id="f-londir">
            <option value="E" selected>E</option>
            <option value="W">W</option>
          </select>
        </div>
        <div class="m-field">
          <label class="m-label">Sector</label>
          <select class="m-select" id="f-sector">
            <option value="">— Select —</option>
            <option value="EASTERN">EASTERN</option>
            <option value="WESTERN">WESTERN</option>
            <option value="NORTHERN">NORTHERN</option>
            <option value="SOUTHERN">SOUTHERN</option>
            <option value="CENTRAL">CENTRAL</option>
          </select>
        </div>
        <div class="m-field">
          <label class="m-label">Grid Ref</label>
          <input class="m-input" id="f-gridref" placeholder="e.g. 0319B">
        </div>
      </div>

      <hr class="divider">

      <div class="m-field">
        <label class="m-label">Details of Incident <span class="req">*</span></label>
        <textarea class="m-textarea" id="f-description" style="min-height:100px;" placeholder="Weather Information..."></textarea>
      </div>

      <div class="m-row-2">
        <div class="m-field">
          <label class="m-label">Short Report Summary <span class="req">*</span></label>
          <input class="m-input" id="f-message" placeholder="One-line summary (sent to Telegram)">
        </div>
        <div class="m-field">
          <label class="m-label">Tags (comma-separated)</label>
          <input class="m-input" id="f-tags" placeholder="e.g. bunker, spill">
        </div>
      </div>

      <div class="m-row-2">
        <div class="m-field">
          <label class="m-label">Assignee</label>
          <input class="m-input" id="f-assignee" placeholder="@username or officer name">
        </div>
        <div class="m-field">
          <label class="m-label">Priority</label>
          <select class="m-select" id="f-priority">
            <option value="low">Low</option>
            <option value="normal" selected>Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
      </div>

    </div>
    <div class="modal-footer">
      <button class="btn-cancel" id="cancel-btn">Cancel</button>
      <button class="btn-create" id="submit-btn">Create Report</button>
    </div>
  </div>
</div>

<script>
document.addEventListener('DOMContentLoaded', function() {
  var allReports = [];
  var activeFilter = '';
  var selectedId = null;

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function initials(name) {
    return String(name || '?').replace('@','').slice(0,2).toUpperCase();
  }
  function formatCoords(r) {
    var lat = r.latDeg ? (r.latDeg + '° ' + (r.latMin||'00') + "' " + (r.latDir||'N')) : '';
    var lon = r.lonDeg ? (r.lonDeg + '° ' + (r.lonMin||'00') + "' " + (r.lonDir||'E')) : '';
    if (!lat && !lon) return '';
    if (lat && lon) return lat + ' / ' + lon;
    return lat || lon;
  }

  // Clock
  function updateClock() {
    var now = new Date();
    var d = now.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}).toUpperCase();
    var t = now.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    document.getElementById('live-clock').innerHTML = d + ' <span>' + t + '</span>';
  }
  updateClock();
  setInterval(updateClock, 1000);

  // Modal handlers
  var overlay = document.getElementById('modal-overlay');
  document.getElementById('new-btn').onclick = function() {
    var now = new Date();
    var iso = now.toISOString().slice(0,16);
    document.getElementById('f-datetime').value = iso;
    overlay.classList.add('open');
    document.getElementById('f-title').focus();
  };
  function closeModal() { overlay.classList.remove('open'); }
  document.getElementById('cancel-btn').onclick = closeModal;
  document.getElementById('modal-close').onclick = closeModal;
  overlay.onclick = function(e) { if (e.target === overlay) closeModal(); };
  document.addEventListener('keydown', function(e) { if (e.key==='Escape') closeModal(); });
  document.getElementById('submit-btn').onclick = submitReport;

  // Global Context Setup: Event Delegation to capture actions safely 
  document.body.addEventListener('click', function(e) {
    var targetStatusBtn = e.target.closest('.status-action-btn');
    if (targetStatusBtn) {
      var id = targetStatusBtn.dataset.id;
      var targetStatus = targetStatusBtn.dataset.status;
      setStatus(id, targetStatus);
      return;
    }

    var targetSendBtn = e.target.closest('#send-btn');
    if (targetSendBtn) {
      var reportId = targetSendBtn.dataset.id;
      addComment(reportId);
    }
  });

  // Catch dynamic keystrokes inside dynamic components safely
  document.body.addEventListener('keydown', function(e) {
    var targetCommentInput = e.target.closest('#comment-input');
    if (targetCommentInput && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var reportId = targetCommentInput.dataset.id;
      addComment(reportId);
    }
  });

  // Fetch API Sync Core
  function loadReports() {
    fetch('/api/reports')
      .then(function(r){ return r.json(); })
      .then(function(data) {
        allReports = data;
        document.getElementById('cnt-all').textContent      = data.length;
        document.getElementById('cnt-critical').textContent = data.filter(function(r){ return r.severity==='critical'; }).length;
        document.getElementById('cnt-open').textContent     = data.filter(function(r){ return r.status==='OPEN'; }).length;
        document.getElementById('cnt-prog').textContent     = data.filter(function(r){ return r.status==='IN_PROGRESS'; }).length;
        document.getElementById('cnt-res').textContent      = data.filter(function(r){ return r.status==='RESOLVED'; }).length;
        document.getElementById('sync-label').textContent   = new Date().toLocaleTimeString();
        renderList();
        if (selectedId) {
          var r = allReports.find(function(r){ return String(r.id)===String(selectedId); });
          if (r) renderDetail(r);
        }
      })
      .catch(function(e){ console.error(e); });
  }

  // Filter Event Attachment
  document.querySelectorAll('.ftab').forEach(function(tab) {
    tab.onclick = function() {
      activeFilter = tab.dataset.f;
      document.querySelectorAll('.ftab').forEach(function(t){ t.classList.remove('active'); });
      tab.classList.add('active');
      renderList();
    };
  });

  ['stat-crit','stat-open','stat-prog','stat-res','stat-all'].forEach(function(id) {
    var map = {'stat-crit':'critical','stat-open':'OPEN','stat-prog':'IN_PROGRESS','stat-res':'RESOLVED','stat-all':''};
    document.getElementById(id).onclick = function() {
      activeFilter = map[id];
      document.querySelectorAll('.ftab').forEach(function(t){
        t.classList.toggle('active', t.dataset.f === activeFilter);
      });
      renderList();
    };
  });

  document.getElementById('search-input').oninput = renderList;

  function renderList() {
    var search = (document.getElementById('search-input').value || '').toLowerCase();
    var list = allReports.filter(function(r) {
      if (activeFilter === 'critical' || activeFilter === 'medium' || activeFilter === 'low') {
        if (r.severity !== activeFilter) return false;
      } else if (activeFilter) {
        if (r.status !== activeFilter) return false;
      }
      if (search) {
        var hay = [(r.title||''),(r.report||''),(r.user||''),(r.incidentType||''),(r.sector||''),(r.locationCode||''),(r.nature||''),(r.tags||[]).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    document.getElementById('record-count').textContent = list.length + ' record' + (list.length!==1?'s':'');

    var el = document.getElementById('inc-list');
    if (!list.length) {
      el.innerHTML = '<div style="padding:20px;color:var(--text-dim);font-size:13px;text-align:center;font-family:var(--font-mono);">NO RECORDS MATCH</div>';
      return;
    }

    el.innerHTML = list.map(function(r) {
      var active = String(r.id)===String(selectedId) ? ' active' : '';
      var typeLabel = r.incidentType ? esc(r.incidentType).toUpperCase() : 'UNSPECIFIED';
      var time = (r.time||'').slice(5,16);
      return '<div class="inc-row' + active + '" onclick="selectReport(\'' + r.id + '\')">' +
        '<div class="sev-stripe ' + esc(r.severity) + '"></div>' +
        '<div class="inc-row-type">' + typeLabel + '</div>' +
        '<div class="inc-row-title">' + esc(r.title || r.report) + '</div>' +
        '<div class="inc-row-meta">' +
          '<span class="badge sev-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
          '<span class="badge st-' + esc(r.status) + '">' + r.status.replace('_',' ') + '</span>' +
          '<span class="inc-time">' + time + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  window.selectReport = function(id) {
    selectedId = id;
    renderList();
    var r = allReports.find(function(r){ return String(r.id)===String(id); });
    if (r) renderDetail(r);
  };

  function renderDetail(r) {
    var panel = document.getElementById('detail-panel');
    var locCode = r.locationCode || '';
    var gridRef = r.gridRef || '';

    // Fixed unescaped inline parameter strings using custom data-attributes instead
    var statusBtns = '';
    if (r.status !== 'IN_PROGRESS') statusBtns += '<button class="btn btn-prog status-action-btn" data-id="' + r.id + '" data-status="IN_PROGRESS">🔧 In Progress</button>';
    if (r.status !== 'RESOLVED')    statusBtns += '<button class="btn btn-res status-action-btn" data-id="' + r.id + '" data-status="RESOLVED">✅ Resolve</button>';
    if (r.status !== 'OPEN')        statusBtns += '<button class="btn btn-open status-action-btn" data-id="' + r.id + '" data-status="OPEN">🆕 Reopen</button>';

    var tags = (r.tags||[]).length
      ? r.tags.map(function(t){ return '<span class="tag-chip">#'+esc(t)+'</span>'; }).join('')
      : '<span style="color:var(--text-dim);font-size:12px;">No tags</span>';

    var comments = (r.comments||[]).length
      ? r.comments.map(function(c) {
          return '<div class="comment-row">' +
            '<div class="c-avatar">' + initials(c.user) + '</div>' +
            '<div class="c-body">' +
              '<div class="c-meta"><span class="c-user">@'+esc(c.user)+'</span><span class="c-time">'+esc(c.time)+'</span></div>' +
              '<div class="c-text">'+esc(c.message)+'</div>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<div style="color:var(--text-dim);font-size:12px;font-family:var(--font-mono);">NO COMMENTS YET</div>';

    function fv(val, mono) {
      var cls = 'field-val' + (mono ? ' mono' : '') + (!val ? ' empty' : '');
      return '<div class="' + cls + '">' + (val ? esc(val) : 'N/A') + '</div>';
    }

    panel.innerHTML =
      '<div class="detail-topbar">' +
        '<div class="detail-topbar-title">Incident Report</div>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div class="status-badges" style="margin-bottom:0;">' +
            '<span class="badge sev-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
            '<span class="badge st-' + esc(r.status) + '">' + r.status.replace('_',' ') + '</span>' +
            '<span class="badge src-badge">' + esc(r.source) + '</span>' +
          '</div>' +
          '<div class="detail-topbar-id">#' + r.id + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-body">' +
        '<div class="field-card">' +
          '<div class="field-card-title">Report Information</div>' +
          '<div class="frow frow-2">' +
            '<div class="field"><div class="field-label">Report Title</div>' + fv(r.title||r.report) + '</div>' +
            '<div class="field"><div class="field-label">Report Type</div>' + fv(r.incidentType) + '</div>' +
          '</div>' +
          '<div class="frow frow-2">' +
            '<div class="field"><div class="field-label">Report Date &amp; Time</div>' + fv(r.time, true) + '</div>' +
            '<div class="field"><div class="field-label">Nature of Incident</div>' + fv(r.nature||r.incidentType) + '</div>' +
          '</div>' +
          '<div class="frow frow-2">' +
            '<div class="field"><div class="field-label">Reported By</div>' + fv(r.user) + '</div>' +
            '<div class="field"><div class="field-label">Severity</div>' + fv(r.severity ? r.severity.toUpperCase() : '') + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="field-card">' +
          '<div class="field-card-title">📍 Location</div>' +
          '<div class="frow" style="grid-template-columns:1.2fr 1.2fr 0.7fr 2fr;">' +
            '<div class="field"><div class="field-label">Lat Deg °</div>' + fv(r.latDeg, true) + '</div>' +
            '<div class="field"><div class="field-label">Lat Min \'</div>' + fv(r.latMin, true) + '</div>' +
            '<div class="field"><div class="field-label">Lat Dir</div>' + fv(r.latDir||'N', true) + '</div>' +
            '<div class="field"><div class="field-label">Location Code</div>' + fv(locCode) + '</div>' +
          '</div>' +
          '<div class="frow" style="grid-template-columns:1.2fr 1.2fr 0.7fr 1.4fr 1fr;">' +
            '<div class="field"><div class="field-label">Lon Deg °</div>' + fv(r.lonDeg, true) + '</div>' +
            '<div class="field"><div class="field-label">Lon Min \'</div>' + fv(r.lonMin, true) + '</div>' +
            '<div class="field"><div class="field-label">Lon Dir</div>' + fv(r.lonDir||'E', true) + '</div>' +
            '<div class="field"><div class="field-label">Sector</div>' + fv(r.sector) + '</div>' +
            '<div class="field"><div class="field-label">Grid Ref</div>' + fv(gridRef, true) + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="field-card">' +
          '<div class="field-card-title">Details of Incident</div>' +
          '<div class="field">' +
            '<div class="field-label">Description</div>' +
            '<div class="' + (r.description ? 'desc-val' : 'desc-val empty') + '">' + (r.description ? esc(r.description) : 'No details provided.') + '</div>' +
          '</div>' +
          '<div style="margin-top:12px;">' +
            '<div class="field-label" style="margin-bottom:6px;">Tags</div>' +
            '<div class="tags-wrap">' + tags + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="field-card">' +
          '<div class="field-card-title">Assignment &amp; Status</div>' +
          '<div class="frow frow-3">' +
            '<div class="field"><div class="field-label">Assignee</div>' + fv(r.assignee ? '@'+r.assignee : '') + '</div>' +
            '<div class="field"><div class="field-label">Created</div>' + fv(r.time, true) + '</div>' +
            '<div class="field"><div class="field-label">Last Updated</div>' + fv(r.updatedAt||r.time, true) + '</div>' +
          '</div>' +
          '<div style="margin-top:12px;"><div class="action-bar">' + statusBtns + '</div></div>' +
        '</div>' +

        '<div class="field-card">' +
          '<div class="field-card-title">Comments (' + (r.comments||[]).length + ')</div>' +
          '<div class="comment-thread">' + comments + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="comment-input-bar">' +
        '<textarea class="comment-textarea" id="comment-input" data-id="' + r.id + '" placeholder="Add a comment..."></textarea>' +
        '<button class="btn-send" id="send-btn" data-id="' + r.id + '">Send</button>' +
      '</div>';
  }

  function setStatus(id, status) {
    fetch('/api/reports/' + id + '/status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({status: status, user: 'dashboard'})
    }).then(loadReports);
  }

  function addComment(id) {
    var input = document.getElementById('comment-input');
    if (!input) return;
    var message = input.value.trim();
    if (!message) return;
    fetch('/api/reports/' + id + '/comment', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({message: message, user: 'dashboard'})
    }).then(function() {
      input.value = '';
      loadReports();
    });
  }

  function submitReport() {
    var title       = document.getElementById('f-title').value.trim();
    var incType     = document.getElementById('f-type').value.trim() || 'INCIDENT REPORT';
    var nature      = document.getElementById('f-nature').value.trim();
    var severity    = document.getElementById('f-severity').value;
    var priority    = document.getElementById('f-priority').value;
    var description = document.getElementById('f-description').value.trim();
    var message     = document.getElementById('f-message').value.trim() || title;
    var assignee    = document.getElementById('f-assignee').value.trim();
    var sector      = document.getElementById('f-sector').value;
    var latDeg      = document.getElementById('f-latdeg').value.trim();
    var latMin      = document.getElementById('f-latmin').value.trim();
    var latDir      = document.getElementById('f-latdir').value;
    var lonDeg      = document.getElementById('f-londeg').value.trim();
    var lonMin      = document.getElementById('f-lonmin').value.trim();
    var lonDir      = document.getElementById('f-londir').value;
    var locCode     = document.getElementById('f-loccode').value.trim();
    var gridRef     = document.getElementById('f-gridref').value.trim();
    var tags        = document.getElementById('f-tags').value.split(',').map(function(t){ return t.trim(); }).filter(Boolean);

    if (!title) { alert('Report Title is required.'); return; }
    if (!message) { alert('Short Report Summary is required.'); return; }

    fetch('/api/report', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        title: title, incidentType: nature || incType,
        severity: severity, priority: priority,
        description: description, message: message,
        assignee: assignee, sector: sector,
        latDeg: latDeg, latMin: latMin, latDir: latDir,
        lonDeg: lonDeg, lonMin: lonMin, lonDir: lonDir,
        locationCode: locCode, gridRef: gridRef,
        tags: tags, user: 'dashboard'
      })
    })
    .then(function(res) { 
      if (!res.ok) throw new Error('Network response was not ok');
      return res.json(); 
    })
    .then(function(data) {
      // Safe cleanup array: clears fields only if they actually exist in the DOM
      var fieldsToClear = ['f-title','f-type','f-nature','f-reporter','f-description','f-message','f-assignee','f-latdeg','f-latmin','f-londeg','f-lonmin','f-loccode','f-gridref','f-tags'];
      fieldsToClear.forEach(function(id) {
        var targetField = document.getElementById(id);
        if (targetField) targetField.value = '';
      });

      // Reset dropdown selectors safely
      if (document.getElementById('f-severity')) document.getElementById('f-severity').value = 'medium';
      if (document.getElementById('f-priority')) document.getElementById('f-priority').value = 'normal';
      if (document.getElementById('f-latdir'))  document.getElementById('f-latdir').value = 'N';
      if (document.getElementById('f-londir'))  document.getElementById('f-londir').value = 'E';
      if (document.getElementById('f-sector'))  document.getElementById('f-sector').value = '';
      
      closeModal();

      // Set the active selected panel to the new item and force refresh
      if (data && data.report && data.report.id) {
        selectedId = data.report.id;
      }
      loadReports();
    })
    .catch(function(err) {
      console.error('Submission failed:', err);
      alert('Failed to save report. Check your server terminal console log.');
    });
  }

  loadReports();
  setInterval(loadReports, 3000);
});
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
  console.log('Server running on port ' + PORT);
  console.log('Dashboard: http://localhost:' + PORT + '/dashboard');
});
