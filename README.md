# ADEZ NEXUS Pair Site

Generates a pairing code and a `SESSION_ID` (format `Gifted~...`) that the ADEZ NEXUS bot loads at startup.

## Deploy on Render
1. Push this folder to a new GitHub repo.
2. Render, New, Web Service, pick the repo.
3. Build command: `npm install`  Start command: `npm start`  (Node 20+)
4. Open the site, enter your number with country code, type the code in WhatsApp (Linked devices, Link with phone number).
5. Copy the session ID (it is also sent to your own WhatsApp chat) and set it as `SESSION_ID` on the bot service. Redeploy.

Notes: nothing is stored. Pairing files live in `tmp/` only while pairing and are deleted afterwards. Limits: 5 attempts per IP per 10 minutes, 10 pairings at once.
