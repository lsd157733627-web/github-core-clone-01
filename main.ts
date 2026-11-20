// main.ts — entrypoint: bind an ephemeral port, register with the env,
// poll /done until the trial ends, then exit 0. The lifecycle the kit's
// wire contract settles; the scored surface lives in app.ts.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;
const DONE_POLL_MS = 500;
/** Stop polling after this long even if the env never says done. */
const POLL_DEADLINE_MS = 880_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitDone(): Promise<void> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() - startedAt > POLL_DEADLINE_MS) return;
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 200) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll is retried; the process never exits before done.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
  process.stdout.write(`[entry] listening on port ${port}\n`);
  await register(port);
  process.stdout.write('[entry] registered; waiting for done\n');
  await waitDone();
  process.stdout.write('[entry] done; exiting 0\n');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[entry] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
