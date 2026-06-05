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
  return { inline_keyboard: [[
    { text: '💬 Comment',     callback_data: `comment:${id}` },
    { text: '🔧 In Progress', callback_data: `status:${id}:IN_PROGRESS` },
    { text: '✅ Resolve',     callback_data: `status:${id}:RESOLVED` }
  ]]};
}
async function downloadTelegramFile(fileId, originalName) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const filename = `${Date.now()}-${originalName || path.basename(fileInfo.file_path)}`;
    const localPath = path.join(uploadDir, filename);
    const res = await fetch(url);
    await fs.promises.writeFile(localPath, Buffer.from(await res.arrayBuffer()));
    return `/uploads/${filename}`;
  } catch (e) { console.error('Download failed:', e.message); return ''; }
}

// ── TELEGRAM BOT ──────────────────────────────────────────────────────────────
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
    if (report.status === newStatus) return bot.answerCallbackQuery(query.id, { text: `Already ${newStatus}.` });
    report.status = newStatus; report.updatedAt = now();
    try {
      await bot.editMessageText(
        (query.message.text || '').replace(/Status:.+/g, '') + `\nStatus: ${statusEmoji(newStatus)} *${newStatus}*\nUpdated by @${user}`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: incidentKeyboard(incidentId) });
    } catch (_) {}
    bot.answerCallbackQuery(query.id, { text: `${statusEmoji(newStatus)} Marked ${newStatus}` });
    bot.sendMessage(GROUP_CHAT_ID, `${statusEmoji(newStatus)} *Status Update*\n\nIncident \`${incidentId}\` → *${newStatus}* by @${user}`, { parse_mode: 'Markdown' });
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
    if (!report) return bot.sendMessage(chatId, `❌ Incident \`${incidentId}\` not found.`, { parse_mode: 'Markdown' });
    report.comments.push({ id: Date.now(), user, message: text, time: now() });
    bot.deleteMessage(chatId, promptMsgId).catch(() => {});
    bot.sendMessage(GROUP_CHAT_ID, `💬 *Comment on "${report.title || incidentId}"*\n\n@${user}: ${text}`,
      { parse_mode: 'Markdown', reply_to_message_id: originMsgId, reply_markup: incidentKeyboard(incidentId) });
    return;
  }

  if (text.startsWith('/template')) {
    return bot.sendMessage(chatId,
      "📝 *Copy the template below, fill it out, and send it:*\n\n```\n/report\nTitle: \nType: General\nNature: \nSeverity: medium\nSector: \nLat Deg: \nLat Min: \nLat Dir: N\nLoc Code: \nReported By: \nDescription: \n```",
      { parse_mode: 'Markdown' });
  }

  if (text.startsWith('/report')) {
    if (text.trim() === '/report')
      return bot.sendMessage(chatId, "⚠️ Please specify details. Type `/template` for the template.", { parse_mode: 'Markdown' });
    const get = (re, fb = '') => { const m = text.match(re); return m && m[1] ? m[1].trim() : fb; };
    const titleText    = get(/^Title:\s*(.+)$/m, 'Untitled Telegram Report');
    const incidentType = get(/^Type:\s*(.+)$/m, 'General');
    const nature       = get(/^Nature:\s*(.+)$/m, 'Unspecified Outage');
    const severityRaw  = get(/^Severity:\s*(.+)$/m, 'medium').toLowerCase();
    const sector       = get(/^Sector:\s*(.+)$/m, 'Unassigned');
    const latDeg       = get(/^Lat Deg:\s*(\d*)$/m, '');
    const latMin       = get(/^Lat Min:\s*(\d*)$/m, '');
    const latDir       = get(/^Lat Dir:\s*([NSEWnsew])$/m, 'N').toUpperCase();
    const locationCode = get(/^Loc Code:\s*(.+)$/m, '');
    const reportedBy   = get(/^Reported By:\s*(.+)$/m, `@${user}`);
    const description  = get(/^Description:\s*([\s\S]*)$/m, 'Reported via Telegram.');
    const severity     = VALID_SEVERITIES.includes(severityRaw) ? severityRaw : 'medium';
    let fileId = '', origName = '';
    if (msg.photo?.length) { fileId = msg.photo[msg.photo.length - 1].file_id; origName = 'telegram-image.jpg'; }
    else if (msg.document) { fileId = msg.document.file_id; origName = msg.document.file_name; }
    const attachment = fileId ? await downloadTelegramFile(fileId, origName) : '';
    const report = {
      id: Date.now(), user: `@${user}`, severity, report: titleText,
      title: titleText.slice(0, 60), description, assignee: '',
      priority: severity === 'critical' ? 'high' : 'normal',
      status: 'OPEN', source: 'telegram', time: now(), updatedAt: now(), comments: [],
      incidentType, nature, sector, latDeg, latMin, latDir, locationCode, reportedBy, attachment
    };
    reports.unshift(report);
    const locStr = formatLocation(report) !== 'N/A' ? `\n📍 *Location*: ${formatLocation(report)}` : '';
    bot.sendMessage(chatId,
      `✅ *Incident Synchronized*${attachment ? '\n📎 *Media Attached*: Yes' : ''}\n\n*ID*: \`${report.id}\`\n*Type*: ${incidentType}\n*Severity*: ${severityEmoji(severity)} ${severity.toUpperCase()}${locStr}\n\nLive on the CommandCenter dashboard.`,
      { parse_mode: 'Markdown' });
    bot.sendMessage(GROUP_CHAT_ID,
      `🚨 *New Incident* [${incidentType.toUpperCase()}]\n\n*Title*: ${report.title}\n*ID*: \`${report.id}\`\n*Severity*: ${severityEmoji(severity)} ${severity.toUpperCase()}\n*Sector*: ${sector}${locStr}\n*Reporter*: ${reportedBy}\n*Status*: 🆕 OPEN`,
      { parse_mode: 'Markdown', reply_markup: incidentKeyboard(report.id) });
    return;
  }

  if (!text.startsWith('/') && String(chatId) === String(GROUP_CHAT_ID)) {
    const report = {
      id: Date.now(), user, severity: 'low', report: text,
      title: text.slice(0, 60), description: '', assignee: '',
      priority: 'normal', status: 'OPEN', source: 'telegram',
      time: now(), updatedAt: now(), comments: [],
      incidentType: 'Unspecified', nature: 'Unspecified', sector: 'Unassigned',
      latDeg: '', latMin: '', latDir: 'N', locationCode: '', reportedBy: `@${user}`, attachment: ''
    };
    reports.unshift(report);
    bot.sendMessage(chatId,
      `✅ *Incident Created*\n\nID: \`${report.id}\`\nSeverity: 🟡 LOW\nFrom: @${user}`,
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id, reply_markup: incidentKeyboard(report.id) });
  }
});

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.post('/api/report', (req, res) => {
  const { severity = 'low', message, user = 'dashboard', title = '', description = '',
    assignee = '', priority = 'normal', incidentType = 'General', sector = '',
    latDeg = '', latMin = '', latDir = 'N', locationCode = '',
    nature = 'General Outage', reportedBy = 'Dashboard Operator' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!VALID_SEVERITIES.includes(severity)) return res.status(400).json({ error: `Severity must be: ${VALID_SEVERITIES.join(', ')}` });
  const report = {
    id: Date.now(), user, severity, report: message,
    title: title || message.slice(0, 60), description, assignee,
    priority, status: 'OPEN', source: 'dashboard',
    time: now(), updatedAt: now(), comments: [],
    incidentType, sector: sector || 'Unassigned',
    latDeg, latMin, latDir, locationCode, nature, reportedBy, attachment: ''
  };
  reports.unshift(report);
  const locStr = formatLocation(report) !== 'N/A' ? `\nLocation: ${formatLocation(report)}` : '';
  bot.sendMessage(GROUP_CHAT_ID,
    `🚨 *Dashboard Incident* [${incidentType.toUpperCase()}]\n\nID: \`${report.id}\`\nTitle: ${report.title}\nSeverity: ${severityEmoji(severity)} ${severity.toUpperCase()}\nFrom: ${user}${locStr}\nStatus: 🆕 OPEN\n\n${message}`,
    { parse_mode: 'Markdown', reply_markup: incidentKeyboard(report.id) });
  res.json({ success: true, report });
});

