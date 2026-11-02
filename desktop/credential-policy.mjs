const MANAGE_SOURCES = new Set(['market', 'bundled']);

export const CREDENTIAL_MANAGE_SOURCE_ERROR = '请从工具市场安装后使用凭证管理。';
export const CREDENTIAL_GRANT_ERROR = '请先在凭证管理中授权这个工具使用该凭证。';
export const CREDENTIAL_VISIBLE_ERROR = '请在插件界面中完成凭证授权。';
export const CREDENTIAL_RECORD_MISSING = '凭证已删除，请重新选择。';
export const CREDENTIAL_SECRET_MISSING = '无法读取已保存的密钥，请重新填写。';

export function credentialVaultPermission(plugin) {
  const value = plugin?.permissions?.credentialVault;
  return value === 'use' || value === 'manage' ? value : null;
}

export function canUseCredentialVault(plugin) {
  return credentialVaultPermission(plugin) !== null;
}

export function canManageCredentialVault(plugin) {
  return credentialVaultPermission(plugin) === 'manage' && MANAGE_SOURCES.has(plugin?.source);
}

export function canRequestCredentialGrant(plugin, visibleId) {
  return canUseCredentialVault(plugin) && visibleId === plugin?.id;
}

export function maskAppId(value) {
  const text = String(value ?? '');
  return text.length <= 4 ? '••••' : '••••' + text.slice(-4);
}
