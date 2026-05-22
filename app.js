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

// =========================
// INLINE KEYBOARD HELPERS
// =========================

const pendingReply = {};

function incidentKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '💬 Comment',    callback_data: `comment:${id}` },
      { text: '🔧 In Progress', callback_data: `status:${id}:IN_PROGRESS` },
      { text: '✅ Resolve',    callback_data: `status:${id}:RESOLVED` }
    ]]
  };
}

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

// =========================
// TELEGRAM → INCIDENTS
// =========================

bot.on('message', (msg) => {
  const text = msg.text || '';
  if (!text || msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user   = msg.from.username || msg.from.first_name;

  // Intercept pending inline-button comment replies
  if (pendingReply[userId] && !text.startsWith('/')) {
    const { incidentId, promptMsgId, originMsgId } = pendingReply[userId];
    delete pendingReply[userId];

    const report = reports.find(r => String(r.id) === String(incidentId));
    if (!report) return bot.sendMessage(chatId, `❌ Incident \`${incidentId}\` not found.`, { parse_mode: 'Markdown' });

    const comment = { id: Date.now(), user, message: text, time: now() };
    report.comments.push(comment);
    bot.deleteMessage(chatId, promptMsgId).catch(() => {});

    bot.sendMessage(GROUP_CHAT_ID,
      `💬 *Comment on Incident \`${incidentId}\`*\n\n@${user}: ${text}`,
      { parse_mode: 'Markdown', reply_to_message_id: originMsgId, reply_markup: incidentKeyboard(incidentId) });
    return;
  }

  // ── Plain message in group chat → create incident ──────
  // If someone types a plain message (not a command) in the GROUP chat,
  // treat it as a low-severity incident report automatically
  if (!text.startsWith('/') && String(chatId) === String(GROUP_CHAT_ID)) {
    const report = {
      id: Date.now(), user, severity: 'low', report: text,
      title: text.slice(0, 60), description: '', assignee: '',
      tags: [], priority: 'normal', status: 'OPEN',
      source: 'telegram', time: now(), updatedAt: now(), comments: []
    };
    reports.unshift(report);
    bot.sendMessage(chatId,
      `✅ *Incident Created from group message*\n\nID: \`${report.id}\`\nSeverity: 🟡 LOW\nFrom: @${user}\n\nUse /status ${report.id} IN_PROGRESS or /status ${report.id} RESOLVED to update.`,
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id, reply_markup: incidentKeyboard(report.id) });
    return;
  }

  if (text.startsWith('/report')) {
    const args = text.replace('/report', '').trim().split(' ');
    let severity = 'low', start = 0;
    if (VALID_SEVERITIES.includes(args[0]?.toLowerCase())) {
      severity = args[0].toLowerCase(); start = 1;
    }
    const reportText = args.slice(start).join(' ') || '[empty]';
    const report = {
      id: Date.now(), user, severity, report: reportText,
      title: reportText.slice(0, 60), description: '', assignee: '',
      tags: [], priority: 'normal', status: 'OPEN',
      source: 'telegram', time: now(), updatedAt: now(), comments: []
    };
    reports.unshift(report);

    bot.sendMessage(chatId,
      `✅ *Incident Created*\n\nID: \`${report.id}\`\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\n\nUse /status ${report.id} <OPEN|IN_PROGRESS|RESOLVED> to update it.`,
      { parse_mode: 'Markdown' });
    bot.sendMessage(GROUP_CHAT_ID,
      `🚨 *New Incident*\n\nID: \`${report.id}\`\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\nFrom: @${user}\nStatus: 🆕 OPEN\n\n${reportText}`,
      { parse_mode: 'Markdown', reply_markup: incidentKeyboard(report.id) });
    return;
  }

  if (text.startsWith('/status')) {
    const parts = text.trim().split(' ');
    const id = parts[1], newStatus = parts[2]?.toUpperCase();
    if (!id || !newStatus) return bot.sendMessage(chatId, '⚠️ Usage: /status <id> <OPEN|IN_PROGRESS|RESOLVED>');
    if (!VALID_STATUSES.includes(newStatus)) return bot.sendMessage(chatId, `⚠️ Invalid status. Choose: ${VALID_STATUSES.join(', ')}`);
    const report = reports.find(r => String(r.id) === String(id));
    if (!report) return bot.sendMessage(chatId, `❌ Incident \`${id}\` not found.`, { parse_mode: 'Markdown' });
    const oldStatus = report.status;
    report.status = newStatus; report.updatedAt = now();
    bot.sendMessage(chatId, `${statusEmoji(newStatus)} Incident \`${id}\` updated: *${oldStatus}* → *${newStatus}*`, { parse_mode: 'Markdown' });
    bot.sendMessage(GROUP_CHAT_ID, `${statusEmoji(newStatus)} *Status Update*\n\nIncident \`${id}\` by @${user}\n${oldStatus} → *${newStatus}*`, { parse_mode: 'Markdown' });
    return;
  }

  if (text.startsWith('/comment')) {
    const parts = text.trim().split(' ');
    const id = parts[1], message = parts.slice(2).join(' ');
    if (!id || !message) return bot.sendMessage(chatId, '⚠️ Usage: /comment <id> <your message>');
    const report = reports.find(r => String(r.id) === String(id));
    if (!report) return bot.sendMessage(chatId, `❌ Incident \`${id}\` not found.`, { parse_mode: 'Markdown' });
    report.comments.push({ id: Date.now(), user, message, time: now() });
    bot.sendMessage(chatId, `💬 Comment added to incident \`${id}\`.`, { parse_mode: 'Markdown' });
    bot.sendMessage(GROUP_CHAT_ID, `💬 *Comment on Incident \`${id}\`*\n\n@${user}: ${message}`, { parse_mode: 'Markdown', reply_markup: incidentKeyboard(id) });
    return;
  }

  if (text.startsWith('/list')) {
    if (!reports.length) return bot.sendMessage(chatId, '📭 No incidents yet.');
    const lines = reports.slice(0, 10).map(r =>
      `${statusEmoji(r.status)} ${severityEmoji(r.severity)} \`${r.id}\` [${r.status}] @${r.user}: ${r.report.slice(0, 50)}`
    );
    bot.sendMessage(chatId, `📋 *Recent Incidents*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    return;
  }

  if (text.startsWith('/help')) {
    bot.sendMessage(chatId,
      `🤖 *Incident Bot Commands*\n\n` +
      `/report [low|medium|critical] <message>\n  Create a new incident\n\n` +
      `/status <id> <OPEN|IN_PROGRESS|RESOLVED>\n  Update incident status\n\n` +
      `/comment <id> <message>\n  Add a comment to an incident\n\n` +
      `/list\n  Show the 10 most recent incidents\n\n` +
      `/help\n  Show this message`,
      { parse_mode: 'Markdown' });
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
    tags = [], priority = 'normal'
  } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!VALID_SEVERITIES.includes(severity)) return res.status(400).json({ error: `Severity must be one of: ${VALID_SEVERITIES.join(', ')}` });

  const report = {
    id: Date.now(), user, severity, report: message,
    title: title || message.slice(0, 60),
    description, assignee,
    tags: Array.isArray(tags) ? tags : [],
    priority, status: 'OPEN', source: 'dashboard',
    time: now(), updatedAt: now(), comments: []
  };

  reports.unshift(report);

  const tagStr = report.tags.length ? `\nTags: ${report.tags.join(', ')}` : '';
  const assignStr = assignee ? `\nAssignee: ${assignee}` : '';
  bot.sendMessage(GROUP_CHAT_ID,
    `🚨 *Dashboard Incident*\n\nID: \`${report.id}\`\nTitle: ${report.title}\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\nPriority: ${priority.toUpperCase()}\nFrom: ${user}${assignStr}${tagStr}\nStatus: 🆕 OPEN\n\n${message}`,
    { parse_mode: 'Markdown', reply_markup: incidentKeyboard(report.id) });

  res.json({ success: true, report });
});

// =========================
// UPDATE INCIDENT FIELDS
// =========================

app.patch('/api/reports/:id', (req, res) => {
  const { id } = req.params;
  const report = reports.find(r => String(r.id) === String(id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const allowed = ['title', 'description', 'assignee', 'tags', 'priority', 'severity'];
  allowed.forEach(k => { if (req.body[k] !== undefined) report[k] = req.body[k]; });
  report.updatedAt = now();
  res.json({ success: true, report });
});

// =========================
// UPDATE STATUS
// =========================

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

// =========================
// ADD COMMENT
// =========================

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
    `💬 *Comment on Incident \`${id}\`*\n\n@${user}: ${message}`,
    { parse_mode: 'Markdown', reply_markup: incidentKeyboard(id) });

  res.json({ success: true, comment });
});