app.patch('/api/reports/:id', (req, res) => {
  const report = reports.find(r => String(r.id) === String(req.params.id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });
  ['title','description','assignee','priority','severity','incidentType','sector','latDeg','latMin','latDir','locationCode','nature','reportedBy']
    .forEach(k => { if (req.body[k] !== undefined) report[k] = req.body[k]; });
  report.updatedAt = now();
  res.json({ success: true, report });
});

app.post('/api/reports/:id/status', (req, res) => {
  const { status, user = 'dashboard' } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be: ${VALID_STATUSES.join(', ')}` });
  const report = reports.find(r => String(r.id) === String(req.params.id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });
  const old = report.status;
  report.status = status; report.updatedAt = now();
  bot.sendMessage(GROUP_CHAT_ID,
    `${statusEmoji(status)} *Status Update*\n\nIncident \`${req.params.id}\` by ${user}\n${old} → *${status}*`,
    { parse_mode: 'Markdown' });
  res.json({ success: true, report });
});

app.post('/api/reports/:id/comment', (req, res) => {
  const { message, user = 'dashboard' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  const report = reports.find(r => String(r.id) === String(req.params.id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });
  const comment = { id: Date.now(), user, message, time: now() };
  report.comments.push(comment);
  report.updatedAt = now();
  bot.sendMessage(GROUP_CHAT_ID,
    `💬 *Comment on "${report.title || req.params.id}"*\n\n@${user}: ${message}`,
    { parse_mode: 'Markdown', reply_markup: incidentKeyboard(req.params.id) });
  res.json({ success: true, comment });
});

app.get('/api/reports', (req, res) => res.json(reports));

// ── DASHBOARD HTML ────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Incident Command Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Syne:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#07090f; --surface:#0c1018; --surface2:#111722; --surface3:#161e2c;
  --border:#1a2538; --border2:#223048;
  --text:#dce8f5; --muted:#3d5470; --muted2:#5a7a9a;
  --accent:#4f8ef7; --accent2:#2563eb;
  --sev-low-bg:#071a0f;  --sev-low:#34d399;
  --sev-med-bg:#1a0f00;  --sev-med:#fb923c;
  --sev-crit-bg:#1a0505; --sev-crit:#f87171;
  --st-open-bg:#04122b;  --st-open:#60a5fa;
  --st-prog-bg:#1a1200;  --st-prog:#fbbf24;
  --st-res-bg:#071a0f;   --st-res:#34d399;
}
*,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); font-family:'Syne',sans-serif; color:var(--text); min-height:100vh; overflow:hidden; }

