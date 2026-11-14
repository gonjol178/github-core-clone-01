// Entrypoint. The forge binds an ephemeral port, tells the environment
// where it landed, then waits until the environment says the trial is done
// before closing down. Port 8080 is never touched: the environment assigns
// nothing and expects the entry to pick its own port and report it.

import { createForgeServer } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  console.error('MAKEFUN_ENV_URL is not set; nowhere to register');
  process.exit(1);
}
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const server = createForgeServer(token);
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
if (port === 0) {
  console.error('the server did not bind a port');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Register: 200 means this entry owns the slot. 409 means another entry won
// it, which is not fatal — the trial still ends through the done poll. Any
// other 4xx the environment calls permanent (400/405) ends the run at once.
let registered = false;
for (let attempt = 0; !registered; attempt += 1) {
  try {
    const res = await fetch(`${envBase}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (res.status === 200) {
      registered = true;
    } else if (res.status === 409) {
      registered = true; // slot lost; fall through to the done poll
    } else if (res.status === 400 || res.status === 405) {
      console.error(`registration refused permanently: HTTP ${res.status}`);
      process.exit(1);
    }
  } catch {
    // The environment is not answering yet; back off and try again.
  }
  if (!registered) await sleep(Math.min(250 * 2 ** Math.min(attempt, 3), 2000));
}

// Poll until the environment reports the trial is done, with the same
// growing backoff, then close the server and exit cleanly.
for (let attempt = 0; ; attempt += 1) {
  let done = false;
  try {
    const res = await fetch(`${envBase}/done`);
    if (res.ok) {
      const payload = (await res.json()) as { done?: unknown };
      done = payload.done === true;
    }
  } catch {
    // Not reachable yet; keep waiting.
  }
  if (done) break;
  await sleep(Math.min(250 * 2 ** Math.min(attempt, 3), 2000));
}

await new Promise<void>((resolve) => {
  server.close(() => resolve());
});
process.exit(0);
