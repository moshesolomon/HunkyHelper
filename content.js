(async function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const DEFAULTS = {
    customBlocked: [],
    allowList: [],
    threshold: 0,
    autoBlock: true,
    useDefaultList: true,
    coverMode: true,
    scoreCache: {},
  };

  const stored = await api.storage.local.get(Object.keys(DEFAULTS));
  const state = Object.assign({}, DEFAULTS, stored);
  if (!state.scoreCache || typeof state.scoreCache !== 'object') state.scoreCache = {};

  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const MISS_TTL_MS = 60 * 60 * 1000;
  const MAX_CONCURRENT = 2;
  const REQUEST_GAP_MS = 300;

  const REF_SEL = 'a[href*="/user/"], a[href*="/users/"], img[src*="/api/user/"]';
  const CARD_SEL = 'a[href*="/post/view/"], a[href*="/forum/"][href*="/thread/"]';
  const POST_ID_RE = /^(?:p|post[-_]?|comment[-_]?|reply[-_]?)\d+$/i;
  const FALLBACK_SEL = 'li, article, tr, [role="listitem"], [class*="comment"], [class*="post"], [class*="card"], [class*="item"], [class*="notification"], [class*="reply"], [class*="thread"], [class*="row"]';
  const NOTIFICATION_SEL = '[class*="notification"], [class*="notif"]';
  const PROFILE_HREF_RE = /^(?:https?:\/\/[^/]+)?\/users?\/([^/?#]+)\/?(?:[?#].*)?$/i;
  const AVATAR_SRC_RE = /\/api\/user\/([^/?#]+)\//i;
  const PROFILE_PATH_RE = /^\/users?\/([^/?#]+)\/?$/i;
  const ACTION_LABELS = ['Report', 'Message', 'Mark enemy', 'Send friend request'];
  const COVER_URL = api.runtime.getURL('cover.png');

  const norm = (s) => String(s).trim().toLowerCase();

  let blockedSet = new Set();
  let allowSet = new Set();

  function rebuild() {
    blockedSet = new Set(state.customBlocked.map(norm));
    if (state.useDefaultList) DEFAULT_BLOCKED.forEach((n) => blockedSet.add(n));
    allowSet = new Set(state.allowList.map(norm));
  }
  rebuild();

  function mk(seg) {
    let name = seg;
    try { name = decodeURIComponent(seg.replace(/\+/g, ' ')); } catch (e) { /* keep as is */ }
    return { key: norm(name), raw: seg };
  }

  function refName(node) {
    if (node.tagName === 'IMG') {
      const m = (node.getAttribute('src') || '').match(AVATAR_SRC_RE);
      return m ? mk(m[1]) : null;
    }
    const m = (node.getAttribute('href') || '').match(PROFILE_HREF_RE);
    return m ? mk(m[1]) : null;
  }

  function firstRef(el) {
    for (const n of el.querySelectorAll(REF_SEL)) {
      const u = refName(n);
      if (u) return u;
    }
    return null;
  }

  function injectStyle() {
    if (document.getElementById('hh-style')) return;
    const s = document.createElement('style');
    s.id = 'hh-style';
    s.textContent =
      '[data-hh-cover]{position:relative !important;overflow:hidden !important;}' +
      '[data-hh-cover] > *:not(.hh-cover){visibility:hidden !important;}' +
      '.hh-cover{position:absolute !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;' +
      'z-index:50 !important;visibility:visible !important;cursor:default !important;' +
      'background:#000 url("' + COVER_URL + '") center / 100% 100% no-repeat !important;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function attachOverlay(item) {
    const ov = document.createElement('div');
    ov.className = 'hh-cover';
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ov.addEventListener('click', stop);
    ov.addEventListener('auxclick', stop);
    item.appendChild(ov);
  }

  function block(item, userKey) {
    if (item.dataset.hhBlocked) return;
    item.dataset.hhBlocked = '1';
    if (userKey) item.dataset.hhUser = userKey;
    if (state.coverMode) {
      injectStyle();
      item.dataset.hhCover = '1';
      if (getComputedStyle(item).display === 'inline') item.style.setProperty('display', 'block');
      attachOverlay(item);
    } else {
      item.style.setProperty('display', 'none', 'important');
    }
  }

  function uncover(el) {
    el.querySelectorAll(':scope > .hh-cover').forEach((o) => o.remove());
    el.style.removeProperty('display');
    delete el.dataset.hhBlocked;
    delete el.dataset.hhUser;
    delete el.dataset.hhCover;
  }

  function unhideAll() {
    document.querySelectorAll('[data-hh-blocked]').forEach(uncover);
  }

  function repairCovers() {
    if (!state.coverMode) return;
    document.querySelectorAll('[data-hh-cover]').forEach((el) => {
      if (!el.querySelector(':scope > .hh-cover')) attachOverlay(el);
    });
  }

  function verifyBlocked() {
    document.querySelectorAll('[data-hh-user]').forEach((el) => {
      const first = firstRef(el);
      if (!first || first.key !== el.dataset.hhUser || !shouldBlock(first.key)) uncover(el);
    });
  }

  function isStructural(el) {
    return (
      el === document.body ||
      el === document.documentElement ||
      el.tagName === 'MAIN' ||
      el.id === 'app-main' ||
      !!el.querySelector('#app-main') ||
      !!el.querySelector('h1')
    );
  }

  function findRepeatedItem(node) {
    const sig = (el) => el.tagName + '|' + (el.getAttribute('class') || '');
    let el = node;
    while (el && el !== document.body) {
      const p = el.parentElement;
      if (!p) break;
      if (el !== node && p.children.length > 1 && !isStructural(el)) {
        const s = sig(el);
        for (const sib of p.children) {
          if (sib !== el && sig(sib) === s && firstRef(sib)) return el;
        }
      }
      el = p;
    }
    return null;
  }

  function findFallbackItem(node) {
    const el = node.closest(FALLBACK_SEL);
    if (!el || isStructural(el)) return null;
    const own = refName(node);
    for (const n of el.querySelectorAll(REF_SEL)) {
      const u = refName(n);
      if (u && own && u.key !== own.key) return null;
    }
    return el;
  }

  function detect(node) {
    const card = node.closest(CARD_SEL);
    if (card) return { item: card, method: 'card' };

    let el = node;
    while (el && el !== document.body) {
      if (el.id && POST_ID_RE.test(el.id)) return { item: el, method: 'postid' };
      el = el.parentElement;
    }

    const rep = findRepeatedItem(node);
    if (rep) return { item: rep, method: 'repeat' };

    const fb = findFallbackItem(node);
    if (fb) return { item: fb, method: 'fallback' };

    return null;
  }

  function parseScoreFromText(text) {
    const m = text.match(/([-\u2212\u2013]?\s?[\d,]+)\s*Reaction\s*Score/i);
    if (!m) return null;
    const n = parseInt(m[1].replace(/[\s,]/g, '').replace(/[\u2212\u2013]/, '-'), 10);
    return Number.isNaN(n) ? null : n;
  }

  let saveTimer = null;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.storage.local.set({ scoreCache: state.scoreCache }), 500);
  }

  function setScore(key, score) {
    state.scoreCache[key] = { score, t: Date.now() };
    saveCache();
  }

  function cacheFresh(key) {
    const c = state.scoreCache[key];
    if (!c) return false;
    return Date.now() - c.t < (c.score === null ? MISS_TTL_MS : CACHE_TTL_MS);
  }

  const queued = new Set();
  const queue = [];
  let active = 0;
  let rerunTimer = null;

  function scheduleRerun() {
    if (rerunTimer) return;
    rerunTimer = setTimeout(() => { rerunTimer = null; run(); }, 150);
  }

  function enqueue(user) {
    if (!state.autoBlock || cacheFresh(user.key) || queued.has(user.key)) return;
    queued.add(user.key);
    queue.push(user);
    pump();
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const user = queue.shift();
      active++;
      fetch('/user/' + user.raw, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
        .then((html) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          let score = doc.body ? parseScoreFromText(doc.body.textContent || '') : null;
          if (score === null) score = parseScoreFromText(html.replace(/<[^>]+>/g, ' '));
          setScore(user.key, score);
        })
        .catch(() => setScore(user.key, null))
        .finally(() => {
          active--;
          queued.delete(user.key);
          scheduleRerun();
          setTimeout(pump, REQUEST_GAP_MS);
        });
    }
  }

  function isListed(key) {
    if (blockedSet.has(key)) return true;
    return state.useDefaultList && /^-{10,}$/.test(key);
  }

  function badScore(key) {
    const c = state.scoreCache[key];
    return !!c && typeof c.score === 'number' && c.score < state.threshold;
  }

  function shouldBlock(key) {
    if (allowSet.has(key)) return false;
    return isListed(key) || (state.autoBlock && badScore(key));
  }

  function filterRefs() {
    document.querySelectorAll(REF_SEL).forEach((node) => {
      const user = refName(node);
      if (!user) return;

      if (!shouldBlock(user.key)) {
        if (!allowSet.has(user.key) && !isListed(user.key)) enqueue(user);
        return;
      }
      if (node.closest('[data-hh-blocked]')) return;

      const found = detect(node);
      if (!found) return;
      const first = firstRef(found.item);
      if (!first || first.key !== user.key) return;
      block(found.item, user.key);
    });
  }

  function filterNotificationText() {
    document.querySelectorAll(NOTIFICATION_SEL).forEach((item) => {
      if (item.dataset.hhBlocked || isStructural(item)) return;
      const text = (item.textContent || '').trim();
      if (text.length > 600) return;
      const m = text.replace(/^user avatar\s*/i, '').match(/^([^\s\u00b7]+)/);
      if (m && shouldBlock(norm(m[1]))) block(item, null);
    });
  }

  function currentProfile() {
    const m = location.pathname.match(PROFILE_PATH_RE);
    return m ? mk(m[1]) : null;
  }

  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  function findActionRef() {
    const found = {};
    document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
      if (el.closest('#hh-block-btn')) return;
      const t = textOf(el);
      if (ACTION_LABELS.includes(t) && !found[t]) found[t] = el;
    });
    for (const label of ACTION_LABELS) if (found[label]) return found[label];
    return null;
  }

  function makeIcon(oldSvg) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    if (oldSvg) {
      ['class', 'width', 'height', 'style'].forEach((a) => {
        if (oldSvg.hasAttribute(a)) svg.setAttribute(a, oldSvg.getAttribute(a));
      });
    }
    if (!svg.hasAttribute('width')) svg.setAttribute('width', '16');
    if (!svg.hasAttribute('height')) svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '12');
    c.setAttribute('cy', '12');
    c.setAttribute('r', '10');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'm4.9 4.9 14.2 14.2');
    svg.append(c, p);
    return svg;
  }

  function setLabel(btn, label) {
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
    let first = null;
    const extra = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.nodeValue.trim()) continue;
      if (!first) first = n; else extra.push(n);
    }
    if (!first) {
      btn.appendChild(document.createTextNode(label));
      return;
    }
    if (first.nodeValue !== label) first.nodeValue = label;
    extra.forEach((n) => n.remove());
  }

  function buildInlineButton(ref) {
    const btn = ref.cloneNode(true);
    btn.id = 'hh-block-btn';
    ['onclick', 'target', 'download', 'aria-label', 'title'].forEach((a) => btn.removeAttribute(a));
    if (btn.tagName === 'A') btn.setAttribute('href', '#');
    if (btn.tagName === 'BUTTON') { btn.type = 'button'; btn.disabled = false; }
    btn.style.cursor = 'pointer';

    const oldSvg = btn.querySelector('svg');
    const icon = makeIcon(oldSvg);
    if (oldSvg) oldSvg.replaceWith(icon);
    else btn.insertBefore(icon, btn.firstChild);

    const stop = (e) => { e.preventDefault(); e.stopPropagation(); toggleCurrentProfile(); };
    btn.addEventListener('click', stop);
    return btn;
  }

  function buildFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'hh-block-float';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:8px 12px;' +
      'border:none;border-radius:6px;background:#b33;color:#fff;font-size:13px;cursor:pointer;opacity:.9;';
    btn.addEventListener('click', toggleCurrentProfile);
    return btn;
  }

  const profileParseAttempts = {};

  function syncProfileButton() {
    const user = currentProfile();
    const inline = document.getElementById('hh-block-btn');
    const floating = document.getElementById('hh-block-float');

    if (!user) {
      if (inline) inline.remove();
      if (floating) floating.remove();
      return;
    }

    if (!cacheFresh(user.key) && (profileParseAttempts[user.key] || 0) < 20) {
      profileParseAttempts[user.key] = (profileParseAttempts[user.key] || 0) + 1;
      const score = parseScoreFromText(document.body.textContent || '');
      if (score !== null) setScore(user.key, score);
    }

    const label = shouldBlock(user.key) ? 'Unblock' : 'Block';
    const ref = findActionRef();

    if (ref) {
      if (floating) floating.remove();
      if (inline && inline.parentElement === ref.parentElement) {
        setLabel(inline, label);
        return;
      }
      if (inline) inline.remove();
      const btn = buildInlineButton(ref);
      setLabel(btn, label);
      ref.insertAdjacentElement('afterend', btn);
      return;
    }

    if (inline) inline.remove();
    let fl = floating;
    if (!fl) {
      fl = buildFloatingButton();
      document.body.appendChild(fl);
    }
    const text = label + ' ' + user.raw;
    if (fl.textContent !== text) fl.textContent = text;
  }

  async function toggleCurrentProfile() {
    const user = currentProfile();
    if (!user) return;
    let custom = state.customBlocked.map(norm);
    let allow = state.allowList.map(norm);

    if (shouldBlock(user.key)) {
      custom = custom.filter((n) => n !== user.key);
      if (!allow.includes(user.key)) allow.push(user.key);
    } else {
      allow = allow.filter((n) => n !== user.key);
      if (!custom.includes(user.key)) custom.push(user.key);
    }
    state.customBlocked = custom;
    state.allowList = allow;
    await api.storage.local.set({ customBlocked: custom, allowList: allow });
    rebuild();
    unhideAll();
    run();
  }

  function run() {
    verifyBlocked();
    filterRefs();
    filterNotificationText();
    repairCovers();
    syncProfileButton();
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let relevant = false;
    ['customBlocked', 'allowList', 'threshold', 'autoBlock', 'useDefaultList', 'coverMode'].forEach((k) => {
      if (changes[k]) {
        state[k] = changes[k].newValue !== undefined ? changes[k].newValue : DEFAULTS[k];
        relevant = true;
      }
    });
    if (changes.scoreCache && changes.scoreCache.newValue && Object.keys(changes.scoreCache.newValue).length === 0) {
      state.scoreCache = {};
      Object.keys(profileParseAttempts).forEach((k) => delete profileParseAttempts[k]);
      relevant = true;
    }
    if (relevant) {
      rebuild();
      unhideAll();
      run();
    }
  });

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'hh-debug') return;
    const refs = [...document.querySelectorAll(REF_SEL)].filter(refName);
    const methods = { card: 0, postid: 0, repeat: 0, fallback: 0, none: 0 };
    let blockedRefs = 0;
    refs.forEach((n) => {
      const u = refName(n);
      if (!shouldBlock(u.key)) return;
      blockedRefs++;
      const d = detect(n);
      methods[d ? d.method : 'none']++;
    });
    const avatars = document.querySelectorAll('img[alt="User avatar"]');
    const apiAvatars = [...avatars].filter((i) => AVATAR_SRC_RE.test(i.getAttribute('src') || ''));
    sendResponse({
      refs: refs.length,
      blockedRefs,
      methods,
      covered: document.querySelectorAll('[data-hh-blocked]').length,
      avatars: avatars.length,
      apiAvatars: apiAvatars.length,
      pending: queue.length + active,
      coverMode: state.coverMode,
      scores: Object.keys(state.scoreCache).slice(-15).map((k) => k + ': ' + state.scoreCache[k].score),
    });
  });

  run();

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(run, 200);
  }).observe(document.body, { childList: true, subtree: true });
})();
