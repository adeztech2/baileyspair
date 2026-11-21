<h1 align="center">ADEZ NEXUS Pair Site</h1>

<p align="center">Generates a pairing code and a <code>SESSION_ID</code> (<code>ADEZ~...</code>) for the ADEZ NEXUS bot.</p>

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/adeztech2/baileyspair">
    <img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render">
  </a>
  &nbsp;
  <a href="https://vercel.com/new/clone?repository-url=https://github.com/adeztech2/baileyspair">
    <img src="https://vercel.com/button" alt="Deploy with Vercel">
  </a>
</p>

## How to use

1. Open the site and enter your WhatsApp number with country code.
2. Enter the pairing code in WhatsApp under **Linked devices**.
3. Copy the `SESSION_ID` the site gives you and set it on your bot host.

> Keep your SESSION_ID private. Anyone with it can control your WhatsApp account.

## Deploy

### Render
Click **Deploy to Render**, or choose **New → Blueprint** and pick this repo. `render.yaml` sets everything up: build `npm ci`, start `npm start`, health check `/health`.

The site pings its own `/health` route every 4 minutes so the free plan doesn't spin it down. Render supplies the URL automatically. For a custom domain, set `APP_URL`.

### Vercel
1. Push this folder to GitHub and import it in Vercel (Framework: Other, no build command).
2. Project Settings > Functions: make sure Fluid Compute is on (needed for the 300s limit in `vercel.json`).
3. Deploy, open the site, pair.

Keep-alive is not used on Vercel.

### Any Node host
Build `npm install`, start `npm start`.

## Options

| Variable | Description |
| --- | --- |
| `PAIR_BROWSER` | `safari` (default), `chrome` or `edge`. Try `chrome` if WhatsApp refuses to link |
| `APP_URL` | Public URL for keep-alive. Only needed with a custom domain |
| `KEEP_ALIVE_MINUTES` | Keep-alive ping interval, default `4` |
| `PORT` | Set by the host, default `3000` |

Nothing is stored. Temp files live in `/tmp` only while pairing.

<p align="center">POWERED BY ADEZ TECH</p>
