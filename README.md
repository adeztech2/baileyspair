# ADEZ NEXUS Pair Site

A polished WhatsApp pairing page that generates a pairing code and a `SESSION_ID` in the `Gifted~...` format used by the ADEZ NEXUS bot.

## Important: use a persistent host for pairing

WhatsApp pairing requires a live Baileys socket for several minutes while the phone is linked. Deploy the full service on Render, Railway, or a VPS. Vercel can serve the landing page, but its serverless runtime cannot keep the WhatsApp connection alive, so `/api/pair` returns a clear platform error there instead of silently failing.

### Render deployment

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository. Render will read `render.yaml`.
3. If creating the service manually, use Node 20+, build command `npm ci`, and start command `npm start`.
4. Open the Render service URL, enter your number with country code, and copy the generated pairing code with the copy icon.
5. In WhatsApp, open **Linked devices → Link a device → Link with phone number instead** and enter the code.
6. Copy the generated session ID into the ADEZ NEXUS bot service as `SESSION_ID`, then redeploy the bot.

Pairing files live in the host's temporary `tmp/` directory and are deleted after completion. The service limits each IP to five attempts per ten minutes and allows ten active pairings.
