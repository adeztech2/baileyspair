// Self-ping so Render's free plan doesn't spin the pairing site down after 15 min idle.
// URL: APP_URL > RENDER_EXTERNAL_URL (Render sets it automatically).
const INTERVAL_MS = (parseInt(process.env.KEEP_ALIVE_MINUTES) || 4) * 60_000;

export function startKeepAlive() {
  const base = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.log('Keep-alive off (set APP_URL to your public URL to enable)');
    return;
  }
  const target = `${base}/health`;
  console.log(`Keep-alive pinging ${target} every ${INTERVAL_MS / 60_000} min`);

  const ping = async () => {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) console.log(`Keep-alive got HTTP ${res.status}`);
    } catch (e) {
      console.log(`Keep-alive failed: ${e.message}`);
    }
  };

  setInterval(ping, INTERVAL_MS).unref?.();
}
