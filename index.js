require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const schedule = require('node-schedule');
const express = require('express');
const path = require('path');
const fs = require('fs');

const required_env = ['DISCORD_TOKEN', 'SPREADSHEET_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
const missing_env = required_env.filter(k => !process.env[k]);
const configured = missing_env.length === 0;
if (!configured) {
  console.warn(`[tabby] Missing env vars: ${missing_env.join(', ')} — dashboard will start but bot is offline.`);
}

if (process.env.TIMEZONE) {
  process.env.TZ = process.env.TIMEZONE;
}

const client = configured ? new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  presence: {
    status: 'online',
    activities: [{ name: 'your announcements', type: 3 }],
  },
}) : null;

function getSpreadsheetId(input) {
  const match = input.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : input;
}

let doc = null;
if (configured) {
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  doc = new GoogleSpreadsheet(getSpreadsheetId(process.env.SPREADSHEET_ID), oauth2Client);
}

const scheduledJobs = new Map();

function getChannelId(input) {
  if (typeof input !== 'string') return input;
  const match = input.match(/channels\/\d+\/(\d+)/);
  return match ? match[1] : input;
}

function getVal(row, sheet, key) {
  const actualKey = sheet.headerValues.find(h => h.trim().toLowerCase() === key.toLowerCase());
  return actualKey ? row.get(actualKey) : '';
}

async function checkSheet() {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const headers = sheet.headerValues.map(h => h.trim().toLowerCase());
    const required = ['channel link/id', 'schedule', 'message content'];
    const missing = required.filter(h => !headers.includes(h));

    if (missing.length > 0) {
      console.error(`Missing required headers: ${missing.join(', ')}`);
      console.log(`Current headers: ${sheet.headerValues.join(', ')}`);
      return;
    }

    for (const row of rows) {
      const channelLinkOrId = getVal(row, sheet, 'channel link/id');
      const scheduleStr = getVal(row, sheet, 'schedule');
      const content = getVal(row, sheet, 'message content');
      const rowId = row.rowNumber;

      if (scheduleStr && !scheduledJobs.has(rowId)) {
        scheduleRecurring(rowId, channelLinkOrId, content, row, sheet);
      }
    }
  } catch (error) {
    console.error('Error checking sheet:', error);
  }
}

function parseTime(timeStr) {
  const match = timeStr.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!match) return [null, null];

  let hours = parseInt(match[1]);
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const ampm = match[3] ? match[3].toLowerCase() : null;

  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  return [hours, minutes];
}

const SHORT_DAY_MAP = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
const FULL_DAY_MAP  = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
const DAY_NAMES_SHORT = ['sun','mon','tue','wed','thu','fri','sat'];

function dayIndex(name) {
  const n = name.trim().toLowerCase();
  return n in SHORT_DAY_MAP ? SHORT_DAY_MAP[n] : (n in FULL_DAY_MAP ? FULL_DAY_MAP[n] : -1);
}

function getUtcOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
  }).formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const h = parts.hour === '24' ? '00' : parts.hour;
  return date.getTime() - new Date(`${parts.year}-${parts.month}-${parts.day}T${h}:${parts.minute}:${parts.second}Z`).getTime();
}