// =========================
// GET INCIDENTS
// =========================

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
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#080c14; --surface:#0d1320; --surface2:#111927;
  --border:#1c2a3a; --border2:#243042;
  --text:#e2eaf4; --muted:#4d6278;
  --accent:#3b82f6; --accent2:#1d4ed8;
  --sev-low:#0f3d26; --sev-low-t:#4ade80;
  --sev-med:#422006; --sev-med-t:#fb923c;
  --sev-crit:#450a0a; --sev-crit-t:#f87171;
  --st-open:#0f2744; --st-open-t:#60a5fa;
  --st-prog:#2d1f00; --st-prog-t:#fbbf24;
  --st-res:#0f3d26; --st-res-t:#4ade80;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);font-family:'DM Sans',sans-serif;color:var(--text);min-height:100vh;}

/* HEADER */
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:0 28px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;}
.logo{font-family:'Space Mono',monospace;font-size:15px;font-weight:700;letter-spacing:.04em;display:flex;align-items:center;gap:10px;}
.logo-dot{width:8px;height:8px;border-radius:50%;background:#ef4444;}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.4);}50%{box-shadow:0 0 0 6px rgba(239,68,68,0);}}
.logo-dot{animation:pulse 2s infinite;}

/* STATS */
.stats-bar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 28px;display:flex;overflow-x:auto;}
.stat-item{padding:14px 24px;border-right:1px solid var(--border);min-width:110px;cursor:pointer;}
.stat-item:hover,.stat-item.active{background:var(--surface2);}
.stat-num{font-family:'Space Mono',monospace;font-size:22px;font-weight:700;line-height:1;margin-bottom:3px;}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;}
.stat-critical .stat-num{color:#f87171;}
.stat-open .stat-num{color:#60a5fa;}
.stat-prog .stat-num{color:#fbbf24;}
.stat-res .stat-num{color:#4ade80;}

/* LAYOUT */
.layout{display:flex;height:calc(100vh - 103px);}

/* LEFT PANEL */
.left-panel{width:320px;min-width:260px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;}
.panel-toolbar{padding:12px;border-bottom:1px solid var(--border);flex-shrink:0;}
.search-box{width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;outline:none;}
.search-box:focus{border-color:var(--accent);}
.filter-row{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:5px;flex-wrap:wrap;flex-shrink:0;}
.chip{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--border2);color:var(--muted);background:transparent;font-family:'DM Sans',sans-serif;}
.chip:hover{border-color:var(--accent);color:var(--accent);}
.chip.active{background:var(--accent);border-color:var(--accent);color:#fff;}
.incident-list{flex:1;overflow-y:auto;padding:6px;}
.incident-list::-webkit-scrollbar{width:4px;}
.incident-list::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}

/* INCIDENT CARD */
.inc-card{padding:11px 12px 11px 18px;border-radius:8px;border:1px solid transparent;margin-bottom:3px;cursor:pointer;position:relative;}
.inc-card:hover{background:var(--surface2);border-color:var(--border2);}
.inc-card.active{background:var(--surface2);border-color:var(--accent);}
.sev-bar{position:absolute;left:6px;top:8px;bottom:8px;width:3px;border-radius:2px;}
.sev-bar.low{background:var(--sev-low-t);}
.sev-bar.medium{background:var(--sev-med-t);}
.sev-bar.critical{background:var(--sev-crit-t);}
.inc-title{font-size:13px;font-weight:500;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.inc-meta{display:flex;gap:5px;align-items:center;flex-wrap:wrap;}

/* BADGES */
.badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;font-family:'Space Mono',monospace;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;}
.sev-low{background:var(--sev-low);color:var(--sev-low-t);}
.sev-medium{background:var(--sev-med);color:var(--sev-med-t);}
.sev-critical{background:var(--sev-crit);color:var(--sev-crit-t);}
.st-OPEN{background:var(--st-open);color:var(--st-open-t);}
.st-IN_PROGRESS{background:var(--st-prog);color:var(--st-prog-t);}
.st-RESOLVED{background:var(--st-res);color:var(--st-res-t);}
.pri-low{background:#1a2035;color:#94a3b8;}
.pri-normal{background:#0f2744;color:#60a5fa;}
.pri-high{background:#2d1f00;color:#fbbf24;}
.pri-urgent{background:#450a0a;color:#f87171;}
.src-badge{background:var(--surface2);border:1px solid var(--border2);color:var(--muted);}

/* DETAIL PANEL */
.detail-panel{flex:1;display:flex;flex-direction:column;overflow:hidden;}
.detail-header{padding:18px 24px 14px;border-bottom:1px solid var(--border);flex-shrink:0;}
.detail-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;}
.detail-title{font-family:'Space Mono',monospace;font-size:17px;font-weight:700;line-height:1.3;flex:1;}
.detail-id{font-family:'Space Mono',monospace;font-size:11px;color:var(--muted);flex-shrink:0;margin-top:4px;}
.detail-badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:12px;}
.meta-item label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:2px;}
.meta-item span{font-size:13px;font-weight:500;}
.action-row{display:flex;gap:8px;flex-wrap:wrap;}

.detail-body{flex:1;overflow-y:auto;padding:18px 24px;display:flex;flex-direction:column;gap:18px;}
.detail-body::-webkit-scrollbar{width:4px;}
.detail-body::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
.section-label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:6px;font-family:'Space Mono',monospace;}
.desc-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.6;white-space:pre-wrap;}
.tags-list{display:flex;gap:6px;flex-wrap:wrap;}
.tag{padding:3px 10px;border-radius:4px;background:var(--surface2);border:1px solid var(--border2);font-size:11px;color:var(--muted);font-family:'Space Mono',monospace;}

/* COMMENTS */
.comment-thread{display:flex;flex-direction:column;gap:8px;}
.comment-item{display:flex;gap:10px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;}
.comment-avatar{width:28px;height:28px;border-radius:50%;background:var(--accent2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;font-family:'Space Mono',monospace;}
.comment-body{flex:1;}
.comment-meta{display:flex;gap:8px;align-items:center;margin-bottom:3px;}
.comment-user{font-size:12px;font-weight:600;color:#60a5fa;}
.comment-time{font-size:11px;color:var(--muted);}
.comment-text{font-size:13px;line-height:1.5;}
.comment-input-row{display:flex;gap:8px;padding:12px 24px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;}
.comment-input{flex:1;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:9px 12px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;outline:none;resize:none;height:40px;transition:border-color .15s,height .15s;}
.comment-input:focus{border-color:var(--accent);height:72px;}

/* EMPTY */
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);gap:10px;}
.empty-icon{font-size:44px;opacity:.3;}

/* BUTTONS */
.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 13px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:none;font-family:'DM Sans',sans-serif;white-space:nowrap;}
.btn-primary{background:var(--accent);color:#fff;}
.btn-primary:hover{background:var(--accent2);}
.btn-ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border2);}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent);}
.btn-danger{background:#450a0a;color:#f87171;border:1px solid #7f1d1d;}
.btn-danger:hover{background:#7f1d1d;}
.btn-success{background:var(--sev-low);color:var(--sev-low-t);border:1px solid #166534;}
.btn-success:hover{background:#166534;}
.btn-warn{background:var(--sev-med);color:var(--sev-med-t);border:1px solid #92400e;}
.btn-warn:hover{background:#92400e;}

/* MODAL */
#modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);align-items:center;justify-content:center;z-index:99999;padding:20px;}
#modal-overlay.open{display:flex;}
.modal-box{background:var(--surface);border:1px solid var(--border2);border-radius:14px;width:100%;max-width:540px;padding:26px;display:flex;flex-direction:column;gap:14px;max-height:90vh;overflow-y:auto;}
.modal-title{font-family:'Space Mono',monospace;font-size:16px;font-weight:700;}
.field-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:4px;}
.field-input,.field-select,.field-textarea{width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:9px 12px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;outline:none;transition:border-color .15s;}
.field-input:focus,.field-select:focus,.field-textarea:focus{border-color:var(--accent);}
.field-textarea{resize:vertical;min-height:80px;}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.modal-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:4px;}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-dot"></div>
    INCIDENT COMMAND
  </div>
  <div style="display:flex;align-items:center;gap:14px;">
    <span style="font-size:12px;color:var(--muted);font-family:'Space Mono',monospace;" id="last-updated">CONNECTING...</span>
    <button class="btn btn-primary" id="new-btn">+ New Incident</button>
  </div>
</div>

<div class="stats-bar">
  <div class="stat-item stat-critical" id="stat-critical" style="padding-left:0">
    <div class="stat-num" id="cnt-critical">0</div>
    <div class="stat-label">Critical</div>
  </div>
  <div class="stat-item stat-open" id="stat-open">
    <div class="stat-num" id="cnt-open">0</div>
    <div class="stat-label">Open</div>
  </div>
  <div class="stat-item stat-prog" id="stat-prog">
    <div class="stat-num" id="cnt-prog">0</div>
    <div class="stat-label">In Progress</div>
  </div>
  <div class="stat-item stat-res" id="stat-res">
    <div class="stat-num" id="cnt-res">0</div>
    <div class="stat-label">Resolved</div>
  </div>
  <div class="stat-item" id="stat-all">
    <div class="stat-num" id="cnt-all">0</div>
    <div class="stat-label">Total</div>
  </div>
</div>

<div class="layout">
  <div class="left-panel">
    <div class="panel-toolbar">
      <input class="search-box" id="search-box" placeholder="Search incidents...">
    </div>
    <div class="filter-row">
      <button class="chip active" data-filter="">All</button>
      <button class="chip" data-filter="OPEN">Open</button>
      <button class="chip" data-filter="IN_PROGRESS">In Progress</button>
      <button class="chip" data-filter="RESOLVED">Resolved</button>
      <button class="chip" data-filter="critical">Critical</button>
      <button class="chip" data-filter="medium">Medium</button>
      <button class="chip" data-filter="low">Low</button>
    </div>
    <div class="incident-list" id="incident-list"></div>
  </div>

  <div class="detail-panel" id="detail-panel">
    <div class="empty-state">
      <div class="empty-icon">🎯</div>
      <div style="font-size:14px;">Select an incident to view details</div>
      <div style="font-size:12px;margin-top:4px;">or create one with + New Incident</div>
    </div>
  </div>
</div>

<!-- MODAL — lives at top level, no parent stacking context issues -->
<div id="modal-overlay">
  <div class="modal-box" id="modal-box">
    <div class="modal-title">Create New Incident</div>

    <div>
      <label class="field-label">Title *</label>
      <input class="field-input" id="f-title" placeholder="Short, descriptive title">
    </div>

    <div class="field-row">
      <div>
        <label class="field-label">Severity</label>
        <select class="field-select" id="f-severity">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="critical">Critical</option>
        </select>
      </div>
      <div>
        <label class="field-label">Priority</label>
        <select class="field-select" id="f-priority">
          <option value="low">Low</option>
          <option value="normal" selected>Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
    </div>

    <div>
      <label class="field-label">Description</label>
      <textarea class="field-textarea" id="f-description" placeholder="What happened? Impact, steps to reproduce..."></textarea>
    </div>

    <div>
      <label class="field-label">Short Report * (sent to Telegram)</label>
      <input class="field-input" id="f-message" placeholder="One-line summary">
    </div>

    <div class="field-row">
      <div>
        <label class="field-label">Assignee</label>
        <input class="field-input" id="f-assignee" placeholder="@username">
      </div>
      <div>
        <label class="field-label">Tags (comma-separated)</label>
        <input class="field-input" id="f-tags" placeholder="infra, db, auth">
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
      <button class="btn btn-primary" id="submit-btn">Create Incident</button>
    </div>
  </div>
</div>

<script>
var allReports = [];
var activeFilter = '';
var selectedId = null;

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function initials(name) {
  return String(name || '?').replace('@','').slice(0,2).toUpperCase();
}

// ── MODAL ──────────────────────────────────────────────────
var overlay = document.getElementById('modal-overlay');
document.getElementById('new-btn').onclick = function() {
  overlay.classList.add('open');
  document.getElementById('f-title').focus();
};
document.getElementById('cancel-btn').onclick = function() {
  overlay.classList.remove('open');
};
overlay.onclick = function(e) {
  if (e.target === overlay) overlay.classList.remove('open');
};
document.getElementById('submit-btn').onclick = submitReport;
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') overlay.classList.remove('open');
});

// ── LOAD ───────────────────────────────────────────────────
function loadReports() {
  fetch('/api/reports')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      allReports = data;
      document.getElementById('cnt-all').textContent      = data.length;
      document.getElementById('cnt-critical').textContent = data.filter(function(r){return r.severity==='critical';}).length;
      document.getElementById('cnt-open').textContent     = data.filter(function(r){return r.status==='OPEN';}).length;
      document.getElementById('cnt-prog').textContent     = data.filter(function(r){return r.status==='IN_PROGRESS';}).length;
      document.getElementById('cnt-res').textContent      = data.filter(function(r){return r.status==='RESOLVED';}).length;
      document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      renderList();
      if (selectedId) {
        var r = allReports.find(function(r){return String(r.id)===String(selectedId);});
        if (r) renderDetail(r);
      }
    })
    .catch(function(e){ console.error('Load error', e); });
}

