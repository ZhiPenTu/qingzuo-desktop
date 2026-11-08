import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FIRST_PARTY_ASSISTANT,
  FIRST_PARTY_DIAGNOSTICS,
  assertFirstPartyAccess,
  firstPartyRule,
} from '../../desktop/first-party.mjs';
import { FirstPartyGrants } from '../../desktop/first-party-grants.mjs';

const digest = 'a'.repeat(64);
const trusted = (id = FIRST_PARTY_ASSISTANT) => ({
  id,
  title: 'Trusted',
  version: '1.0.0',
  api: '^1.10.0',
  artifactSha256: digest,
  source: 'market',
  tier: 'platform',
  enabled: true,
  missing: [],
});

test('first-party access requires the exact plugin, market source, platform tier, and host allowlist', () => {
  const plugin = trusted();
  assert.deepEqual(firstPartyRule(plugin.id, 'firstParty.assistant.settings.beginTextSetup'), {
    namespace: 'firstParty.assistant.settings',
    operation: 'beginTextSetup',
  });
  assert.equal(firstPartyRule(plugin.id, 'firstParty.assistant.settings.approve'), null);
  assert.equal(firstPartyRule(plugin.id, 'firstParty.assistant.chat.send'), null);
  assert.doesNotThrow(() => assertFirstPartyAccess(plugin, 'firstParty.assistant.settings.status'));
  assert.throws(() => assertFirstPartyAccess(plugin, 'firstParty.assistant.chat.send'), /未授权/);
  for (const changed of [
    { source: 'local' },
    { tier: 'official' },
    { tier: 'community' },
    { enabled: false },
    { missing: ['workspace'] },
    { id: 'community.ai-assistant' },
  ]) {
    assert.throws(() => assertFirstPartyAccess({ ...plugin, ...changed }, 'firstParty.assistant.settings.status'), /未授权|不可用/);
  }
  assert.doesNotThrow(() => assertFirstPartyAccess(trusted(FIRST_PARTY_DIAGNOSTICS), 'firstParty.diagnostics.recent'));
  assert.throws(() => assertFirstPartyAccess(trusted(FIRST_PARTY_DIAGNOSTICS), 'firstParty.diagnostics.clear'), /未授权/);
});

test('diagnostic grants bind plugin version, artifact digest, API range, and capability', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-first-party-grants-'));
  try {
    const plugin = trusted(FIRST_PARTY_DIAGNOSTICS);
    const grants = new FirstPartyGrants({ root, now: () => 1234 });
    await grants.initialize();
    assert.equal(grants.status(plugin, 'logs'), false);
    let confirmations = 0;
    assert.equal(await grants.ensure(plugin, 'logs', async () => { confirmations += 1; return true; }), true);
    assert.equal(await grants.ensure(plugin, 'logs', async () => { confirmations += 1; return true; }), true);
    assert.equal(confirmations, 1);

    const restarted = new FirstPartyGrants({ root });
    await restarted.initialize();
    assert.equal(restarted.status(plugin, 'logs'), true);
    assert.equal(restarted.status({ ...plugin, version: '1.0.1' }, 'logs'), false);
    assert.equal(restarted.status({ ...plugin, artifactSha256: 'b'.repeat(64) }, 'logs'), false);
    assert.equal(restarted.status({ ...plugin, api: '^2.0.0' }, 'logs'), false);
    assert.equal(restarted.status(plugin, 'other'), false);

    await restarted.ensure({ ...plugin, version: '1.0.1' }, 'logs', async () => true);
    assert.equal(restarted.status({ ...plugin, version: '1.0.1' }, 'logs'), true);
    assert.equal(restarted.status(plugin, 'logs'), false);
    assert.equal(await restarted.revokePlugin(plugin.id), true);
    assert.equal(restarted.status({ ...plugin, version: '1.0.1' }, 'logs'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
