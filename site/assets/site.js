/**
 * 轻作官网脚本：外观切换 + 最新版本直链解析。
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
        '当前最新版本 ' +
        version +
        (published ? '（' + published + ' 发布）' : '') +
        '，下载按钮直接获取该版本安装包。';
    }

    if (resolved === 2) {
      setStatus('ready', '已就绪 · 下载按钮会直接获取 ' + version + ' 安装包');
    } else if (resolved === 1) {
      setStatus('ready', '已就绪 · 部分平台安装包暂缺，请查看 GitHub Releases');
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
      setStatus('ready', '已就绪 · 下载按钮会直接获取最新安装包');
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

  setupTheme();
  initRelease();
})();
