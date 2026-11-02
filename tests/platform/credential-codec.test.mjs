import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_PREFIX,
  CREDENTIAL_UNAVAILABLE,
  CREDENTIAL_UNREADABLE,
  createSafeStorageCodec,
  isEncryptedCredential,
} from '../../desktop/credential-codec.mjs';

test('safeStorage values are wrapped in an enc:v1 envelope', () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('cipher:' + value),
    decryptString: value => value.toString().replace(/^cipher:/, ''),
  };
  const codec = createSafeStorageCodec(safeStorage);
  const encoded = codec.encode('fixture-secret');
  assert.equal(encoded.startsWith(CREDENTIAL_PREFIX), true);
  assert.equal(encoded.includes('fixture-secret'), false);
  assert.equal(isEncryptedCredential(encoded), true);
  assert.equal(codec.decode(encoded), 'fixture-secret');
});

test('plaintext legacy values are treated as unset instead of returned', () => {
  const codec = createSafeStorageCodec({
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString(),
  });
  assert.equal(codec.decode('legacy-plaintext'), null);
  assert.equal(codec.decode(null), null);
});

test('unsupported or unreadable envelopes fail with actionable messages', () => {
  const codec = createSafeStorageCodec({
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: () => { throw new Error('keychain denied'); },
  });
  assert.throws(() => codec.decode(CREDENTIAL_PREFIX + 'ciphertext'), error => error.message === CREDENTIAL_UNREADABLE);
  const unavailable = createSafeStorageCodec({
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from('x'),
    decryptString: () => 'x',
  });
  assert.throws(() => unavailable.encode('secret'), error => error.message === CREDENTIAL_UNAVAILABLE);
  assert.throws(() => createSafeStorageCodec(null), /系统凭据加密不可用/);
});
