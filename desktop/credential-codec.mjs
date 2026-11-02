export const CREDENTIAL_PREFIX = 'enc:v1:';
export const CREDENTIAL_UNAVAILABLE = '系统凭据加密不可用，暂时无法保存密钥。';
export const CREDENTIAL_UNREADABLE = '无法读取已保存的密钥，请重新填写。';

export function isEncryptedCredential(value) {
  return typeof value === 'string' && value.startsWith(CREDENTIAL_PREFIX);
}

// Values are encrypted in the main process before they reach the credential
// launcher, so neither the macOS vault file nor Credential Manager receives
// plaintext. Legacy plaintext entries deliberately decode to null: this release
// invalidates old secrets and asks the user to enter them again.
export function createSafeStorageCodec(safeStorage) {
  if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new Error('系统凭据加密不可用。');
  }
  return Object.freeze({
    encode(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(CREDENTIAL_UNAVAILABLE);
      return CREDENTIAL_PREFIX + safeStorage.encryptString(value).toString('base64');
    },
    decode(stored) {
      if (!isEncryptedCredential(stored)) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(CREDENTIAL_PREFIX.length), 'base64'));
      } catch {
        throw new Error(CREDENTIAL_UNREADABLE);
      }
    },
  });
}