function nextWeeklyOccurrence(dayName, hour, minute, tz) {
  const target = dayIndex(dayName);
  if (target < 0) return Math.floor(Date.now() / 1000);
  const now = new Date();
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now.getTime() + offset * 86400000);
    const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
      .format(candidate).toLowerCase().slice(0, 3);
    if (dayStr !== DAY_NAMES_SHORT[target]) continue;
    const dp = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' })
      .formatToParts(candidate).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    const naiveUtc = new Date(`${dp.year}-${dp.month}-${dp.day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`);
    const targetUtc = new Date(naiveUtc.getTime() + getUtcOffsetMs(candidate, tz));
    if (offset === 0 && targetUtc <= now) continue;
    return Math.floor(targetUtc.getTime() / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function scheduleRecurring(rowId, channelLinkOrId, content, row, sheet) {
  const scheduleStr = getVal(row, sheet, 'schedule');
  const parts = scheduleStr.toLowerCase().trim().split(/\s+/);

  try {
    if (parts[0] === 'daily') {
      const [hrs, mins] = parseTime(parts[1]);
      if (hrs === null) throw new Error('Invalid time format');
      const rule = new schedule.RecurrenceRule();
      rule.hour = hrs; rule.minute = mins;
      const job = schedule.scheduleJob(rule, async () => {
        await postMessage(channelLinkOrId, content, row, sheet);
      });
      scheduledJobs.set(rowId, [job]);
    }
    else if (parts[0].match(/^[1-5](st|nd|rd|th)$/)) {
      // nth weekday of month: "1st monday 09:00"
      const week = parseInt(parts[0]);
      const di = dayIndex(parts[1]);
      const [hrs, mins] = parseTime(parts[2]);
      if (hrs === null || di < 0) throw new Error('Invalid nth-day format');
      const job = schedule.scheduleJob(`${mins} ${hrs} * * ${di}`, async () => {
        if (Math.ceil(new Date().getDate() / 7) === week) {
          await postMessage(channelLinkOrId, content, row, sheet);
        }
      });
      scheduledJobs.set(rowId, [job]);
    }
    else if (parts[0].split(',').some(d => dayIndex(d) >= 0)) {
      // multi-day: "mon,wed,fri 09:00" or legacy "monday 09:00"
      const dayNames = parts[0].split(',');
      const [hrs, mins] = parseTime(parts[1]);
      if (hrs === null) throw new Error('Invalid time format');
      const jobs = dayNames.map(d => {
        const di = dayIndex(d);
        if (di < 0) return null;
        const rule = new schedule.RecurrenceRule();
        rule.dayOfWeek = di; rule.hour = hrs; rule.minute = mins;
        return schedule.scheduleJob(rule, async () => {
          await postMessage(channelLinkOrId, content, row, sheet);
        });
      }).filter(Boolean);
      if (jobs.length) scheduledJobs.set(rowId, jobs);
    }
    else {
      const postTime = new Date(scheduleStr);
      if (!isNaN(postTime.getTime()) && postTime > new Date() && !getVal(row, sheet, 'status')) {
        const job = schedule.scheduleJob(postTime, async () => {
          await postMessage(channelLinkOrId, content, row, sheet);
          scheduledJobs.delete(rowId);
        });
        scheduledJobs.set(rowId, [job]);
      }
    }

    console.log(`Scheduled: "${scheduleStr}" for row ${rowId}`);
  } catch (e) {
    console.error(`Failed to parse schedule "${scheduleStr}" for row ${rowId}:`, e.message);
  }
}

function resolveTokens(content) {
  // {t:fri:16:00:America/New_York:F} → next weekly occurrence in that tz
  let out = content.replace(/\{t:([a-z]+):(\d{2}):(\d{2}):([^:{}]+):([FfDdTtR])\}/gi,
    (_, day, hh, mm, tz, fmt) => `<t:${nextWeeklyOccurrence(day, parseInt(hh), parseInt(mm), tz)}:${fmt}>`
  );
  // {t:F} legacy → post time
  const unix = Math.floor(Date.now() / 1000);
  return out.replace(/\{t:([FfDdTtR])\}/g, (_, fmt) => `<t:${unix}:${fmt}>`);
}

async function postMessage(channelLinkOrId, content, row, sheet) {
  const now = new Date().toISOString();
  const lastSent = getVal(row, sheet, 'status');
  if (lastSent && lastSent.startsWith(now.substring(0, 16))) return;

  const ids = channelLinkOrId.split('|').map(v => getChannelId(v.trim().replace(/^ch:/, ''))).filter(Boolean);
  const resolved = resolveTokens(content);
  let sent = 0;

  for (const channelId of ids) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) { await channel.send(resolved); sent++; }
    } catch (e) {
      console.error(`Failed to post to ${channelId}:`, e.message);
    }
  }

  if (sent > 0) {
    const statusKey = sheet.headerValues.find(h => h.trim().toLowerCase() === 'status');
    if (statusKey) { row.set(statusKey, `Posted at ${now}`); await row.save(); }
    console.log(`Posted to ${sent}/${ids.length} channels at ${now}`);
  }
}

// --- Express dashboard ---

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    online: client ? client.isReady() : false,
    tag: client && client.isReady() ? client.user.tag : null,
    jobs: [...scheduledJobs.values()].reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0),
    configured,
    missing: missing_env,
  });
});

