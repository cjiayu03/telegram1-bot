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
    <!DOCTYPE html>
    <html>
    <head>
      <title>Telegram Report Dashboard</title>

      <meta http-equiv="refresh" content="2">

      <style>
        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: Arial, sans-serif;
          background: #0f172a;
          color: white;
        }

        .header {
          padding: 20px;
          background: #111827;
          border-bottom: 1px solid #1f2937;
        }

        .title {
          font-size: 28px;
          font-weight: bold;
        }

        .subtitle {
          color: #94a3b8;
          margin-top: 5px;
        }

        .container {
          max-width: 1000px;
          margin: auto;
          padding: 20px;
        }

        .card {
          background: #111827;
          border: 1px solid #1e293b;
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 16px;
          transition: 0.2s;
        }

        .card:hover {
          transform: translateY(-2px);
        }

        .top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .user {
          font-weight: bold;
          color: #4ade80;
          font-size: 16px;
        }

        .time {
          color: #94a3b8;
          font-size: 12px;
        }

        .report {
          font-size: 15px;
          line-height: 1.5;
          color: #f8fafc;
          word-wrap: break-word;
        }

        .empty {
          padding: 40px;
          text-align: center;
          color: #94a3b8;
        }

        .badge {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 999px;
          background: #14532d;
          color: #86efac;
          font-size: 12px;
          margin-top: 8px;
        }

      </style>
    </head>

    <body>

      <div class="header">
        <div class="title">📩 Telegram Reports Dashboard</div>
        <div class="subtitle">
          Live updates every 2 seconds
        </div>
      </div>

      <div class="container">

        ${
          reports.length === 0
            ? `
              <div class="empty">
                No reports received yet
              </div>
            `
            : reports.map(r => `
              <div class="card">

                <div class="top">
                  <div class="user">
                    @${r.user}
                  </div>

                  <div class="time">
                    ${r.time}
                  </div>
                </div>

                <div class="report">
                  ${r.report}
                </div>

                <div class="badge">
                  REPORT
                </div>

              </div>
            `).join('')
        }

      </div>

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
