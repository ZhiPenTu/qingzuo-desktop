import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

test('kernel host reports a missing startup module through IPC instead of exiting before init', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'commerce-kernel-missing-'));
  let child;
  try {
    const entry = path.join(temporary, 'kernel-host.mjs');
    await cp(new URL('../../desktop/kernel-host.mjs', import.meta.url), entry);
    await cp(new URL('../../desktop/kernel-lifecycle.mjs', import.meta.url), path.join(temporary, 'kernel-lifecycle.mjs'));
    child = fork(entry, [], { cwd: temporary, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const reply = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.send({ type: 'init', options: {} });
    const [message] = await reply;
    assert.equal(message.type, 'fatal');
    assert.match(message.error, /Cannot find module.*kernel\.mjs/);
    assert.equal(child.exitCode, null);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
