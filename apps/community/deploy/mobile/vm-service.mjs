import { pathToFileURL } from 'node:url';
import { createServer, listenServer } from './service.mjs';
import { VMPool, vmConfiguration } from './vm-pool.mjs';
import { createVMRuntime } from './vm-runtime.mjs';

// The host exposes only this authenticated Unix socket. Each Android runtime
// remains behind a separate VM and a room-specific private broker credential.
export async function startVMBroker({ config, runtime, request, now, pause, log = console.log }) {
  if (!config?.socket) throw new Error('The host VM broker requires a private Unix socket');
  const pool = new VMPool(config, { runtime, request, now, pause });
  await pool.initialize();
  const server = createServer(pool, config.token);
  await listenServer(server, config);
  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try { await pool.sweepIdle(); }
    catch { console.error(JSON.stringify({ event: 'mobile_vm_sweep_failed' })); }
    finally { sweeping = false; }
  }, 30_000);
  timer.unref();
  log(JSON.stringify({ event: 'mobile_vm_broker_ready', maxSlots: config.maxSlots, maxRunning: config.maxRunning }));
  const close = () => {
    clearInterval(timer);
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return { pool, server, close };
}

export async function main() {
  const config = vmConfiguration();
  const service = await startVMBroker({ config, runtime: createVMRuntime() });
  const shutdown = () => {
    service.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Mobile VM broker startup failed. Check its private configuration and runtime.');
    process.exitCode = 1;
  });
}