app.get('/api/schedules', async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Bot not configured. Add credentials to .env.' });
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const data = rows.map(row => ({
      rowNumber: row.rowNumber,
      channel: getVal(row, sheet, 'channel link/id'),
      schedule: getVal(row, sheet, 'schedule'),
      message: getVal(row, sheet, 'message content'),
      status: getVal(row, sheet, 'status'),
    }));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/schedules', async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Bot not configured.' });
  try {
    const { channel, schedule: sched, message } = req.body;
    if (!channel || !sched || !message) {
      return res.status(400).json({ error: 'channel, schedule, and message are required' });
    }
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      'Channel Link/ID': channel,
      'Schedule': sched,
      'Message Content': message,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/schedules/:rowNumber', async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Bot not configured.' });
  try {
    const rowNumber = parseInt(req.params.rowNumber);
    const { channel, schedule: sched, message } = req.body;
    if (!channel || !sched || !message) return res.status(400).json({ error: 'channel, schedule, and message are required' });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber === rowNumber);
    if (!row) return res.status(404).json({ error: 'Row not found' });
    const chKey = sheet.headerValues.find(h => h.trim().toLowerCase() === 'channel link/id');
    const schedKey = sheet.headerValues.find(h => h.trim().toLowerCase() === 'schedule');
    const msgKey = sheet.headerValues.find(h => h.trim().toLowerCase() === 'message content');
    if (chKey) row.set(chKey, channel);
    if (schedKey) row.set(schedKey, sched);
    if (msgKey) row.set(msgKey, message);
    await row.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/schedules/:rowNumber', async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Bot not configured.' });
  try {
    const rowNumber = parseInt(req.params.rowNumber);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const row = rows.find(r => r.rowNumber === rowNumber);
    if (!row) return res.status(404).json({ error: 'Row not found' });
    await row.delete();
    if (scheduledJobs.has(rowNumber)) {
      const jobs = scheduledJobs.get(rowNumber);
      (Array.isArray(jobs) ? jobs : [jobs]).forEach(j => j.cancel());
      scheduledJobs.delete(rowNumber);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/servers', (req, res) => {
  if (!client?.isReady()) return res.json([]);
  const guilds = [...client.guilds.cache.values()].map(g => ({
    id: g.id,
    name: g.name,
    icon: g.iconURL({ size: 64 }),
    memberCount: g.memberCount || 0,
  }));
  res.json(guilds);
});

app.get('/api/servers/:guildId/channels', async (req, res) => {
  if (!client?.isReady()) return res.status(503).json({ error: 'Bot offline' });
  try {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    await guild.channels.fetch();
    const channels = [...guild.channels.cache.values()]
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name, category: c.parent?.name || '' }))
      .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
    res.json(channels);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/servers/:guildId/roles', async (req, res) => {
  if (!client?.isReady()) return res.status(503).json({ error: 'Bot offline' });
  try {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    await guild.roles.fetch();
    const roles = [...guild.roles.cache.values()]
      .filter(r => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor }));
    res.json(roles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/invite', (req, res) => {
  if (!client?.isReady()) return res.status(503).json({ error: 'Bot offline' });
  const url = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=2048&scope=bot`;
  res.json({ url });
});

function startServer(port) {
  const server = app.listen(port, () => {
    fs.writeFileSync(path.join(__dirname, '.port'), String(port));
    console.log(`Dashboard: http://localhost:${port}`);
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying ${port + 1}`);
      startServer(port + 1);
    } else throw e;
  });
}
startServer(3000);

// --- Discord bot ---

if (configured) {
  client.once('ready', () => {
    console.log(`Bot online: ${client.user.tag}`);
    checkSheet();
    setInterval(checkSheet, 30 * 1000);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user)) return;
    if (!process.env.OPENROUTER_API_KEY) return;

    const userText = message.content.replace(/<@!?\d+>/g, '').trim() || 'say hi';

    try {
      await message.channel.sendTyping();
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://tabbyannounce',
          'X-Title': 'TabbyAnnounce',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-haiku-4-5',
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content: `You are TabbyAnnounce, a sarcastic and witty Discord bot who takes announcements very seriously but finds everything else ridiculous. Keep replies under 2 sentences. Be funny. Never break character. Never use asterisks for actions.`,
            },
            { role: 'user', content: userText },
          ],
        }),
      });
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (reply) await message.reply(reply);
    } catch (e) {
      console.error('[tabby] OpenRouter error:', e.message);
    }
  });

  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('[tabby] Bot login failed:', err.message);
    if (err.message.includes('disallowed intents')) {
      console.error('[tabby] ACTION REQUIRED: Enable "Message Content Intent" in the Discord Developer Portal');
      console.error('[tabby] → https://discord.com/developers/applications → Bot → Privileged Gateway Intents');
      console.error('[tabby] Dashboard is still running — bot features require the intent to be enabled.');
    }
  });
}
