require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const schedule = require('node-schedule');
const express = require('express');
const path = require('path');

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
  intents: [GatewayIntentBits.Guilds],
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

function scheduleRecurring(rowId, channelLinkOrId, content, row, sheet) {
  const scheduleStr = getVal(row, sheet, 'schedule');
  const parts = scheduleStr.toLowerCase().split(' ');
  const rule = new schedule.RecurrenceRule();

  try {
    if (parts[0] === 'daily') {
      const [hrs, mins] = parseTime(parts[1]);
      if (hrs === null) throw new Error('Invalid time format');
      rule.hour = hrs;
      rule.minute = mins;
      const job = schedule.scheduleJob(rule, async () => {
        await postMessage(channelLinkOrId, content, row, sheet);
      });
      scheduledJobs.set(rowId, job);
    }
    else if (['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].includes(parts[0])) {
      const [hrs, mins] = parseTime(parts[1]);
      if (hrs === null) throw new Error('Invalid time format');
      rule.dayOfWeek = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(parts[0]);
      rule.hour = hrs;
      rule.minute = mins;
      const job = schedule.scheduleJob(rule, async () => {
        await postMessage(channelLinkOrId, content, row, sheet);
      });
      scheduledJobs.set(rowId, job);
    }
    else if (parts[0].match(/^[1-5](st|nd|rd|th)$/)) {
      const week = parseInt(parts[0]);
      const day = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(parts[1]);
      const [hrs, mins] = parseTime(parts[2]);
      if (hrs === null) throw new Error('Invalid time format');
      const job = schedule.scheduleJob(`${mins} ${hrs} * * ${day}`, async () => {
        const now = new Date();
        if (Math.ceil(now.getDate() / 7) === week) {
          await postMessage(channelLinkOrId, content, row, sheet);
        }
      });
      scheduledJobs.set(rowId, job);
    }
    else {
      const postTime = new Date(scheduleStr);
      if (!isNaN(postTime.getTime()) && postTime > new Date() && !getVal(row, sheet, 'status')) {
        const job = schedule.scheduleJob(postTime, async () => {
          await postMessage(channelLinkOrId, content, row, sheet);
          scheduledJobs.delete(rowId);
        });
        scheduledJobs.set(rowId, job);
      }
    }

    console.log(`Scheduled: "${scheduleStr}" for row ${rowId}`);
  } catch (e) {
    console.error(`Failed to parse schedule "${scheduleStr}" for row ${rowId}:`, e.message);
  }
}

async function postMessage(channelLinkOrId, content, row, sheet) {
  try {
    const channelId = getChannelId(channelLinkOrId);
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;

    const now = new Date().toISOString();
    const lastSent = getVal(row, sheet, 'status');
    if (lastSent && lastSent.startsWith(now.substring(0, 16))) return;

    await channel.send(content);

    const statusKey = sheet.headerValues.find(h => h.trim().toLowerCase() === 'status');
    if (statusKey) {
      row.set(statusKey, `Posted at ${now}`);
      await row.save();
    }
    console.log(`Posted to ${channelId} at ${now}`);
  } catch (error) {
    console.error(`Failed to post to ${channelLinkOrId}:`, error.message);
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
    jobs: scheduledJobs.size,
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
      scheduledJobs.get(rowNumber).cancel();
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

app.get('/api/invite', (req, res) => {
  if (!client?.isReady()) return res.status(503).json({ error: 'Bot offline' });
  const url = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=2048&scope=bot`;
  res.json({ url });
});

app.listen(3000, () => {
  console.log('Dashboard: http://localhost:3000');
});

// --- Discord bot ---

if (configured) {
  client.once('ready', () => {
    console.log(`Bot online: ${client.user.tag}`);
    checkSheet();
    setInterval(checkSheet, 30 * 1000);
  });
  client.login(process.env.DISCORD_TOKEN);
}
