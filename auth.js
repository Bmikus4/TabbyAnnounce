// One-time OAuth2 setup — run with: node auth.js
// Saves GOOGLE_REFRESH_TOKEN to your .env automatically.

require('dotenv').config();
const { OAuth2Client } = require('google-auth-library');
const express = require('express');
const fs = require('fs');
const path = require('path');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3001/oauth/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/spreadsheets'],
});

const app = express();

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.send('<h2>Error: no code received.</h2>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      res.send('<h2>No refresh token returned. Try revoking access at myaccount.google.com/permissions and running again.</h2>');
      return;
    }

    // Write to .env
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/,  `GOOGLE_REFRESH_TOKEN=${refreshToken}`);
    } else {
      envContent = envContent.trimEnd() + `\nGOOGLE_REFRESH_TOKEN=${refreshToken}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    console.log('\n[tabby] Refresh token saved to .env');

    res.send(`
      <html><body style="font-family:monospace;background:#0F172A;color:#22C55E;padding:40px">
        <h2>Authorization complete.</h2>
        <p>Refresh token saved to .env.</p>
        <p>You can close this tab and start the bot normally.</p>
      </body></html>
    `);

    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    console.error('Token exchange failed:', e.message);
    res.send(`<h2>Error: ${e.message}</h2>`);
  }
});

const server = app.listen(3001, () => {
  console.log('\n[tabby] Auth server ready.');
  console.log('[tabby] Opening browser...\n');
  console.log('If the browser does not open, paste this URL manually:');
  console.log('\n' + authUrl + '\n');

  // Try to open browser
  const { exec } = require('child_process');
  exec(`start "" "${authUrl}"`);
});
