// One request does the whole pairing and streams progress back (NDJSON):
//   {type:'code', code}  ->  {type:'linked'}  ->  {type:'session', session}  |  {type:'error', message}
// Works on Vercel (single long-running function) and on a normal Node server (see server.js).
import pino from 'pino';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore
} from 'gifted-baileys';

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TOTAL_TIMEOUT = 270_000;     // stay under Vercel's 300s function limit

// Browser identity shown in WhatsApp > Linked devices. Default Safari.
// If linking keeps failing, set PAIR_BROWSER=chrome in the project's environment variables.
const BROWSERS = {
  safari: ['Mac OS', 'Safari', '17.5.1'],
  chrome: ['Ubuntu', 'Chrome', '22.04.4'],
  edge:   ['Windows', 'Edge', '124.0.0']
};
const BROWSER = BROWSERS[(process.env.PAIR_BROWSER || 'safari').toLowerCase()] || BROWSERS.safari;

// If WhatsApp refuses a connection (405), retry with the next identity in this list.
const CONFIGS = [
  { browser: BROWSER,                          fetched: true  },
  { browser: BROWSERS.chrome,                  fetched: true  },
  { browser: ['Mac OS', 'Chrome', '14.4.1'],   fetched: false },
  { browser: BROWSERS.chrome,                  fetched: false }
];

let _version = null, _versionAt = 0;
async function getVersion() {
  if (_version && Date.now() - _versionAt < 3_600_000) return _version;
  try {
    const r = await Promise.race([fetchLatestWaWebVersion(), sleep(4000).then(() => null)]);
    if (r?.version) { _version = r.version; _versionAt = Date.now(); }
  } catch {}
  return _version || undefined;    // undefined = library's built-in version
}

const hits = new Map();            // per-instance rate limit
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 10;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket?.remoteAddress || 'x';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const number = String(body?.number || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ error: 'Enter your number with country code, digits only. Example: 254111783552' });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const emit = (o) => { try { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); } catch {} };
  emit({ type: 'start' });

  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(os.tmpdir(), 'nexus-pair-' + id);   // /tmp is the only writable place on Vercel
  fs.mkdirSync(dir, { recursive: true });

  let sock = null, over = false, hasCode = false, linked = false;
  let finish;
  const finished = new Promise(r => { finish = r; });
  const stop = (message) => {
    if (over) return;
    over = true;
    if (message) emit({ type: 'error', message });
    finish();
  };

  res.on('close', () => { if (!res.writableFinished) { over = true; finish(); } });   // visitor left
  const timer = setTimeout(() => stop('Pairing timed out. Start again for a new code.'), TOTAL_TIMEOUT);

  async function complete(s) {
    try {
      await sleep(2500);                                   // let creds.json finish writing
      const raw = fs.readFileSync(path.join(dir, 'creds.json'));
      const session = 'ADEZ~' + zlib.gzipSync(raw).toString('base64');
      emit({ type: 'session', session });
      const me = s.user?.id?.split(':')[0]?.split('@')[0] || number;
      try {
        const jid = me + '@s.whatsapp.net';
        await s.sendMessage(jid, { text: session });
        await s.sendMessage(jid, { text: '✅ *ADEZ NEXUS session created*\n\nCopy the message above and set it as SESSION_ID for your bot.\n\n⚠️ Never share this code. Anyone with it controls your WhatsApp.' });
      } catch (e) { console.error('DM failed:', e.message); }
      await sleep(2500);
      over = true; finish();                               // no logout: that would kill the session
    } catch (e) {
      stop('Linked, but the session could not be created. Please try again.');
    }
  }

  async function start(first, idx = 0) {
    const cfg = CONFIGS[idx];
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const version = cfg.fetched ? await getVersion() : undefined;
    console.log(`[${id}] try ${idx + 1}/${CONFIGS.length} browser=${cfg.browser.join('/')} version=${version ? version.join('.') : 'built-in'}`);
    const s = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      syncFullHistory: false,
      logger,
      browser: cfg.browser,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000
    });
    sock = s;
    s.ev.on('creds.update', saveCreds);

    let asked = false;
    const ask = async () => {
      if (!first || asked || hasCode || over || s.authState.creds.registered) return;
      asked = true;
      try {
        const raw = await s.requestPairingCode(number);
        hasCode = true;
        emit({ type: 'code', code: raw.replace(/(.{4})(?=.)/, '$1-') });
      } catch (e) {
        console.error('requestPairingCode failed:', e.message);
        stop('Could not get a pairing code from WhatsApp. Check the number (country code, digits only) and try again.');
      }
    };
    const fallback = setTimeout(ask, 6000);                // in case no qr event arrives

    s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) ask();
      if (connection === 'open') {
        clearTimeout(fallback);
        if (linked) return;
        linked = true;
        emit({ type: 'linked' });
        await complete(s);
      } else if (connection === 'close') {
        clearTimeout(fallback);
        if (over || linked) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[${id}] closed code=${code} hasCode=${hasCode}`);
        if (code === DisconnectReason.restartRequired) {
          // WhatsApp asks for a restart right after the code is accepted
          try { await start(false, idx); } catch { stop('Connection failed after linking. Please try again.'); }
        } else if (!hasCode && idx + 1 < CONFIGS.length) {
          // refused before we had a code (usually 405): wipe and retry with the next identity
          try {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            await start(true, idx + 1);
          } catch { stop('Could not reach WhatsApp. Please try again.'); }
        } else if (code === 405) {
          stop('WhatsApp refused the connection (405) on every attempt. Wait a minute and try again. If it keeps happening, this host\'s IP is probably being blocked.');
        } else if (code === DisconnectReason.loggedOut) {
          stop('WhatsApp rejected the link (code 401). Wait a minute, then try again.');
        } else {
          stop(`The connection dropped (code ${code ?? 'unknown'}). Start again for a new code.`);
        }
      }
    });
  }

  try {
    await start(true);
    await finished;
  } catch (e) {
    console.error('pair error:', e.message);
    stop('Could not start pairing. Please try again.');
  }

  clearTimeout(timer);
  try { sock?.ev.removeAllListeners(); sock?.end(undefined); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { res.end(); } catch {}
          }