// ── FILTER ─────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(function(chip) {
  chip.onclick = function() {
    activeFilter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach(function(c){ c.classList.remove('active'); });
    chip.classList.add('active');
    renderList();
  };
});

['stat-critical','stat-open','stat-prog','stat-res','stat-all'].forEach(function(id) {
  var map = {'stat-critical':'critical','stat-open':'OPEN','stat-prog':'IN_PROGRESS','stat-res':'RESOLVED','stat-all':''};
  document.getElementById(id).onclick = function() {
    activeFilter = map[id];
    document.querySelectorAll('.chip').forEach(function(c){
      c.classList.toggle('active', c.dataset.filter === activeFilter);
    });
    renderList();
  };
});

document.getElementById('search-box').oninput = renderList;

// ── LIST ───────────────────────────────────────────────────
function renderList() {
  var search = (document.getElementById('search-box').value || '').toLowerCase();
  var list = allReports.filter(function(r) {
    if (activeFilter === 'critical' || activeFilter === 'medium' || activeFilter === 'low') {
      if (r.severity !== activeFilter) return false;
    } else if (activeFilter) {
      if (r.status !== activeFilter) return false;
    }
    if (search) {
      var hay = [(r.title||''),(r.report||''),(r.user||''),(r.assignee||''),(r.tags||[]).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  var el = document.getElementById('incident-list');
  if (!list.length) {
    el.innerHTML = '<div style="padding:20px;color:#4d6278;font-size:13px;text-align:center;">No incidents match</div>';
    return;
  }

  el.innerHTML = list.map(function(r) {
    var active = String(r.id) === String(selectedId) ? ' active' : '';
    var assignee = r.assignee ? '<span style="font-size:11px;color:#4d6278;">to ' + esc(r.assignee) + '</span>' : '';
    var time = (r.time || '').slice(5,16);
    return '<div class="inc-card' + active + '" onclick="selectIncident(\\'' + r.id + '\\')">' +
      '<div class="sev-bar ' + esc(r.severity) + '"></div>' +
      '<div class="inc-title">' + esc(r.title || r.report) + '</div>' +
      '<div class="inc-meta">' +
        '<span class="badge sev-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
        '<span class="badge st-' + esc(r.status) + '">' + r.status.replace('_',' ') + '</span>' +
        assignee +
        '<span style="font-size:11px;color:#4d6278;margin-left:auto;">' + time + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── DETAIL ─────────────────────────────────────────────────
function selectIncident(id) {
  selectedId = id;
  renderList();
  var r = allReports.find(function(r){return String(r.id)===String(id);});
  if (r) renderDetail(r);
}

function renderDetail(r) {
  var panel = document.getElementById('detail-panel');

  var tags = (r.tags || []).length
    ? r.tags.map(function(t){return '<span class="tag">#'+esc(t)+'</span>';}).join('')
    : '<span style="color:#4d6278;font-size:12px;">No tags</span>';

  var comments = (r.comments || []).length
    ? r.comments.map(function(c) {
        return '<div class="comment-item">' +
          '<div class="comment-avatar">' + initials(c.user) + '</div>' +
          '<div class="comment-body">' +
            '<div class="comment-meta">' +
              '<span class="comment-user">@' + esc(c.user) + '</span>' +
              '<span class="comment-time">' + esc(c.time) + '</span>' +
            '</div>' +
            '<div class="comment-text">' + esc(c.message) + '</div>' +
          '</div>' +
        '</div>';
      }).join('')
    : '<div style="color:#4d6278;font-size:13px;padding:8px 0;">No comments yet.</div>';

  var statusBtns = '';
  if (r.status !== 'IN_PROGRESS') statusBtns += '<button class="btn btn-warn" onclick="setStatus(\\'' + r.id + '\\',\\'IN_PROGRESS\\')">🔧 In Progress</button>';
  if (r.status !== 'RESOLVED')    statusBtns += '<button class="btn btn-success" onclick="setStatus(\\'' + r.id + '\\',\\'RESOLVED\\')">✅ Resolve</button>';
  if (r.status !== 'OPEN')        statusBtns += '<button class="btn btn-danger" onclick="setStatus(\\'' + r.id + '\\',\\'OPEN\\')">🆕 Reopen</button>';

  var descSection = r.description
    ? '<div><div class="section-label">Description</div><div class="desc-box">' + esc(r.description) + '</div></div>'
    : '';

  var assignee = r.assignee ? '@' + esc(r.assignee) : '<span style="color:#4d6278;">Unassigned</span>';

  panel.innerHTML =
    '<div class="detail-header">' +
      '<div class="detail-title-row">' +
        '<div class="detail-title">' + esc(r.title || r.report) + '</div>' +
        '<div class="detail-id">#' + r.id + '</div>' +
      '</div>' +
      '<div class="detail-badges">' +
        '<span class="badge sev-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
        '<span class="badge st-' + esc(r.status) + '">' + r.status.replace('_',' ') + '</span>' +
        '<span class="badge pri-' + esc(r.priority||'normal') + '">' + esc(r.priority||'normal') + ' priority</span>' +
        '<span class="badge src-badge">' + esc(r.source) + '</span>' +
      '</div>' +
      '<div class="meta-grid">' +
        '<div class="meta-item"><label>Reporter</label><span>@' + esc(r.user) + '</span></div>' +
        '<div class="meta-item"><label>Assignee</label><span>' + assignee + '</span></div>' +
        '<div class="meta-item"><label>Created</label><span>' + esc(r.time) + '</span></div>' +
        '<div class="meta-item"><label>Updated</label><span>' + esc(r.updatedAt || r.time) + '</span></div>' +
      '</div>' +
      '<div class="action-row">' + statusBtns + '</div>' +
    '</div>' +
    '<div class="detail-body">' +
      '<div><div class="section-label">Short Report</div><div class="desc-box">' + esc(r.report) + '</div></div>' +
      descSection +
      '<div><div class="section-label">Tags</div><div class="tags-list">' + tags + '</div></div>' +
      '<div><div class="section-label">Comments (' + (r.comments||[]).length + ')</div>' +
        '<div class="comment-thread">' + comments + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="comment-input-row">' +
      '<textarea class="comment-input" id="comment-input" placeholder="Add a comment... (Enter to send)"></textarea>' +
      '<button class="btn btn-primary" id="send-comment-btn">Send</button>' +
    '</div>';

  document.getElementById('send-comment-btn').onclick = function() { addComment(r.id); };
  document.getElementById('comment-input').onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(r.id); }
  };
}

// ── ACTIONS ────────────────────────────────────────────────
function setStatus(id, status) {
  fetch('/api/reports/' + id + '/status', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({status: status, user: 'dashboard'})
  }).then(loadReports);
}

function addComment(id) {
  var input = document.getElementById('comment-input');
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
  var severity    = document.getElementById('f-severity').value;
  var priority    = document.getElementById('f-priority').value;
  var description = document.getElementById('f-description').value.trim();
  var message     = document.getElementById('f-message').value.trim() || title;
  var assignee    = document.getElementById('f-assignee').value.trim();
  var tagsRaw     = document.getElementById('f-tags').value;
  var tags        = tagsRaw.split(',').map(function(t){return t.trim();}).filter(Boolean);

  if (!title) { alert('Title is required.'); return; }

  fetch('/api/report', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({title:title, severity:severity, priority:priority, description:description, message:message||title, assignee:assignee, tags:tags, user:'dashboard'})
  }).then(function() {
    ['f-title','f-description','f-message','f-assignee','f-tags'].forEach(function(id){document.getElementById(id).value='';});
    document.getElementById('f-severity').value = 'medium';
    document.getElementById('f-priority').value = 'normal';
    overlay.classList.remove('open');
    loadReports();
  });
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
  console.log('Server running on port ' + PORT);
  console.log('Dashboard: http://localhost:' + PORT + '/dashboard');
});
