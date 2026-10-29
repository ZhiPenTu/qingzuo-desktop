/**
 * 轻作官网脚本：外观切换 + 最新版本直链解析 + 插件市场目录。
 *
 * GitHub Release 资源文件名带版本号（CommerceTools-<version>-mac-arm64.dmg），
 * 静态页面无法预知版本，因此运行时读取最新 Release，把下载按钮指向真实资源的
 * browser_download_url —— 点击即下载最新安装包，而不是跳到发布页面。
 * 解析结果缓存在 localStorage，避免频繁触发 GitHub API 限流；失败时按钮退回发布页。
 */
(function () {
  'use strict';

  var REPO = 'ZhiPenTu/qingzuo-desktop';
  var RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';
  var API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var CACHE_KEY = 'qingzuo.site.release.v1';
  var CACHE_TTL_MS = 30 * 60 * 1000;

  var ASSET_PATTERNS = {
    mac: /-mac-arm64\.dmg$/,
    win: /-win-x64\.exe$/,
  };

  var PLATFORM_LABELS = {
    mac: 'macOS 15+ · Apple Silicon',
    win: 'Windows 10+ · x64',
  };

  // ---------- 外观切换 ----------

  var THEME_KEY = 'qingzuo.site.theme.v1';

  function applyTheme(theme) {
    var dark =
      theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }

  function currentTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (error) {
      /* 隐私模式下 storage 可能不可用。 */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function setupTheme() {
    var toggle = document.getElementById('theme-toggle');
    applyTheme(currentTheme());
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (error) {
        /* 忽略写入失败。 */
      }
      applyTheme(next);
    });
  }

  // ---------- 最新版本解析 ----------

  function pickAsset(assets, platform) {
    var pattern = ASSET_PATTERNS[platform];
    if (!pattern) return null;
    for (var i = 0; i < assets.length; i += 1) {
      if (pattern.test(assets[i].name)) return assets[i];
    }
    return null;
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return '';
    var mb = bytes / (1024 * 1024);
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return (
      date.getUTCFullYear() +
      ' 年 ' +
      (date.getUTCMonth() + 1) +
      ' 月 ' +
      date.getUTCDate() +
      ' 日'
    );
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || !cached.fetchedAt || !cached.assets) return null;
      return cached;
    } catch (error) {
      return null;
    }
  }

  function writeCache(release) {
    try {
      // 只保留解析直链需要的字段，避免把完整 Release 响应写进 localStorage。
      var assets = (release.assets || []).map(function (asset) {
        return {
          name: asset.name,
          size: asset.size,
          browser_download_url: asset.browser_download_url,
        };
      });
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          fetchedAt: Date.now(),
          assets: assets,
          tagName: release.tag_name,
          publishedAt: release.published_at || release.created_at,
        })
      );
    } catch (error) {
      /* 缓存失败不影响下载。 */
    }
  }

  function detectPlatform() {
    var ua = navigator.userAgent || '';
    if (/Mac|iPhone|iPad|iPod/i.test(ua)) return 'mac';
    if (/Windows/i.test(ua)) return 'win';
    return null;
  }

  function allCtas() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-download-cta]'));
  }

  function metaNodes(platform) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-download-meta="' + platform + '"]'));
  }

  function statusNode() {
    return document.getElementById('download-status');
  }

  function setStatus(state, text) {
    var node = statusNode();
    if (!node) return;
    if (!text) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.setAttribute('data-state', state);
    var label = node.querySelector('[data-status-text]');
    if (label) label.textContent = text;
  }

  function applyRelease(release) {
    var version = String(release.tag_name || release.tagName || '').replace(/^v/, '') || '最新版本';
    var published = formatDate(release.published_at || release.created_at);
    var resolved = 0;

    ['mac', 'win'].forEach(function (platform) {
      var asset = pickAsset(release.assets || [], platform);
      if (!asset) return;
      resolved += 1;
      allCtas().forEach(function (cta) {
        var target = cta.getAttribute('data-target');
        if (target === platform || target === 'auto') {
          if (target === 'auto' && detectPlatform() !== platform) return;
          cta.setAttribute('href', asset.browser_download_url);
          cta.setAttribute('data-resolved', 'true');
        }
      });
      var size = formatSize(asset.size);
      var label = PLATFORM_LABELS[platform] + ' · ' + version + (size ? ' · ' + size : '');
      metaNodes(platform).forEach(function (node) {
        node.textContent = label;
      });
    });

    var summary = document.querySelector('[data-download-summary]');
    if (summary) {
      summary.textContent =
        '当前最新版本 ' + version + (published ? '，' + published + '发布' : '') + '。';
    }

    if (resolved === 2) {
      setStatus('ready', '');
    } else if (resolved === 1) {
      setStatus('ready', '部分平台安装包暂缺，请前往 GitHub Releases 查看');
    } else {
      setStatus('error', '未找到安装包，请前往 GitHub Releases 手动下载');
    }
  }

  function fetchLatest() {
    return fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('GitHub API ' + response.status);
        return response.json();
      })
      .then(function (release) {
        if (!release || !Array.isArray(release.assets)) throw new Error('unexpected payload');
        writeCache(release);
        applyRelease(release);
      });
  }

  function initRelease() {
    var cached = readCache();
    if (cached) {
      applyRelease({
        tag_name: cached.tagName,
        published_at: cached.publishedAt,
        assets: cached.assets,
      });
      setStatus('ready', '');
    }
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;

    fetchLatest().catch(function (error) {
      if (cached) {
        setStatus('ready', '已就绪 · 离线缓存的版本信息，稍后自动校验');
        return;
      }
      setStatus('error', '获取最新版本失败，请前往 GitHub Releases 下载');
      allCtas().forEach(function (cta) {
        cta.setAttribute('href', RELEASES_PAGE);
      });
      if (window.console) window.console.warn('[qingzuo-site] release lookup failed', error);
    });
  }

  // ---------- 插件市场目录 ----------

  // 与桌面端插件市场读取同一份目录（见 scripts/prepare-platform.mjs 的默认地址），
  // 因此市场上架新插件后官网自动出现，无需改动页面。
  var MARKET_URL =
    'https://raw.githubusercontent.com/ZhiPenTu/qingzuo-market/main/catalog.json';
  var MARKET_CACHE_KEY = 'qingzuo.site.market.v2';
  var PLATFORM_LABELS_MARKET = {
    'darwin-arm64': 'macOS',
    'win32-x64': 'Windows',
  };

  var marketState = { plugins: [], category: '全部', query: '' };
  var exactNumber = new Intl.NumberFormat('zh-CN');
  var compactNumber = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  });

  function readMarketCache() {
    try {
      var raw = localStorage.getItem(MARKET_CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || !cached.fetchedAt || !Array.isArray(cached.plugins)) return null;
      return cached;
    } catch (error) {
      return null;
    }
  }

  function writeMarketCache(plugins) {
    try {
      localStorage.setItem(
        MARKET_CACHE_KEY,
        JSON.stringify({ fetchedAt: Date.now(), plugins: plugins })
      );
    } catch (error) {
      /* 缓存失败不影响浏览。 */
    }
  }

  function pluginRepo(plugin) {
    var artifacts = plugin.artifacts || {};
    var keys = Object.keys(artifacts);
    for (var i = 0; i < keys.length; i += 1) {
      var match = String(artifacts[keys[i]].url || '').match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\//
      );
      if (match) return 'https://github.com/' + match[1] + '/' + match[2];
    }
    return null;
  }

  function pluginDownloads(plugin) {
    var value = plugin && plugin.stats && plugin.stats.downloads;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function formatDownloadCount(value) {
    return value >= 1000 ? compactNumber.format(value) : exactNumber.format(value);
  }

  function initials(words) {
    return words
      .slice(0, 2)
      .map(function (word) {
        return word.charAt(0);
      })
      .join('')
      .toUpperCase();
  }

  function pluginIcon(plugin) {
    var icon = plugin && plugin.icon;
    if (typeof icon !== 'string' || icon.length > 49152) return null;
    return icon.indexOf('data:image/png;base64,') === 0 ? icon : null;
  }

  // 标题是中文时（如「AI 批图」「AI 抠图」）改用插件 id 的词首字母，
  // 否则多个插件会拿到同一个标记。
  function pluginMark(plugin) {
    var title = String(plugin.title || '');
    var words = title.match(/[A-Za-z]+/g);
    var hasCjk = /[\u4e00-\u9fa5]/.test(title);
    var source = hasCjk ? String(plugin.id || '').replace(/^.*\./, '') : title;
    var tokens = source.match(/[A-Za-z]+/g) || [];
    if (tokens.length > 1) return initials(tokens);
    if (tokens.length === 1) {
      var token = tokens[0];
      var capitals = token.match(/[A-Z]/g);
      if (capitals && capitals.length > 1) return capitals.slice(0, 2).join('');
      return token.slice(0, 2).toUpperCase();
    }
    return String(plugin.category || '插件').slice(0, 2);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function buildPluginCard(plugin) {
    var repo = pluginRepo(plugin);
    var card = el('a', 'plugin-card');
    card.href = repo || '#market';
    if (repo) {
      card.rel = 'noopener';
    } else {
      card.removeAttribute('href');
      card.style.cursor = 'default';
    }

    var top = el('div', 'plugin-card-top');
    var mark = el('span', 'plugin-mark');
    var icon = pluginIcon(plugin);
    if (icon) {
      mark.classList.add('has-image');
      var image = document.createElement('img');
      image.src = icon;
      image.alt = '';
      mark.appendChild(image);
    } else {
      mark.textContent = pluginMark(plugin);
    }
    top.appendChild(mark);
    var headings = el('span', 'plugin-headings');
    var title = el('span', 'plugin-title');
    title.appendChild(document.createTextNode(plugin.title || plugin.id || '未命名插件'));
    if (plugin.version) title.appendChild(el('span', 'plugin-version', 'v' + plugin.version));
    headings.appendChild(title);
    headings.appendChild(el('span', 'plugin-category', plugin.category || '未分类'));
    top.appendChild(headings);
    card.appendChild(top);

    if (plugin.description) card.appendChild(el('p', 'plugin-desc', plugin.description));

    var meta = el('p', 'plugin-meta');
    var artifacts = plugin.artifacts || {};
    Object.keys(artifacts).forEach(function (key) {
      meta.appendChild(
        el('span', 'plugin-platform', PLATFORM_LABELS_MARKET[key] || key)
      );
    });
    var downloads = pluginDownloads(plugin);
    if (downloads !== null) {
      var exact = exactNumber.format(downloads) + ' 次';
      var downloadNode = el('span', 'plugin-downloads', '↓ ' + formatDownloadCount(downloads));
      downloadNode.title = '累计下载 ' + exact;
      downloadNode.setAttribute('aria-label', '累计下载 ' + exact);
      meta.insertBefore(downloadNode, meta.firstChild);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    card.appendChild(el('p', 'plugin-repo', repo ? '查看插件仓库' : '暂无公开仓库'));
    return card;
  }

  function matchesFilter(plugin) {
    if (marketState.category !== '全部' && plugin.category !== marketState.category) return false;
    var query = marketState.query.trim().toLowerCase();
    if (!query) return true;
    return [plugin.title, plugin.description, plugin.category, plugin.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .indexOf(query) !== -1;
  }

  function renderMarket() {
    var grid = document.querySelector('[data-market-grid]');
    if (!grid) return;
    var visible = marketState.plugins.filter(matchesFilter);
    grid.textContent = '';
    if (!visible.length) {
      grid.appendChild(el('p', 'plugin-empty', '没有匹配的插件，换个关键词试试。'));
      return;
    }
    visible.forEach(function (plugin) {
      grid.appendChild(buildPluginCard(plugin));
    });
  }

  function renderFilters() {
    var box = document.querySelector('[data-market-filters]');
    if (!box) return;
    var categories = ['全部'];
    marketState.plugins.forEach(function (plugin) {
      if (plugin.category && categories.indexOf(plugin.category) === -1) {
        categories.push(plugin.category);
      }
    });
    box.textContent = '';
    categories.forEach(function (category) {
      var chip = el('button', 'chip', category);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', category === marketState.category ? 'true' : 'false');
      chip.addEventListener('click', function () {
        marketState.category = category;
        renderFilters();
        renderMarket();
      });
      box.appendChild(chip);
    });
  }

  function renderStats() {
    var platforms = {};
    marketState.plugins.forEach(function (plugin) {
      Object.keys(plugin.artifacts || {}).forEach(function (key) {
        if (PLATFORM_LABELS_MARKET[key]) platforms[PLATFORM_LABELS_MARKET[key]] = true;
      });
    });
    var platformNames = Object.keys(platforms);
    var set = function (name, value) {
      var node = document.querySelector('[data-market-stat="' + name + '"]');
      if (node) node.textContent = value;
    };
    set('count', String(marketState.plugins.length));
    set('categories', String(new Set(marketState.plugins.map(function (p) { return p.category; })).size));
    set(
      'platforms',
      platformNames.length === 2 ? 'macOS · Windows' : platformNames.join(' · ') || '—'
    );

    var inline = document.querySelector('[data-market-count-inline]');
    if (inline) {
      inline.textContent = marketState.plugins.length
        ? '（' + marketState.plugins.length + ' 个工具）'
        : '';
    }
  }

  function setMarketStatus(state, text) {
    var node = document.querySelector('[data-market-status]');
    var stats = document.querySelector('[data-market-stats]');
    if (stats) stats.hidden = state === 'error';
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.setAttribute('data-state', state);
    node.textContent = text;
  }

  function applyCatalog(plugins) {
    marketState.plugins = plugins;
    renderFilters();
    renderStats();
    renderMarket();
  }

  function fetchCatalog() {
    return fetch(MARKET_URL)
      .then(function (response) {
        if (!response.ok) throw new Error('catalog ' + response.status);
        return response.json();
      })
      .then(function (catalog) {
        if (!catalog || !Array.isArray(catalog.plugins)) throw new Error('unexpected catalog');
        writeMarketCache(catalog.plugins);
        applyCatalog(catalog.plugins);
        setMarketStatus('ready', '');
      });
  }

  function initMarket() {
    var cached = readMarketCache();
    if (cached) applyCatalog(cached.plugins);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setMarketStatus('ready', '');
      return;
    }
    fetchCatalog().catch(function (error) {
      if (cached) {
        setMarketStatus('ready', '网络不可用，暂时显示上次同步的插件列表。');
        return;
      }
      setMarketStatus('error', '插件列表加载失败，请稍后重试。');
      if (window.console) window.console.warn('[qingzuo-site] catalog lookup failed', error);
    });

    var search = document.querySelector('[data-market-search]');
    if (search) {
      search.addEventListener('input', function (event) {
        marketState.query = event.target.value || '';
        renderMarket();
      });
    }
  }

  setupTheme();
  initRelease();
  initMarket();
})();
