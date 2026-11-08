export const SHUTDOWN_TIMEOUT_MS = 5000;

// One controller owns the whole kernel process lifecycle: it is created before
// the first await so signals that arrive during profile preparation still wait
// for the tree to settle instead of falling through to the default handler.
export function createKernelLifecycle({ timeoutMs = SHUTDOWN_TIMEOUT_MS, exit = code => process.exit(code) } = {}) {
  let teardown;
  let closing;
  let settled = false;
  let settleBoot;
  const booted = new Promise(resolve => { settleBoot = resolve; });
  const markBooted = () => {
    if (settled) return;
    settled = true;
    settleBoot();
  };
  const setTeardown = fn => { teardown = fn; };
  const dispose = () => closing ??= booted.then(() => teardown ? teardown() : undefined);
  let pending;
  let forced = false;
  const shutdown = code => {
    if (pending) return pending;
    const timer = setTimeout(() => { forced = true; exit(code); }, timeoutMs);
    pending = dispose().catch(() => {}).then(() => {
      if (!forced) { clearTimeout(timer); exit(code); }
    });
    return pending;
  };
  const interrupt = code => {
    if (pending) { forced = true; exit(code); return; }
    return shutdown(code);
  };
  const install = (proc = process) => {
    const onTerminate = () => void shutdown(0);
    const onInterrupt = () => void interrupt(130);
    proc.on('SIGTERM', onTerminate);
    proc.on('SIGINT', onInterrupt);
    return () => {
      proc.off('SIGTERM', onTerminate);
      proc.off('SIGINT', onInterrupt);
    };
  };
  return { booted, markBooted, setTeardown, dispose, shutdown, interrupt, install };
}