.header { background:var(--surface); border-bottom:1px solid var(--border); padding:0 24px; height:56px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:10; }
.logo { font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; display:flex; align-items:center; gap:10px; }
.pulse-dot { width:7px; height:7px; border-radius:50%; background:#ef4444; animation:pulse 2s infinite; }
@keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)} 70%{box-shadow:0 0 0 8px rgba(239,68,68,0)} 100%{box-shadow:0 0 0 0 rgba(239,68,68,0)} }
.header-right { display:flex; align-items:center; gap:14px; }
.ts { font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--muted2); }

.stats-bar { background:var(--surface); border-bottom:1px solid var(--border); padding:0 24px; display:flex; overflow-x:auto; }
.stat { padding:12px 22px; border-right:1px solid var(--border); cursor:pointer; min-width:100px; }
.stat:hover,.stat.active { background:var(--surface2); }
.stat-n { font-family:'IBM Plex Mono',monospace; font-size:20px; font-weight:600; line-height:1; margin-bottom:2px; }
.stat-l { font-size:10px; color:var(--muted2); text-transform:uppercase; letter-spacing:.1em; }
.s-crit .stat-n { color:var(--sev-crit); }
.s-open .stat-n { color:var(--st-open); }
.s-prog .stat-n { color:var(--st-prog); }
.s-res  .stat-n { color:var(--st-res); }

.layout { display:flex; height:calc(100vh - 103px); }

