const channel = process.parentPort ?? process;
const send = message => process.parentPort ? channel.postMessage(message) : process.send?.(message);
const pending = new Map(); let counter = 0, runtime;
function invoke(service, method, args) { return new Promise((resolve, reject) => { const id = ++counter; pending.set(id, { resolve, reject }); send({ type: 'invoke', id, service, method, args }); }); }
channel.on('message', async event => {
  const message = process.parentPort ? event.data : event;
  if (message.type === 'init') {
    try {
      const { bootCommerceKernel } = await import('./kernel.mjs');
      runtime = await bootCommerceKernel({ ...message.options, invoke });
      const { Logger } = await import('@deepseek-ai/cordis');
      runtime.ctx.logger.exporter({
        levels: { default: 3 },
        colors: false,
        maxLength: 16 * 1024,
        export: message => {
          try {
            send({
              type: 'log',
              entry: {
                time: message.ts,
                scope: 'app',
                source: 'harness/' + message.name,
                level: message.type,
                message: Logger.format({ colors: false, maxLength: 16 * 1024 }, message),
              },
            });
          } catch {}
        },
      });
      send({ type: 'ready', systems: [...runtime.systems.values()].map(({ id, title, protected: protectedFlag }) => ({ id, title, protected: protectedFlag })) });
    }
    catch (error) { send({ type: 'fatal', error: error.message }); }
  } else if (message.type === 'result') { const p = pending.get(message.id); pending.delete(message.id); if (message.error) p?.reject(new Error(message.error)); else p?.resolve(message.result); }
  else if (message.type === 'call' || message.type === 'sync') {
    try { const result = message.type === 'sync' ? await runtime.reconcile(message.plugins) : await runtime.call(message.kind, message.service, message.method, message.args, message.caller); send({ type: 'reply', id: message.id, result }); }
    catch(error) { send({ type: 'reply', id: message.id, error: error.message }); }
  }
  else if (message.type === 'shutdown') { await runtime?.dispose(); process.exit(0); }
});
