export const MAX_SNAPSHOT_NODES = 800;
export const MAX_SCANNED_ELEMENTS = 20000;
export const ACTIONS = ['click', 'type', 'select', 'scroll', 'hover'];
const REF_PATTERN = /^qz-\d{1,7}$/;

export function assertRef(ref) {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) throw new Error('页面元素标识无效。');
  return ref;
}

export function validateAction(input = {}) {
  const action = input.action;
  if (!ACTIONS.includes(action)) throw new Error('页面操作不受支持。');
  if (action === 'scroll') {
    const offset = Number(input.value);
    if (!Number.isFinite(offset) || Math.abs(offset) > 20000) throw new Error('滚动距离无效。');
    return { action, value: Math.round(offset) };
  }
  const ref = assertRef(input.ref);
  if (action === 'click' || action === 'hover') return { action, ref };
  if (typeof input.value !== 'string' || input.value.length > 2000) throw new Error('输入内容无效。');
  return { action, ref, value: input.value };
}

export function validateWait(input = {}) {
  const selector = typeof input.selector === 'string' && input.selector.trim() ? input.selector.trim() : null;
  const text = typeof input.text === 'string' && input.text.trim() ? input.text.trim().slice(0, 200) : null;
  if (!selector && !text) throw new Error('等待条件无效。');
  if (selector && selector.length > 400) throw new Error('等待条件无效。');
  if (selector && /[{}\\<>]/.test(selector)) throw new Error('等待条件无效。');
  const timeoutMs = Math.min(60000, Math.max(1000, Number(input.timeoutMs) || 15000));
  return { selector, text, absent: input.absent === true, timeoutMs };
}

export function buildSnapshotScript({ maxNodes = MAX_SNAPSHOT_NODES, maxScanned = MAX_SCANNED_ELEMENTS } = {}) {
  return `(() => {
  const MAX_NODES = ${Number(maxNodes)};
  const MAX_SCANNED = ${Number(maxScanned)};
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'HEAD', 'META', 'LINK', 'OBJECT', 'EMBED', 'CANVAS', 'AUDIO', 'SOURCE']);
  const root = document.documentElement;
  if (!root) return { nodes: [], truncated: false, scanned: 0 };
  let sequence = Number(root.dataset.qzRefSeq || 0);
  if (!Number.isFinite(sequence) || sequence < 0 || sequence > 9000000) sequence = 0;
  const nodes = [];
  let truncated = false, scanned = 0;

  const roleOf = (element, tag) => {
    const explicit = (element.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit;
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td' || tag === 'th') return 'cell';
    if (tag === 'li') return 'listitem';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
    if (tag === 'label') return 'label';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return 'generic';
  };

  const nameOf = element => {
    const attributes = ['aria-label', 'placeholder', 'alt', 'title', 'name'];
    for (const key of attributes) {
      const value = element.getAttribute(key);
      if (value && value.trim()) return value.replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = document.getElementById(labelledBy.split(' ')[0]);
      const text = label && label.textContent;
      if (text && text.trim()) return text.replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    if (element.id) {
      const label = document.querySelector('label[for="' + element.id.replace(/"/g, '') + '"]');
      const text = label && label.textContent;
      if (text && text.trim()) return text.replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    const text = element.textContent;
    return text && text.trim() ? text.replace(/\\s+/g, ' ').trim().slice(0, 200) : '';
  };

  // Media and link addresses are needed to collect a product page, while page
  // markup, cookies and form state must stay in the page. Only absolute web
  // URLs are exposed and everything else (data:, blob:, javascript:) is dropped.
  const addressOf = element => {
    const raw = element.currentSrc || element.href || element.src || '';
    if (!raw) return '';
    try {
      const url = new URL(raw, document.baseURI);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.href.slice(0, 2000);
    } catch { return ''; }
  };

  const interesting = (element, tag) => {
    if (['a', 'button', 'input', 'select', 'textarea', 'img', 'video', 'label'].includes(tag)) return true;
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'li'].includes(tag)) return true;
    if (element.hasAttribute('role') || element.hasAttribute('aria-label') || element.hasAttribute('tabindex') || element.isContentEditable) return true;
    if (element.getAttribute('data-spm') || element.getAttribute('data-testid') || element.getAttribute('data-e2e')) return true;
    if (!element.firstElementChild) {
      const text = element.textContent;
      return Boolean(text && text.trim());
    }
    return false;
  };

  const forbidden = element => {
    if (element.tagName !== 'INPUT') return false;
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden' || type === 'password' || type === 'file') return true;
    const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
    return autocomplete.includes('password');
  };

  const walker = document.createTreeWalker(document.body || root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (SKIP.has(node.tagName)) return NodeFilter.FILTER_REJECT;
      if (node.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let element = walker.currentNode;
  while (element && scanned < MAX_SCANNED) {
    scanned += 1;
    const tag = element.tagName.toLowerCase();
    if (nodes.length >= MAX_NODES) { truncated = true; break; }
    if (!forbidden(element) && interesting(element, tag)) {
      const style = getComputedStyle(element);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0) {
        const rect = element.getBoundingClientRect();
        if (rect.width >= 1 && rect.height >= 1) {
          let ref = element.getAttribute('data-qz-ref');
          if (!ref || !/^qz-[0-9]{1,7}$/.test(ref)) { sequence += 1; ref = 'qz-' + sequence; element.setAttribute('data-qz-ref', ref); }
          const value = ('value' in element && typeof element.value === 'string') ? element.value.slice(0, 2000) : '';
          const node = { ref, role: roleOf(element, tag), name: nameOf(element), value, visible: true, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
          if (tag === 'input') node.checked = Boolean(element.checked);
          if (tag === 'img' || tag === 'a') { const address = addressOf(element); if (address) node.url = address; }
          nodes.push(node);
        }
      }
    }
    element = walker.nextNode();
  }
  root.dataset.qzRefSeq = String(sequence);
  return { nodes, truncated, scanned };
})()`;
}

