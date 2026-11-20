# ADEZ NEXUS Pair Site

Generates a pairing code and a `SESSION_ID` (`Gifted~...`) for the ADEZ NEXUS bot.

## Vercel
1. Push this folder to GitHub, import it in Vercel (Framework: Other, no build command).
2. Project Settings > Functions: make sure Fluid Compute is on (needed for the 300s limit in vercel.json).
3. Deploy, open the site, pair.

## Render / any Node host
Build `npm install`, start `npm start`.

## Options
`PAIR_BROWSER` = safari (default) | chrome | edge. Try chrome if WhatsApp refuses to link.
Nothing is stored; temp files live in /tmp only while pairing.
