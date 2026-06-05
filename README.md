# Deriv AI CFD AutoBot — Server Edition

## Deploy to Railway (Free)

### Step 1 — GitHub
1. Go to github.com → New repository → name it `deriv-ai-bot`
2. Upload all these files into it

### Step 2 — Railway
1. Go to railway.app → Login with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `deriv-ai-bot` repo → Deploy

### Step 3 — Environment Variables (in Railway dashboard)
Click your service → **Variables** tab → Add:

| Variable        | Value         | Description              |
|----------------|---------------|--------------------------|
| DERIV_TOKEN    | your_token    | Your Deriv API token     |
| STAKE          | 1.00          | $ per trade              |
| MULTIPLIER     | 100           | Deriv multiplier (100–800)|
| SL_PIPS        | 20            | Stop loss in pips        |
| TP_PIPS        | 40            | Take profit in pips      |
| MAX_DAILY_LOSS | 3.00          | Max $ loss before stop   |
| MAX_OPEN       | 2             | Max simultaneous trades  |
| SCAN_INTERVAL  | 30            | Seconds between scans    |
| MIN_SCORE      | 62            | Min AI confidence %      |

### Step 4 — Get your URL
Railway gives you a public URL like:
`https://deriv-ai-bot-production.up.railway.app`

Open that URL → Dashboard loads → Bot is already running!

### OR — Start from Dashboard
Leave DERIV_TOKEN blank in env vars,
open the URL, paste your token in the form, click START.

## Files
- `bot.js`       — Main bot + Express server
- `public/index.html` — Web dashboard
- `package.json` — Dependencies
- `railway.json` — Railway config
- `logs/trades.log` — Auto-created trade log
