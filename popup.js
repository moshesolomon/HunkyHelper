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

const $ = (id) => document.getElementById(id);
let state = Object.assign({}, DEFAULTS);

const norm = (s) => String(s).trim().toLowerCase();

function cleanName(input) {
  let v = input.trim();
  const m = v.match(/\/(?:user|users)\/([^/?#]+)/i);
  if (m) {
    try { v = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { v = m[1]; }
  }
  return norm(v);
}

function save(patch) {
  Object.assign(state, patch);
  return api.storage.local.set(patch);
}

function renderList(el, names, onRemove) {
  el.textContent = '';
  names.forEach((name) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = name;
    const btn = document.createElement('button');
    btn.textContent = '\u00d7';
    btn.addEventListener('click', () => onRemove(name));
    li.append(span, btn);
    el.appendChild(li);
  });
  if (!names.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'None';
    el.appendChild(li);
  }
}

function render() {
  $('defaultCount').textContent = DEFAULT_BLOCKED.length;
  $('coverMode').checked = state.coverMode;
  $('useDefault').checked = state.useDefaultList;
  $('autoBlock').checked = state.autoBlock;
  $('threshold').value = state.threshold;
  renderList($('customList'), state.customBlocked, (name) =>
    save({ customBlocked: state.customBlocked.filter((n) => n !== name) }).then(render));
  renderList($('allowList'), state.allowList, (name) =>
    save({ allowList: state.allowList.filter((n) => n !== name) }).then(render));
}

function addTo(key, inputId) {
  const name = cleanName($(inputId).value);
  if (!name) return;
  const other = key === 'customBlocked' ? 'allowList' : 'customBlocked';
  const patch = {};
  if (!state[key].includes(name)) patch[key] = [...state[key], name];
  patch[other] = state[other].filter((n) => n !== name);
  $(inputId).value = '';
  save(patch).then(render);
}

$('addBtn').addEventListener('click', () => addTo('customBlocked', 'addName'));
$('allowBtn').addEventListener('click', () => addTo('allowList', 'allowName'));
$('addName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTo('customBlocked', 'addName'); });
$('allowName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTo('allowList', 'allowName'); });

$('coverMode').addEventListener('change', (e) => save({ coverMode: e.target.checked }));
$('useDefault').addEventListener('change', (e) => save({ useDefaultList: e.target.checked }));
$('autoBlock').addEventListener('change', (e) => save({ autoBlock: e.target.checked }));
$('threshold').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (!Number.isNaN(n)) save({ threshold: n });
});

$('clearCache').addEventListener('click', () => {
  save({ scoreCache: {} });
  const out = $('debugOut');
  out.hidden = false;
  out.textContent = 'Score cache cleared.';
});

$('debug').addEventListener('click', async () => {
  const out = $('debugOut');
  out.hidden = false;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) { out.textContent = 'No active tab.'; return; }
  const show = (resp) => {
    const m = resp.methods;
    out.textContent =
      `User avatars/links found: ${resp.refs}\n` +
      `Avatars on page: ${resp.avatars} (recognised: ${resp.apiAvatars})\n` +
      `Refs belonging to blocked users: ${resp.blockedRefs}\n` +
      `  matched as card: ${m.card}, post: ${m.postid}, repeat: ${m.repeat}, fallback: ${m.fallback}, none: ${m.none}\n` +
      `Items currently covered: ${resp.covered}\n` +
      `Pending score lookups: ${resp.pending}\n\n` +
      `Cached scores (last 15):\n${resp.scores.join('\n') || '(none)'}`;
  };
  api.tabs.sendMessage(tab.id, { type: 'hh-debug' })
    .then((resp) => {
      if (!resp) throw new Error('empty');
      show(resp);
    })
    .catch(() => {
      out.textContent = 'Open a soybooru.com tab (and reload it) first.';
    });
});

api.storage.local.get(Object.keys(DEFAULTS)).then((s) => {
  state = Object.assign({}, DEFAULTS, s);
  render();
});
