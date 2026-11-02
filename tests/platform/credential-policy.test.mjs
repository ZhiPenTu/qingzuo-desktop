import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_MANAGE_SOURCE_ERROR,
  canManageCredentialVault,
  canRequestCredentialGrant,
  canUseCredentialVault,
  credentialVaultPermission,
  maskAppId,
} from '../../desktop/credential-policy.mjs';

test('credential vault permissions accept exactly use or manage', () => {
  assert.equal(credentialVaultPermission({ permissions: { credentialVault: 'use' } }), 'use');
  assert.equal(credentialVaultPermission({ permissions: { credentialVault: 'manage' } }), 'manage');
  assert.equal(credentialVaultPermission({ permissions: { credentialVault: 'admin' } }), null);
  assert.equal(credentialVaultPermission({ permissions: {} }), null);
  assert.equal(canUseCredentialVault({ permissions: { credentialVault: 'use' } }), true);
  assert.equal(canUseCredentialVault({ permissions: {} }), false);
});

test('management is limited to signed market or bundled plugins', () => {
  for (const source of ['market', 'bundled']) {
    assert.equal(canManageCredentialVault({ source, permissions: { credentialVault: 'manage' } }), true, source);
  }
  for (const source of ['local', 'development', undefined]) {
    assert.equal(canManageCredentialVault({ source, permissions: { credentialVault: 'manage' } }), false, String(source));
  }
  assert.equal(canManageCredentialVault({ source: 'market', permissions: { credentialVault: 'use' } }), false);
  assert.match(CREDENTIAL_MANAGE_SOURCE_ERROR, /工具市场/);
});

test('grants can only be requested by the currently visible plugin', () => {
  const consumer = { id: 'official.consumer', permissions: { credentialVault: 'use' } };
  assert.equal(canRequestCredentialGrant(consumer, consumer.id), true);
  assert.equal(canRequestCredentialGrant(consumer, 'official.other'), false);
  assert.equal(canRequestCredentialGrant(consumer, null), false);
  assert.equal(canRequestCredentialGrant({ id: 'local.none', permissions: {} }, 'local.none'), false);
});

test('app IDs are masked without exposing short identifiers', () => {
  assert.equal(maskAppId('APP-12345678'), '••••5678');
  assert.equal(maskAppId('abc'), '••••');
  assert.equal(maskAppId(null), '••••');
});
