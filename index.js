require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const schedule = require('node-schedule');
const express = require('express');
const path = require('path');

const required_env = ['DISCORD_TOKEN', 'SPREADSHEET_ID', 'GOOGLE_AUTH_FILE'];
const missing_env = required_env.filter(k => !process.env[k]);
if (missing_env.length > 0) {
  console.error(`Missing required environment variables: ${missing_env.join(', ')}`);
  console.error('Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

if (process.env.TIMEZONE) {
  process.env.TZ = process.env.TIMEZONE;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const serviceAccountAuth = new JWT({
  email: require(process.env.GOOGLE_AUTH_FILE).client_email,
  key: require(process.env.GOOGLE_AUTH_FILE).private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

function getSpreadsheetId(input) {
  const match = input.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : input;
}

const spreadsheetId = getSpreadsheetId(process.env.SPREADSHEET_ID);
const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);

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
    online: client.isReady(),
    tag: client.isReady() ? client.user.tag : null,
    jobs: scheduledJobs.size,
  });
});

app.get('/api/schedules', async (req, res) => {
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

app.listen(3000, () => {
  console.log('Dashboard: http://localhost:3000');
});

// --- Discord bot ---

client.once('ready', () => {
  console.log(`Bot online: ${client.user.tag}`);
  checkSheet();
  setInterval(checkSheet, 30 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
