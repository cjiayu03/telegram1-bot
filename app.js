const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 🔑 Telegram bot token
const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// store messages
let reports = [];

/* =========================
   TELEGRAM MESSAGE HANDLER
========================= */
bot.on('message', async (msg) => {
  const text = msg.text || '';
  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  console.log(user, text);

  // ONLY /report works
  if (!text.startsWith('/report')) return;

  const reportText = text.replace('/report', '').trim();

  const data = {
    user,
    chatId,
    time: new Date().toISOString(),
    report: reportText || '[empty]'
  };

  reports.unshift(data);
  reports = reports.slice(0, 100);

  console.log("REPORT:", data);

  // optional: send to your API
  try {
    await axios.post('https://your-api.com/output', data);
  } catch (e) {
    console.error('API error:', e.message);
  }

  // reply in Telegram
  bot.sendMessage(chatId, "✅ Report received");
});

/* =========================
   SIMPLE DASHBOARD
========================= */
app.get('/dashboard', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:Arial;background:#111;color:white;padding:20px;">
        <h2>📩 Telegram Reports</h2>

        ${reports.map(r => `
          <div style="border-bottom:1px solid #333;padding:10px;">
            <b>@${r.user}</b><br/>
            ${r.report}<br/>
            <small>${r.time}</small>
          </div>
        `).join('')}
      </body>
    </html>
  `);
});

/* =========================
   START SERVER
========================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
