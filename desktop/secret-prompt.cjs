const { ipcRenderer } = require('electron');

const elements = {};
const read = id => document.getElementById(id);

function setText(id, value) {
  read(id).textContent = value;
}

ipcRenderer.on('commerce:secret-prompt:config', (_event, config) => {
  elements.secret = read('secret');
  elements.error = read('error');
  document.title = config.title || '输入访问密钥';
  setText('title', config.title || '输入访问密钥');
  setText('message', config.message || '');
  setText('detail', config.detail || '');
  read('detail').hidden = !config.detail;
  setText('label', config.label || '访问密钥');
  setText('submit', config.confirmLabel || '保存');
  elements.secret.value = '';
  elements.secret.focus();
});

ipcRenderer.on('commerce:secret-prompt:invalid', () => {
  elements.error.textContent = '请输入有效的访问密钥。';
  elements.secret.focus();
});

document.addEventListener('DOMContentLoaded', () => {
  read('form').addEventListener('submit', event => {
    event.preventDefault();
    ipcRenderer.send('commerce:secret-prompt:submit', read('secret').value);
  });
  read('cancel').addEventListener('click', () => ipcRenderer.send('commerce:secret-prompt:cancel'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') ipcRenderer.send('commerce:secret-prompt:cancel');
  });
});
