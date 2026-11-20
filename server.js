import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import pino from 'pino';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore
} from 'gifted-baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vercel's deployed bundle is read-only. Use its writable temporary directory
// for pairing state, while keeping ./tmp for local development.
const TMP = process.env.VERCEL
  ? path.join(process.env.TMPDIR || '/tmp', 'adez-nexus-pair')
  : path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const PORT = parseInt(process.env.PORT || '3000');
const MAX_JOBS = 10;               // simultaneous pairings
const JOB_TTL = 4 * 60_000;        // give up after 4 minutes
const RESULT_TTL = 10 * 60_000;    // keep a finished session for 10 minutes
const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();            // id -> job
const hits = new Map();            // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;          // 5 attempts per 10 minutes per IP
}

function destroy(job) {
  clearTimeout(job.timer);
  try { job.sock?.ev.removeAllListeners(); job.sock?.end(undefined); } catch {}
  try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
}

function fail(job, message) {
  if (job.status === 'done') return;
  job.status = 'error';
  job.error = message;
  destroy(job);
  setTimeout(() => jobs.delete(job.id), 60_000);
}

async function finish(job) {
  if (job.finishing) return;
  job.finishing = true;
  try {
    await sleep(2500);             // let creds.json finish writing
    const raw = fs.readFileSync(path.join(job.dir, 'creds.json'));
    const session = 'Gifted~' + zlib.gzipSync(raw).toString('base64');
    job.session = session;
    job.status = 'done';

    const me = job.sock.user?.id?.split(':')[0]?.split('@')[0] || job.number;
    const jid = me + '@s.whatsapp.net';
    try {
      await job.sock.sendMessage(jid, { text: session });
      await job.sock.sendMessage(jid, {
        text: '✅ *ADEZ NEXUS session created*\n\nCopy the message above and paste it as SESSION_ID in your Render environment variables.\n\n⚠️ Never share this code. Anyone with it controls your WhatsApp.'
      });
    } catch (e) {
      console.error('Could not DM session:', e.message);
    }
    await sleep(3000);
  } catch (e) {
    fail(job, 'Linked, but the session could not be created. Please try again.');
    return;
  }
  destroy(job);                    // note: no logout, that would kill the session
  setTimeout(() => jobs.delete(job.id), RESULT_TTL);
}

async function startSocket(job, first) {
  const { state, saveCreds } = await useMultiFileAuthState(job.dir);
  let version;
  try { ({ version } = await fetchLatestWaWebVersion()); } catch {}

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    syncFullHistory: false,
    logger,
    browser: ['Mac OS', 'Safari', '17.5.1'],
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 25_000
  });
  job.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      job.status = 'linked';
      finish(job);
    } else if (connection === 'close' && job.status !== 'done' && job.status !== 'error') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.restartRequired) {
        // WhatsApp asks for a restart right after the code is accepted
        try { await startSocket(job, false); } catch { fail(job, 'Connection failed. Please try again.'); }
      } else if (job.status === 'linked') {
        // closed after linking, finish() handles it
      } else {
        fail(job, 'Connection closed before linking. Please try again.');
      }
    }
  });

  if (first && !sock.authState.creds.registered) {
    await sleep(2000);
    const code = await sock.requestPairingCode(job.number);
    job.code = code;
  }
}

app.post('/api/pair', async (req, res) => {
  if (process.env.VERCEL) {
    return res.status(503).json({
      error: 'WhatsApp pairing needs a persistent server. Deploy this service on Render, Railway, or a VPS, then open that service URL.'
    });
  }
  const ip = req.ip;
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });

  const number = String(req.body?.number || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ error: 'Enter your number with country code, digits only. Example: 254111783552' });
  }
  if (jobs.size >= MAX_JOBS) return res.status(503).json({ error: 'The pairing server is busy. Try again in a minute.' });

  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, number, status: 'waiting', dir: path.join(TMP, id), code: null, session: null, error: null };
  fs.mkdirSync(job.dir, { recursive: true });
  job.timer = setTimeout(() => fail(job, 'Pairing timed out. Start again for a new code.'), JOB_TTL);
  jobs.set(id, job);

  try {
    await startSocket(job, true);
    const pretty = job.code?.replace(/(.{4})(?=.)/, '$1-');
    res.json({ id, code: pretty });
  } catch (e) {
    console.error('pair error:', e.message);
    fail(job, 'Could not get a pairing code. Check the number and try again.');
    res.status(500).json({ error: 'Could not get a pairing code. Check the number and try again.' });
  }
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: 'expired' });
  res.json({ status: job.status, session: job.status === 'done' ? job.session : undefined, error: job.error || undefined });
});

app.get('/health', (_req, res) => res.json({ ok: true, active: jobs.size, pairingAvailable: !process.env.VERCEL }));

// Vercel imports the default export as a serverless handler. Start a listener
// only when running the project directly with `npm start`.
export default app;
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`ADEZ NEXUS pair site running on port ${PORT}`));
}