.left-panel { width:300px; min-width:240px; border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
.panel-tools { padding:10px; border-bottom:1px solid var(--border); }
.search { width:100%; background:var(--surface2); border:1px solid var(--border2); border-radius:6px; padding:8px 11px; color:var(--text); font-family:'Syne',sans-serif; font-size:13px; outline:none; }
.search:focus { border-color:var(--accent); }
.chips { padding:8px 10px; border-bottom:1px solid var(--border); display:flex; gap:4px; flex-wrap:wrap; }
.chip { padding:3px 9px; border-radius:20px; font-size:10px; font-weight:600; cursor:pointer; border:1px solid var(--border2); color:var(--muted2); background:transparent; font-family:'Syne',sans-serif; letter-spacing:.04em; }
.chip:hover { border-color:var(--accent); color:var(--accent); }
.chip.on { background:var(--accent); border-color:var(--accent); color:#fff; }

.inc-list { flex:1; overflow-y:auto; padding:5px; }
.inc-list::-webkit-scrollbar { width:3px; }
.inc-list::-webkit-scrollbar-thumb { background:var(--border2); border-radius:2px; }

.card { padding:10px 11px 10px 16px; border-radius:7px; border:1px solid transparent; margin-bottom:3px; cursor:pointer; position:relative; }
.card:hover { background:var(--surface2); border-color:var(--border2); }
.card.on { background:var(--surface2); border-color:var(--accent); }
.sev-bar { position:absolute; left:5px; top:7px; bottom:7px; width:3px; border-radius:2px; }
.sev-bar.low      { background:var(--sev-low); }
.sev-bar.medium   { background:var(--sev-med); }
.sev-bar.critical { background:var(--sev-crit); }
.card-title { font-size:12px; font-weight:600; margin-bottom:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card-meta { display:flex; gap:4px; align-items:center; flex-wrap:wrap; }

.badge { display:inline-flex; align-items:center; padding:2px 6px; border-radius:4px; font-size:9px; font-weight:700; font-family:'IBM Plex Mono',monospace; letter-spacing:.06em; text-transform:uppercase; white-space:nowrap; }
.b-low      { background:var(--sev-low-bg);  color:var(--sev-low); }
.b-medium   { background:var(--sev-med-bg);  color:var(--sev-med); }
.b-critical { background:var(--sev-crit-bg); color:var(--sev-crit); }
.b-OPEN        { background:var(--st-open-bg); color:var(--st-open); }
.b-IN_PROGRESS { background:var(--st-prog-bg); color:var(--st-prog); }
.b-RESOLVED    { background:var(--st-res-bg);  color:var(--st-res); }
.b-src { background:var(--surface3); border:1px solid var(--border2); color:var(--muted2); }

.detail-panel { flex:1; display:flex; flex-direction:column; overflow:hidden; }

.detail-head { padding:16px 22px 14px; background:var(--surface); border-bottom:1px solid var(--border); flex-shrink:0; }
.detail-title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
.detail-title { font-family:'IBM Plex Mono',monospace; font-size:15px; font-weight:600; line-height:1.35; flex:1; }
.detail-id { font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--muted2); flex-shrink:0; margin-top:3px; }
.detail-badges { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:12px; }
.action-row { display:flex; gap:7px; flex-wrap:wrap; }

.btn { display:inline-flex; align-items:center; gap:5px; padding:7px 13px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; border:none; font-family:'Syne',sans-serif; letter-spacing:.04em; text-transform:uppercase; white-space:nowrap; }
.btn-primary { background:var(--accent); color:#fff; }
.btn-primary:hover { background:var(--accent2); }
.btn-ghost { background:var(--surface2); color:var(--text); border:1px solid var(--border2); }
.btn-ghost:hover { border-color:var(--accent); color:var(--accent); }
.btn-warn    { background:var(--sev-med-bg); color:var(--sev-med); border:1px solid #5a3000; }
.btn-warn:hover { background:#2a1800; }
.btn-success { background:var(--sev-low-bg); color:var(--sev-low); border:1px solid #0d4020; }
.btn-success:hover { background:#0a2d16; }
.btn-danger  { background:var(--sev-crit-bg); color:var(--sev-crit); border:1px solid #5a1010; }
.btn-danger:hover { background:#2a0808; }

.cards-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; padding:16px 20px; overflow-y:auto; flex:1; align-content:start; }
.cards-grid::-webkit-scrollbar { width:3px; }
.cards-grid::-webkit-scrollbar-thumb { background:var(--border2); border-radius:2px; }

.info-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 16px; display:flex; flex-direction:column; gap:7px; transition:border-color .15s; }
.info-card:hover { border-color:var(--border2); }
.info-card.full { grid-column:1/-1; }
.ic-icon  { font-size:16px; color:var(--muted2); line-height:1; }
.ic-label { font-size:9px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted2); font-weight:600; }
.ic-val   { font-size:15px; font-weight:600; color:var(--text); line-height:1.3; }
.ic-val.mono  { font-family:'IBM Plex Mono',monospace; font-size:13px; }
.ic-val.muted { color:var(--muted2); font-weight:400; font-size:14px; }
.ic-val.prose { font-size:13px; font-weight:400; line-height:1.65; color:#9ab5cf; }
.ic-val.small { font-family:'IBM Plex Mono',monospace; font-size:11px; line-height:1.6; color:#9ab5cf; }

.comment-thread { display:flex; flex-direction:column; gap:8px; }
.comment-item { display:flex; gap:10px; padding:10px 12px; background:var(--surface2); border:1px solid var(--border); border-radius:8px; }
.av { width:28px; height:28px; border-radius:50%; background:var(--st-open-bg); display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; flex-shrink:0; font-family:'IBM Plex Mono',monospace; color:var(--st-open); }
.c-user { font-size:12px; font-weight:600; color:var(--accent); }
.c-time { font-size:10px; color:var(--muted2); font-family:'IBM Plex Mono',monospace; }
.c-text { font-size:13px; line-height:1.5; color:#9ab5cf; margin-top:3px; }

.comment-bar { display:flex; gap:8px; padding:12px 20px; border-top:1px solid var(--border); background:var(--surface); flex-shrink:0; }
.comment-input { flex:1; background:var(--surface2); border:1px solid var(--border2); border-radius:7px; padding:9px 12px; color:var(--text); font-family:'Syne',sans-serif; font-size:13px; outline:none; resize:none; height:38px; transition:border-color .15s,height .15s; }
.comment-input:focus { border-color:var(--accent); height:68px; }

.empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--muted2); }

#overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.8); align-items:center; justify-content:center; z-index:9999; padding:20px; }
#overlay.open { display:flex; }
.modal { background:var(--surface); border:1px solid var(--border2); border-radius:14px; width:100%; max-width:580px; padding:24px; display:flex; flex-direction:column; gap:13px; max-height:92vh; overflow-y:auto; }
.modal-title { font-family:'IBM Plex Mono',monospace; font-size:14px; font-weight:600; letter-spacing:.06em; }
.fl { display:block; font-size:10px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted2); margin-bottom:3px; }
.fi,.fs,.ft { width:100%; background:var(--surface2); border:1px solid var(--border2); border-radius:7px; padding:9px 12px; color:var(--text); font-family:'Syne',sans-serif; font-size:13px; outline:none; transition:border-color .15s; }
.fi:focus,.fs:focus,.ft:focus { border-color:var(--accent); }
.ft { resize:vertical; min-height:68px; }
.f2 { display:grid; grid-template-columns:1fr 1fr; gap:11px; }
.f4 { display:grid; grid-template-columns:1.5fr 1.5fr 1fr 2fr; gap:8px; }
.modal-foot { display:flex; gap:8px; justify-content:flex-end; margin-top:4px; }
</style>
</head>
<body>

<div class="header">
  <div class="logo"><div class="pulse-dot"></div>Incident&nbsp;Command</div>
  <div class="header-right">
    <span class="ts" id="ts">CONNECTING...</span>
    <button class="btn btn-primary" id="new-btn">+ New Incident</button>
  </div>
</div>

<div class="stats-bar">
  <div class="stat s-crit" id="st-crit"><div class="stat-n" id="n-crit">0</div><div class="stat-l">Critical</div></div>
  <div class="stat s-open" id="st-open"><div class="stat-n" id="n-open">0</div><div class="stat-l">Open</div></div>
  <div class="stat s-prog" id="st-prog"><div class="stat-n" id="n-prog">0</div><div class="stat-l">In Progress</div></div>
  <div class="stat s-res"  id="st-res" ><div class="stat-n" id="n-res" >0</div><div class="stat-l">Resolved</div></div>
  <div class="stat"        id="st-all" ><div class="stat-n" id="n-all" >0</div><div class="stat-l">Total</div></div>
</div>

<div class="layout">
  <div class="left-panel">
    <div class="panel-tools"><input class="search" id="search" placeholder="Search incidents…"></div>
    <div class="chips">
      <button class="chip on" data-f="">All</button>
      <button class="chip" data-f="OPEN">Open</button>
      <button class="chip" data-f="IN_PROGRESS">In Progress</button>
      <button class="chip" data-f="RESOLVED">Resolved</button>
      <button class="chip" data-f="critical">Critical</button>
      <button class="chip" data-f="medium">Medium</button>
      <button class="chip" data-f="low">Low</button>
    </div>
    <div class="inc-list" id="inc-list"></div>
  </div>

  <div class="detail-panel" id="detail-panel">
    <div class="empty">
      <div style="font-size:40px;opacity:.2;">⌖</div>
      <div style="font-size:14px;font-weight:600;">Select an incident</div>
      <div style="font-size:12px;margin-top:2px;">or create one with + New Incident</div>
    </div>
  </div>
</div>

<div id="overlay">
  <div class="modal">
    <div class="modal-title">// NEW INCIDENT</div>
    <div class="f2">
      <div><label class="fl">Title *</label><input class="fi" id="f-title" placeholder="Short descriptive title"></div>
      <div><label class="fl">Incident Type</label><input class="fi" id="f-type" placeholder="Outage, Cyber, Leak…"></div>
    </div>
    <div class="f2">
      <div><label class="fl">Nature of Incident</label><input class="fi" id="f-nature" placeholder="Fiber Cut, Power Drop…"></div>
      <div><label class="fl">Severity</label>
        <select class="fs" id="f-sev"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="critical">Critical</option></select>
      </div>
    </div>
    <div class="f2">
      <div><label class="fl">Sector</label><input class="fi" id="f-sector" placeholder="Sector 4, Alpha, North-Zone"></div>
      <div><label class="fl">Priority</label>
        <select class="fs" id="f-pri"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select>
      </div>
    </div>
    <div>
      <label class="fl">Location Coordinates &amp; Code</label>
      <div class="f4">
        <input class="fi" id="f-latdeg" type="number" placeholder="Lat Deg °">
        <input class="fi" id="f-latmin" type="number" placeholder="Lat Min '">
        <select class="fs" id="f-latdir"><option value="N">N</option><option value="S">S</option><option value="E">E</option><option value="W">W</option></select>
        <input class="fi" id="f-loccode" placeholder="Location Code">
      </div>
    </div>
    <div class="f2">
      <div><label class="fl">Reported By *</label><input class="fi" id="f-reportedby" placeholder="Name / Unit"></div>
      <div><label class="fl">Assignee</label><input class="fi" id="f-assignee" placeholder="@username"></div>
    </div>
    <div><label class="fl">Description</label><textarea class="ft" id="f-desc" placeholder="What happened? Impact, context…"></textarea></div>
    <div><label class="fl">Short Report * (sent to Telegram)</label><input class="fi" id="f-msg" placeholder="One-line summary"></div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
      <button class="btn btn-primary" id="submit-btn">Create Incident</button>
    </div>
  </div>
</div>

<script>
(function () {
  var all = [], activeFilter = '', selectedId = null;

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function ini(n) { return String(n || '?').replace('@','').slice(0,2).toUpperCase(); }
  function coords(r) {
    if (!r.latDeg) return null;
    return r.latDeg + String.fromCharCode(176) + (r.latMin || '00') + "'" + (r.latDir || 'N');
  }
  function card(icon, label, valHtml) {
    return '<div class="info-card"><div class="ic-icon">' + icon + '</div><div class="ic-label">' + label + '</div>' + valHtml + '</div>';
  }
  function cardFull(icon, label, valHtml) {
    return '<div class="info-card full"><div class="ic-icon">' + icon + '</div><div class="ic-label">' + label + '</div>' + valHtml + '</div>';
  }
  function val(v, cls) { return '<div class="ic-val' + (cls ? ' ' + cls : '') + '">' + esc(v || '') + '</div>'; }

  // ── MODAL ──
  var overlay = document.getElementById('overlay');
  document.getElementById('new-btn').addEventListener('click', function () {
    overlay.classList.add('open');
    document.getElementById('f-title').focus();
  });
  document.getElementById('cancel-btn').addEventListener('click', function () { overlay.classList.remove('open'); });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.classList.remove('open'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') overlay.classList.remove('open'); });
  document.getElementById('submit-btn').addEventListener('click', submitReport);

  // ── LOAD ──
  function load() {
    fetch('/api/reports').then(function (r) { return r.json(); }).then(function (data) {
      all = data;
      document.getElementById('n-all').textContent  = data.length;
      document.getElementById('n-crit').textContent = data.filter(function (r) { return r.severity === 'critical'; }).length;
      document.getElementById('n-open').textContent = data.filter(function (r) { return r.status === 'OPEN'; }).length;
      document.getElementById('n-prog').textContent = data.filter(function (r) { return r.status === 'IN_PROGRESS'; }).length;
      document.getElementById('n-res').textContent  = data.filter(function (r) { return r.status === 'RESOLVED'; }).length;
      document.getElementById('ts').textContent     = 'UPDATED ' + new Date().toLocaleTimeString();
      renderList();
      if (selectedId) {
        var r = all.find(function (r) { return String(r.id) === String(selectedId); });
        if (r) renderDetail(r);
      }
    }).catch(function (e) { console.error(e); });
  }

  // ── FILTER CHIPS ──
  document.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      activeFilter = c.dataset.f;
      document.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on');
      renderList();
    });
  });

  var statMap = { 'st-crit':'critical', 'st-open':'OPEN', 'st-prog':'IN_PROGRESS', 'st-res':'RESOLVED', 'st-all':'' };
  Object.keys(statMap).forEach(function (id) {
    document.getElementById(id).addEventListener('click', function () {
      activeFilter = statMap[id];
      document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c.dataset.f === activeFilter); });
      renderList();
    });
  });

  document.getElementById('search').addEventListener('input', renderList);

  // ── RENDER LIST ──
  function renderList() {
    var q = (document.getElementById('search').value || '').toLowerCase();
    var list = all.filter(function (r) {
      if (activeFilter === 'critical' || activeFilter === 'medium' || activeFilter === 'low') {
        if (r.severity !== activeFilter) return false;
      } else if (activeFilter) {
        if (r.status !== activeFilter) return false;
      }
      if (q) {
        var hay = [r.title, r.report, r.user, r.assignee, r.incidentType, r.nature, r.reportedBy, r.sector, r.locationCode].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    var el = document.getElementById('inc-list');
    if (!list.length) {
      el.innerHTML = '<div style="padding:20px;color:var(--muted2);font-size:13px;text-align:center;">No incidents match</div>';
      return;
    }
    el.innerHTML = list.map(function (r) {
      var active = String(r.id) === String(selectedId) ? ' on' : '';
      var prefix = r.incidentType ? '[' + esc(r.incidentType) + '] ' : '';
      var t = (r.time || '').slice(5, 16);
      return '<div class="card' + active + '" data-id="' + r.id + '">' +
        '<div class="sev-bar ' + esc(r.severity) + '"></div>' +
        '<div class="card-title">' + prefix + esc(r.title || r.report) + '</div>' +
        '<div class="card-meta">' +
          '<span class="badge b-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
          '<span class="badge b-' + esc(r.status) + '">' + r.status.replace('_', ' ') + '</span>' +
          '<span style="font-size:10px;color:var(--muted2);margin-left:auto;">' + t + '</span>' +
        '</div></div>';
    }).join('');
  }

  // Event delegation for incident list clicks
  document.getElementById('inc-list').addEventListener('click', function (e) {
    var card = e.target.closest('[data-id]');
    if (!card) return;
    selectedId = card.dataset.id;
    renderList();
    var r = all.find(function (r) { return String(r.id) === String(selectedId); });
    if (r) renderDetail(r);
  });

  // ── RENDER DETAIL ──
  function renderDetail(r) {
    var panel = document.getElementById('detail-panel');

    var coordsStr = coords(r) || '<span style="color:var(--muted2)">N/A</span>';
    var locCodeHtml = r.locationCode ? val(r.locationCode, 'mono') : '<div class="ic-val muted">N/A</div>';
    var assigneeHtml = r.assignee ? val('@' + r.assignee) : '<div class="ic-val muted">Unassigned</div>';

    var descCard = r.description ? cardFull('📄', 'Description', val(r.description, 'prose')) : '';

    var attachCard = '';
    if (r.attachment) {
      var ext = r.attachment.split('.').pop().toLowerCase();
      if (['jpg','jpeg','png','gif','webp'].includes(ext)) {
        attachCard = '<div class="info-card full"><div class="ic-icon">📎</div><div class="ic-label">Photographic Evidence</div>' +
          '<img src="' + esc(r.attachment) + '" style="max-width:100%;max-height:340px;border-radius:7px;border:1px solid var(--border2);margin-top:6px;" alt="Evidence"></div>';
      } else {
        attachCard = cardFull('📎', 'Attached Document',
          '<a href="' + esc(r.attachment) + '" target="_blank" style="color:var(--accent);font-size:13px;text-decoration:underline;">Download File</a>');
      }
    }

    var comments = (r.comments || []).length
      ? r.comments.map(function (c) {
          return '<div class="comment-item">' +
            '<div class="av">' + ini(c.user) + '</div>' +
            '<div style="flex:1"><div style="display:flex;gap:8px;align-items:center;">' +
              '<span class="c-user">@' + esc(c.user) + '</span>' +
              '<span class="c-time">' + esc(c.time) + '</span></div>' +
            '<div class="c-text">' + esc(c.message) + '</div></div></div>';
        }).join('')
      : '<div style="color:var(--muted2);font-size:13px;padding:6px 0;">No comments yet.</div>';

    panel.innerHTML =
      '<div class="detail-head">' +
        '<div class="detail-title-row">' +
          '<div class="detail-title">[' + esc(r.incidentType || 'General') + '] ' + esc(r.title || r.report) + '</div>' +
          '<div class="detail-id">#' + r.id + '</div>' +
        '</div>' +
        '<div class="detail-badges">' +
          '<span class="badge b-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
          '<span class="badge b-' + esc(r.status) + '">' + r.status.replace('_',' ') + '</span>' +
          '<span class="badge b-src">' + esc(r.source) + '</span>' +
        '</div>' +
        '<div class="action-row" id="action-row"></div>' +
      '</div>' +
      '<div class="cards-grid">' +
        card('🗂', 'Incident Type', val(r.incidentType || 'General')) +
        card('⚡', 'Nature', val(r.nature || 'Unspecified')) +
        card('📍', 'Sector', val(r.sector || 'Unassigned')) +
        '<div class="info-card"><div class="ic-icon">🌐</div><div class="ic-label">Coordinates</div><div class="ic-val mono">' + coordsStr + '</div></div>' +
        '<div class="info-card"><div class="ic-icon">#</div><div class="ic-label">Location Code</div>' + locCodeHtml + '</div>' +
        card('👤', 'Reported By', val(r.reportedBy || 'N/A')) +
        '<div class="info-card"><div class="ic-icon">🎯</div><div class="ic-label">Assignee</div>' + assigneeHtml + '</div>' +
        card('🕐', 'Created', val(r.time, 'small')) +
        card('🔄', 'Last Updated', val(r.updatedAt || r.time, 'small')) +
        cardFull('📋', 'Short Report', val(r.report, 'prose')) +
        descCard +
        attachCard +
        '<div class="info-card full">' +
          '<div class="ic-icon">💬</div>' +
          '<div class="ic-label">Comments (' + (r.comments || []).length + ')</div>' +
          '<div class="comment-thread" style="margin-top:8px;">' + comments + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="comment-bar">' +
        '<textarea class="comment-input" id="c-input" placeholder="Add a comment… (Enter to send)"></textarea>' +
        '<button class="btn btn-primary" id="c-send">Send</button>' +
      '</div>';

    // Build action buttons with proper event listeners (no inline onclick)
    var actionRow = document.getElementById('action-row');
    if (r.status !== 'IN_PROGRESS') {
      var b1 = document.createElement('button');
      b1.className = 'btn btn-warn';
      b1.textContent = '🔧 In Progress';
      b1.addEventListener('click', function () { setStatus(r.id, 'IN_PROGRESS'); });
      actionRow.appendChild(b1);
    }
    if (r.status !== 'RESOLVED') {
      var b2 = document.createElement('button');
      b2.className = 'btn btn-success';
      b2.textContent = '✅ Resolve';
      b2.addEventListener('click', function () { setStatus(r.id, 'RESOLVED'); });
      actionRow.appendChild(b2);
    }
    if (r.status !== 'OPEN') {
      var b3 = document.createElement('button');
      b3.className = 'btn btn-danger';
      b3.textContent = '🆕 Reopen';
      b3.addEventListener('click', function () { setStatus(r.id, 'OPEN'); });
      actionRow.appendChild(b3);
    }

    document.getElementById('c-send').addEventListener('click', function () { addComment(r.id); });
    document.getElementById('c-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(r.id); }
    });
  }

  // ── ACTIONS ──
  function setStatus(id, status) {
    fetch('/api/reports/' + id + '/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status, user: 'dashboard' })
    }).then(load);
  }

  function addComment(id) {
    var input = document.getElementById('c-input');
    var msg = input.value.trim();
    if (!msg) return;
    fetch('/api/reports/' + id + '/comment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, user: 'dashboard' })
    }).then(function () { input.value = ''; load(); });
  }

  function submitReport() {
    var title = document.getElementById('f-title').value.trim();
    if (!title) { alert('Title is required.'); return; }
    var body = {
      title: title,
      incidentType: document.getElementById('f-type').value.trim() || 'General',
      nature:       document.getElementById('f-nature').value.trim() || 'Unspecified',
      severity:     document.getElementById('f-sev').value,
      priority:     document.getElementById('f-pri').value,
      sector:       document.getElementById('f-sector').value.trim(),
      latDeg:       document.getElementById('f-latdeg').value.trim(),
      latMin:       document.getElementById('f-latmin').value.trim(),
      latDir:       document.getElementById('f-latdir').value,
      locationCode: document.getElementById('f-loccode').value.trim(),
      reportedBy:   document.getElementById('f-reportedby').value.trim() || 'Dashboard Operator',
      assignee:     document.getElementById('f-assignee').value.trim(),
      description:  document.getElementById('f-desc').value.trim(),
      message:      document.getElementById('f-msg').value.trim() || title,
      user: 'dashboard'
    };
    fetch('/api/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function () {
      ['f-title','f-type','f-nature','f-sector','f-latdeg','f-latmin','f-loccode','f-reportedby','f-assignee','f-desc','f-msg']
        .forEach(function (id) { document.getElementById(id).value = ''; });
      document.getElementById('f-sev').value = 'medium';
      document.getElementById('f-pri').value = 'normal';
      document.getElementById('f-latdir').value = 'N';
      overlay.classList.remove('open');
      load();
    });
  }

  load();
  setInterval(load, 3000);
})();
</script>
</body>
</html>`;

app.get('/dashboard', (req, res) => res.send(DASHBOARD_HTML));
app.get('/', (req, res) => res.send('Incident System Running — <a href="/dashboard">Open Dashboard</a>'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  console.log('Dashboard: http://localhost:' + PORT + '/dashboard');
});