export function buildActionScript(input) {
  const value = JSON.stringify(input.value ?? '');
  const ref = JSON.stringify(String(input.ref ?? ''));
  const offset = JSON.stringify(Number(input.value ?? 0));
  const body = {
    click: `const target = element.closest('a,button,input,label,[role="button"],[role="link"]') || element;
      target.focus && target.focus();
      target.click();
      return { ok: true };`,
    type: `element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus && element.focus();
      if (element.isContentEditable) {
        element.textContent = VALUE;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: VALUE, inputType: 'insertText' }));
      } else {
        const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(element, VALUE); else element.value = VALUE;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: String(element.value || element.textContent || '').slice(0, 2000) };`,
    select: `if (element.tagName !== 'SELECT') return { ok: false, reason: 'not-select' };
      const options = Array.from(element.options || []);
      const match = options.find(option => option.value === VALUE) || options.find(option => (option.text || '').trim() === VALUE);
      if (!match) return { ok: false, reason: 'option-missing' };
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, match.value); else element.value = match.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: element.value };`,
    hover: `element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const init = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
      element.dispatchEvent(new PointerEvent('pointerover', init));
      element.dispatchEvent(new MouseEvent('mouseover', init));
      element.dispatchEvent(new PointerEvent('pointerenter', init));
      element.dispatchEvent(new MouseEvent('mouseenter', init));
      element.dispatchEvent(new MouseEvent('mousemove', init));
      return { ok: true };`,
    scroll: `window.scrollBy({ top: OFFSET, left: 0, behavior: 'auto' });
      return { ok: true, scrollY: Math.round(window.scrollY || 0) };`,
  }[input.action];
  const lookup = input.action === 'scroll'
    ? 'const element = null;'
    : `const element = document.querySelector('[data-qz-ref="' + ${ref} + '"]');
  if (!element) return { ok: false, reason: 'missing' };`;
  return `(() => {
  const VALUE = ${value};
  const OFFSET = ${offset};
  ${lookup}
  ${body}
})()`;
}

export function buildWaitScript(input) {
  const selector = JSON.stringify(input.selector);
  const text = JSON.stringify(input.text);
  const absent = input.absent ? 'true' : 'false';
  const timeout = Number(input.timeoutMs);
  return `new Promise(resolve => {
  const started = Date.now();
  const deadline = started + ${timeout};
  const selector = ${selector};
  const text = ${text};
  const check = () => {
    let found = true;
    if (selector) found = Boolean(document.querySelector(selector));
    if (found && text) {
      const body = document.body;
      const content = body ? String(body.textContent || '') : '';
      found = content.indexOf(text) >= 0;
    }
    const done = ${absent} ? !found : found;
    if (done) return resolve({ ok: true, elapsed: Date.now() - started });
    if (Date.now() >= deadline) return resolve({ ok: false, elapsed: Date.now() - started });
    setTimeout(check, 350);
  };
  check();
})`;
}
