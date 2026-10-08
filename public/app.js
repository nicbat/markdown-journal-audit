import { createCleanup } from '/assets/cleanup.js';
const $ = selector => document.querySelector(selector);
const el = (tag, attrs = {}, text = '') => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value);
  }
  if (text) node.textContent = text;
  return node;
};
const state = {
  entries: [], statuses: [], current: -1, filter: 'all', source: false, undo: null,
  config: null, busy: false, drafts: new Map(), details: new Map(), pending: new Map(),
  rows: new Map(), byRelative: new Map(), visible: [], positions: new Map(),
  selectedRow: null, generation: 0, renderedKey: '', prefetchTimer: null
};
const filters = [...document.querySelectorAll('.filter')];
const statusFor = key => state.statuses.find(status => status.key === key);
const visibleEntries = () => state.visible;
const currentEntry = () => state.entries[state.current];
function matchesFilter(entry) {
  const status = entry.metadata.audit_status;
  if (state.filter.startsWith('status:')) return String(status) === state.filter.slice(7);
  return state.filter === 'all' || (state.filter === 'unreviewed' && !status) ||
    (state.filter === 'skipped' && status === 'skip') || (state.filter === 'completed' && status && status !== 'skip');
}
function toast(message) {
  const box = $('#toast'); box.textContent = message; box.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
}
async function api(url, method = 'GET', data, signal) {
  const response = await fetch(url, { method, signal, headers: data ? { 'content-type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || `Request failed (${response.status}).`); error.code = result.code; throw error; }
  return result;
}
function sessionKey() { return `journal-audit-session:${state.config?.journalFolder || 'unconfigured'}`; }
function saveResume() {
  try { localStorage.setItem(sessionKey(), JSON.stringify({ current: currentEntry()?.relative ?? '', filter: state.filter })); } catch {}
}
function resetDetails() {
  state.generation++;
  cleanup.reset();
  for (const request of state.pending.values()) request.controller.abort();
  state.pending.clear(); state.details.clear(); state.renderedKey = '';
  clearTimeout(state.prefetchTimer);
}
function cacheDetail(entry) {
  state.details.delete(entry.relative); state.details.set(entry.relative, entry);
  while (state.details.size > 32) state.details.delete(state.details.keys().next().value);
}
function patchEntry(detail) {
  const index = state.byRelative.get(detail.relative);
  if (index === undefined) return;
  const { body, source, rendered, links, ...summary } = detail;
  const previous = state.entries[index];
  const statusChanged = previous.metadata.audit_status !== summary.metadata.audit_status;
  state.entries[index] = summary;
  cacheDetail(detail);
  updateRow(summary);
  if (statusChanged) { updateProgress(); updateFilter(); }
  else updateCleanupProgress();
}
async function loadDetail(relative) {
  if (state.details.has(relative)) return state.details.get(relative);
  if (state.pending.has(relative)) return state.pending.get(relative).promise;
  const generation = state.generation;
  const controller = new AbortController();
  const promise = api(`/api/entry?relative=${encodeURIComponent(relative)}`, 'GET', undefined, controller.signal).then(detail => {
    if (generation === state.generation) patchEntry(detail);
    return detail;
  }).finally(() => { if (state.pending.get(relative)?.promise === promise) state.pending.delete(relative); });
  state.pending.set(relative, { promise, controller });
  return promise;
}
function prefetchNeighbors() {
  clearTimeout(state.prefetchTimer);
  state.prefetchTimer = setTimeout(() => {
    const at = state.positions.get(state.current);
    if (at === undefined) return;
    for (const offset of [1, 2, -1]) {
      const item = state.visible[at + offset];
      if (item) loadDetail(item.entry.relative).catch(() => {});
    }
  }, 0);
}
function updateProgress() {
  let completed = 0, skipped = 0, unreviewed = 0;
  const counts = new Map(state.statuses.map(status => [status.key, 0]));
  for (const entry of state.entries) {
    if (!entry.metadata.audit_status) unreviewed++;
    else if (entry.metadata.audit_status === 'skip') skipped++;
    else completed++;
    const key = entry.metadata.audit_status;
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = state.entries.length;
  $('#queue-count').textContent = total ? `${total} journals` : 'No Markdown journals found';
  $('#progress-label').textContent = `${completed} completed`;
  $('#progress-ratio').textContent = `${total ? Math.round(completed / total * 100) : 0}%`;
  $('#progress-fill').style.width = `${total ? completed / total * 100 : 0}%`;
  const fragment = document.createDocumentFragment();
  for (const [label, count, color] of [['Completed', completed, '#147c78'], ['Skipped', skipped, '#738396'], ['Unreviewed', unreviewed, '#bdc8ce']]) {
    const span = el('span'); span.append(el('i', { class: 'status-dot', style: `background:${color}` }), document.createTextNode(`${label} ${count}`)); fragment.append(span);
  }
  $('#progress-breakdown').replaceChildren(fragment);
  const categories = document.createDocumentFragment();
  const appendCount = (key, label, count, color) => {
    const filter = key ? `status:${key}` : 'unreviewed';
    const row = el('button', { class: 'status-count', type: 'button', 'data-status': key, 'data-category-filter': filter, 'aria-pressed': String(state.filter === filter), 'aria-label': `Review ${label} (${count} files)` });
    const name = el('span', { class: 'status-count-name' });
    name.append(el('i', { class: 'status-dot', style: `background:${color}` }), document.createTextNode(label));
    row.append(name, el('span', { class: 'status-count-value' }, count.toLocaleString())); categories.append(row);
  };
  appendCount('', 'Unreviewed', unreviewed, '#87959e');
  for (const [key, count] of counts) {
    const status = statusFor(key);
    appendCount(key, status?.label || String(key), count, status?.color || '#687987');
  }
  $('#status-counts').replaceChildren(categories);
}
function updateRow(entry) {
  const row = state.rows.get(entry.relative);
  if (!row) return;
  const status = statusFor(entry.metadata.audit_status);
  if (status) { row.dataset.status = status.key; row.style.setProperty('--item-color', status.color); }
  else { delete row.dataset.status; row.style.removeProperty('--item-color'); }
  const sub = entry.error ? 'Frontmatter error' : `${entry.wordCount} words${status ? ` · ${status.label}` : ''}${entry.cleanup?.reviewed ? ' · Cleanup ✓' : entry.cleanup?.stale ? ' · Cleanup changed' : entry.cleanup?.markCount ? ' · Cleanup started' : ''}`;
  const label = row.querySelector('.queue-sub');
  if (label.textContent !== sub) label.textContent = sub;
}
function buildQueue() {
  state.rows.clear(); state.byRelative.clear(); state.selectedRow = null;
  for (const [index, entry] of state.entries.entries()) {
    state.byRelative.set(entry.relative, index);
    const button = el('button', { class: 'queue-item', type: 'button', title: entry.relative, 'data-relative': entry.relative });
    const copy = el('span', { class: 'queue-copy' });
    copy.append(el('span', { class: 'queue-name' }, entry.name), el('span', { class: 'queue-sub' }));
    button.append(el('span', { class: 'queue-mark' }), copy);
    state.rows.set(entry.relative, button); updateRow(entry);
  }
  updateProgress(); updateFilter(true);
}
function updateFilter(force = false) {
  const old = state.visible;
  state.visible = []; state.positions.clear();
  for (const [index, entry] of state.entries.entries()) {
    if (!matchesFilter(entry)) continue;
    state.positions.set(index, state.visible.length); state.visible.push({ entry, index });
  }
  // Most status saves do not change the All queue. Keep its DOM and scroll intact.
  if (force || old.length !== state.visible.length || old.some((item, index) => item.index !== state.visible[index].index)) {
    const scrollTop = $('#queue-list').scrollTop, scrollLeft = $('#queue-list').scrollLeft;
    const fragment = document.createDocumentFragment();
    for (const { entry } of state.visible) fragment.append(state.rows.get(entry.relative));
    $('#queue-list').replaceChildren(fragment);
    $('#queue-list').scrollTop = scrollTop; $('#queue-list').scrollLeft = scrollLeft;
  }
  filters.forEach(filter => filter.classList.toggle('active', filter.dataset.filter === state.filter));
  for (const button of $('#status-counts').children) button.setAttribute('aria-pressed', String(button.dataset.categoryFilter === state.filter));
  const label = state.filter.startsWith('status:') ? (statusFor(state.filter.slice(7))?.label || state.filter.slice(7)) : ({ all: 'All journals', unreviewed: 'To review', completed: 'Completed', skipped: 'Skipped' }[state.filter]);
  $('#queue-view').textContent = `${label} · ${state.visible.length} files`;
  updateCleanupProgress();
}
function updateCleanupProgress() {
  const done = state.visible.filter(item => state.entries[item.index].cleanup?.reviewed).length;
  const total = state.visible.length;
  $('#cleanup-progress-label').textContent = `Cleanup: ${done} / ${total} reviewed`;
  $('#cleanup-progress-bar').max = total || 1;
  $('#cleanup-progress-bar').value = done;
  $('#cleanup-next-pending').disabled = state.busy || done === total;
}
function nextCleanup() {
  if (state.busy) return;
  const at = state.positions.get(state.current) ?? -1;
  for (let offset = 1; offset <= state.visible.length; offset++) {
    const item = state.visible[(at + offset) % state.visible.length];
    if (!state.entries[item.index].cleanup?.reviewed) {
      cleanup.enable(); selectIndex(item.index); return;
    }
  }
  toast('Cleanup complete for this view');
}
function cleanupUpdated(relative, data) {
  const index = state.byRelative.get(relative);
  if (index === undefined) return;
  const summary = { reviewed: !!data.reviewed, markCount: data.marks.length, stale: data.stale };
  state.entries[index].cleanup = summary;
  const detail = state.details.get(relative);
  if (detail) detail.cleanup = summary;
  updateRow(state.entries[index]); updateCleanupProgress();
}
$('#cleanup-next-pending').addEventListener('click', nextCleanup);
function drawLinks(entry) {
  $('#word-count').textContent = entry.wordCount.toLocaleString();
  $('#outgoing-count').textContent = entry.linkCount ?? entry.links?.length ?? 0;
  $('#incoming-count').textContent = entry.incoming;
  const target = $('#outgoing-links'); target.replaceChildren();
  if (!entry.links) return;
  if (!entry.links.length) target.append(el('span', { class: 'queue-sub' }, 'No outgoing links'));
  const grouped = new Map();
  for (const link of entry.links) {
    const key = link.target.trim().replace(/\\/g, '/').replace(/^\//, '').replace(/\.md$/i, '').toLowerCase();
    if (grouped.has(key)) grouped.get(key).count++;
    else grouped.set(key, { ...link, count: 1 });
  }
  $('#outgoing-count').textContent = grouped.size === entry.links.length ? String(grouped.size) : `${grouped.size} (${entry.links.length} total)`;
  $('#outgoing-count').title = `${grouped.size} distinct targets, ${entry.links.length} references`;
  for (const link of grouped.values()) {
    const item = el('a', { class: `out-link${link.resolves ? '' : ' unresolved'}`, title: `${link.target} · ${link.count} reference${link.count === 1 ? '' : 's'}` });
    item.append(el('i', {}, link.resolves ? '↗' : '·'), el('span', { class: 'out-link-label' }, link.label));
    if (link.count > 1) item.append(el('span', { class: 'link-count', 'aria-label': `${link.count} references` }, `×${link.count}`));
    target.append(item);
  }
}
function buildActions() {
  const buttons = $('#action-buttons'); buttons.replaceChildren();
  state.statuses.forEach((status, index) => {
    const button = el('button', { class: 'status-action', type: 'button', 'data-key': status.key, style: `--status:${status.color}` });
    button.append(el('span', { class: 'number' }, String(index + 1)), el('span', { class: 'status-name' }, status.label));
    buttons.append(button);
  });
}
function updateControls() {
  const entry = currentEntry();
  const at = state.positions.get(state.current);
  const ready = entry && state.details.has(entry.relative) && at !== undefined;
  $('#previous').disabled = state.busy || at === undefined || at <= 0;
  $('#next').disabled = state.busy || at === undefined || at >= state.visible.length - 1;
  $('#queue-position').textContent = at === undefined ? '0 / 0' : `${at + 1} / ${state.visible.length}`;
  $('#undo').disabled = state.busy || !state.undo;
  $('#refresh').disabled = state.busy;
  $('#settings-open').disabled = state.busy;
  for (const button of $('#action-buttons').children) button.disabled = state.busy || !ready || !!entry.error || !entry.hash;
  $('#audit-note').disabled = state.busy || !ready;
  cleanup.updateControls();
  updateCleanupProgress();
}
function draw() {
  const entry = currentEntry();
  const empty = !entry || !state.positions.has(state.current);
  state.selectedRow?.classList.remove('selected');
  state.selectedRow = empty ? null : state.rows.get(entry.relative);
  state.selectedRow?.classList.add('selected');
  for (const id of ['journal-sheet', 'action-dock', 'details-panel']) $(`#${id}`).classList.toggle('hidden', empty);
  $('#empty-state').classList.toggle('hidden', !empty);
  $('#folder-label').textContent = state.config?.journalFolder || 'Choose a journal folder to begin';
  updateControls();
  if (empty) {
    cleanup.draw(null, state.source);
    const hasEntries = state.entries.length > 0;
    $('#empty-state h2').textContent = hasEntries ? 'No journals in this view' : 'Make room for a closer read';
    $('#empty-state p').textContent = hasEntries ? 'Change the queue filter to see more journals.' : 'Choose the folder with your Markdown journals. The audit status is saved in each file’s YAML frontmatter.';
    $('#setup-open').classList.toggle('hidden', hasEntries);
    return;
  }
  const detail = state.details.get(entry.relative);
  $('#journal-title').textContent = entry.name;
  $('#journal-path').textContent = entry.relative;
  const status = statusFor(entry.metadata.audit_status);
  $('#journal-date').textContent = [entry.metadata.date, entry.metadata.created, status ? `Reviewed: ${status.label}` : 'Not reviewed'].filter(Boolean).join('  /  ');
  const key = detail ? `${entry.relative}:${detail.hash}:${detail.error || ''}` : `loading:${entry.relative}`;
  if (state.renderedKey !== key) {
    if (detail) { $('#markdown-body').innerHTML = detail.rendered; $('#source-body').textContent = detail.source; }
    else { $('#markdown-body').textContent = 'Loading journal…'; $('#source-body').textContent = ''; }
    state.renderedKey = key;
    drawLinks(detail || entry);
    $('#audit-note').value = state.drafts.get(entry.relative) ?? entry.metadata.audit_note ?? '';
  }
  $('#markdown-body').classList.toggle('hidden', state.source || cleanup.active);
  cleanup.draw(detail || entry, state.source);
  $('#source-body').classList.toggle('hidden', !state.source);
  $('#source-toggle').textContent = state.source ? 'View reading page' : 'View source';
  $('#file-error').classList.toggle('hidden', !entry.error);
  $('#file-error').textContent = entry.error ? `${entry.error} Correct the YAML frontmatter in your editor, then rescan this folder. No change will be written to this file.` : '';
}
function selectIndex(index, { force = false } = {}) {
  if (state.busy && !force) return;
  state.current = state.positions.has(index) ? index : -1;
  state.source = false; draw(); saveResume();
  // Animated scrolling on every keypress makes otherwise instant navigation feel slow.
  window.scrollTo({ top: 0, behavior: 'instant' });
  const entry = currentEntry();
  if (!entry || state.current < 0) return;
  const generation = state.generation;
  if (!state.details.has(entry.relative)) {
    loadDetail(entry.relative).then(() => {
      if (generation === state.generation && currentEntry()?.relative === entry.relative) { draw(); prefetchNeighbors(); }
    }).catch(error => { if (error.name !== 'AbortError' && generation === state.generation) toast(error.message); });
  } else prefetchNeighbors();
}
function nextVisible(direction = 1) {
  if (state.busy || !state.visible.length) return;
  const at = state.positions.get(state.current);
  const next = at === undefined ? 0 : Math.max(0, Math.min(state.visible.length - 1, at + direction));
  selectIndex(state.visible[next].index);
}
async function review(status) {
  const entry = currentEntry();
  if (!entry || entry.error || state.busy || !state.positions.has(state.current) || !state.details.has(entry.relative)) return;
  const at = state.positions.get(state.current);
  const nextRelative = state.visible[at + 1]?.entry.relative;
  const note = $('#audit-note').value;
  state.busy = true; updateControls();
  try {
    const saved = await api('/api/action', 'POST', { relative: entry.relative, hash: entry.hash, status: status.key, note });
    state.undo = { relative: entry.relative, hash: saved.hash, undoToken: saved.undoToken };
    state.drafts.delete(entry.relative);
    patchEntry(saved.entry);
    toast(`${status.label} saved`);
    const nextIndex = nextRelative ? state.byRelative.get(nextRelative) : state.current;
    selectIndex(state.positions.has(nextIndex) ? nextIndex : (state.visible[Math.min(at, state.visible.length - 1)]?.index ?? -1), { force: true });
  } catch (error) {
    toast(error.code === 'CONFLICT' ? 'Journal changed on disk. Rescan before continuing.' : error.message);
    if (error.code === 'CONFLICT') await refresh({ preserve: entry.relative, duringBusy: true });
  } finally { state.busy = false; updateControls(); }
}
async function undo() {
  const record = state.undo; if (!record || state.busy) return;
  state.busy = true; updateControls();
  try {
    const result = await api('/api/undo', 'POST', { relative: record.relative, hash: record.hash, undoToken: record.undoToken });
    state.undo = null; state.drafts.delete(record.relative); patchEntry(result.entry);
    const index = state.byRelative.get(record.relative);
    // Undo returns to the restored entry, even if its old status is outside this filter.
    if (!state.positions.has(index)) { state.filter = 'all'; updateFilter(); }
    selectIndex(index, { force: true }); toast('Last review action undone');
  } catch (error) {
    toast(error.message);
    if (error.code === 'CONFLICT') { state.undo = null; await refresh({ preserve: record.relative, duringBusy: true }); }
  } finally { state.busy = false; updateControls(); }
}
async function refresh(options = {}) {
  if (state.busy && !options.duringBusy) return;
  const ownsBusy = !options.duringBusy;
  if (ownsBusy) state.busy = true;
  updateControls();
  const currentRelative = options.preserve ?? currentEntry()?.relative;
  const resume = (() => { try { return JSON.parse(localStorage.getItem(sessionKey()) || '{}'); } catch { return {}; } })();
  resetDetails();
  try {
    const response = options.initial ? await api('/api/entries') : await api('/api/reload', 'POST', {});
    state.entries = response.entries; state.statuses = response.statuses;
    const preferred = options.reset ? '' : (currentRelative || resume.current || '');
    if (!options.reset && !options.preserve && (typeof resume.filter === 'string' && (['all', 'unreviewed', 'completed', 'skipped'].includes(resume.filter) || resume.filter.startsWith('status:')))) state.filter = resume.filter;
    buildQueue(); buildActions();
    let index = state.byRelative.get(preferred);
    if (!state.positions.has(index)) index = state.visible.find(item => !item.entry.metadata.audit_status)?.index ?? state.visible[0]?.index ?? -1;
    selectIndex(index, { force: true });
  } catch (error) { toast(error.message); }
  finally { if (ownsBusy) { state.busy = false; updateControls(); } }
}
function openSettings() {
  if (state.busy) return;
  $('#journal-folder').value = state.config?.journalFolder || '';
  $('#vault-folder').value = state.config?.vaultFolder || '';
  drawStatusEditor(state.statuses);
  $('#settings-error').textContent = '';
  $('#settings-dialog').showModal();
}
function drawStatusEditor(statuses) {
  const editor = $('#status-editor'); editor.replaceChildren();
  statuses.forEach((status, index) => {
    const row = el('div', { class: 'status-row' }); row.append(el('span', { class: 'status-key' }, String(index + 1)));
    const label = el('input', { 'aria-label': 'Status label', maxlength: '32', value: status.label });
    label.value = status.label; label.dataset.field = 'label';
    const color = el('input', { type: 'color', 'aria-label': 'Status color', value: status.color }); color.value = status.color; color.dataset.field = 'color';
    const remove = el('button', { class: 'remove-status', type: 'button', title: 'Remove status', 'aria-label': `Remove ${status.label}` }, '×');
    remove.addEventListener('click', () => { if (statuses.length <= 1) return; const next = collectStatuses(); next.splice(index, 1); drawStatusEditor(next); });
    row.dataset.key = status.key || ''; row.append(label, color, remove); editor.append(row);
  });
  $('#add-status').disabled = statuses.length >= 9;
  const kept = new Set(statuses.map(status => status.key));
  const removed = state.statuses.filter(status => !kept.has(status.key));
  const affected = state.entries.filter(entry => removed.some(status => status.key === entry.metadata.audit_status)).length;
  $('#status-removal-notice').textContent = removed.length ? `Saving removes ${removed.map(s => s.label).join(', ')} and resets ${affected} matching files in the current journal folder to unreviewed. Review notes are kept; originals are backed up.` : 'Removing a status resets its notes to unreviewed when you save.';
}
function collectStatuses() {
  return [...$('#status-editor').querySelectorAll('.status-row')].map((row, index) => {
    const label = row.querySelector('[data-field="label"]').value.trim() || `Status ${index + 1}`;
    const key = row.dataset.key || label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || `status_${index + 1}`;
    return { key, label, color: row.querySelector('[data-field="color"]').value };
  });
}
$('#settings-open').addEventListener('click', openSettings); $('#setup-open').addEventListener('click', openSettings); $('#settings-close').addEventListener('click', () => $('#settings-dialog').close()); $('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
$('#refresh').addEventListener('click', () => refresh()); $('#undo').addEventListener('click', undo);
$('#queue-list').addEventListener('click', event => { const row = event.target.closest('.queue-item'); if (row) selectIndex(state.byRelative.get(row.dataset.relative)); });
$('#status-counts').addEventListener('click', event => {
  const button = event.target.closest('[data-category-filter]');
  if (!button || state.busy) return;
  state.filter = button.dataset.categoryFilter; updateFilter(); selectIndex(state.visible[0]?.index ?? -1);
});
$('#action-buttons').addEventListener('click', event => { const button = event.target.closest('.status-action'); const status = button && statusFor(button.dataset.key); if (status) review(status); });
$('#previous').addEventListener('click', () => nextVisible(-1)); $('#next').addEventListener('click', () => nextVisible(1));
$('#audit-note').addEventListener('input', event => { const entry = currentEntry(); if (entry) state.drafts.set(entry.relative, event.target.value); });
$('#source-toggle').addEventListener('click', () => { state.source = !state.source; draw(); });
filters.forEach(filter => filter.addEventListener('click', () => { if (state.busy) return; state.filter = filter.dataset.filter; updateFilter(); selectIndex(state.positions.has(state.current) ? state.current : (state.visible[0]?.index ?? -1)); }));
$('#add-status').addEventListener('click', () => { const items = collectStatuses(); if (items.length >= 9) return; const colors = ['#147c78', '#4e7497', '#98733e', '#7b668f', '#587b57', '#b46155']; items.push({ key: '', label: '', color: colors[items.length % colors.length] }); drawStatusEditor(items); $('#status-editor .status-row:last-child input').focus(); });
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true; updateControls();
  const submit = $('#settings-form button[type="submit"]'); submit.disabled = true;
  const settingsError = $('#settings-error'); settingsError.textContent = '';
  try {
    const result = await api('/api/config', 'POST', { journalFolder: $('#journal-folder').value.trim(), vaultFolder: $('#vault-folder').value.trim(), statuses: collectStatuses() });
    const removedStatuses = state.statuses.some(status => !result.statuses.some(s => s.key === status.key));
    const folderChanged = result.journalFolder !== state.config?.journalFolder;
    const vaultChanged = result.vaultFolder !== state.config?.vaultFolder;
    state.config = result; state.statuses = result.statuses; $('#settings-dialog').close();
    if (folderChanged) {
      state.undo = null; state.drafts.clear(); state.filter = 'all';
      await refresh({ preserve: '', reset: true, duringBusy: true });
    } else if (removedStatuses) {
      state.undo = null; state.filter = 'unreviewed';
      await refresh({ reset: true, duringBusy: true });
    } else if (vaultChanged) await refresh({ preserve: currentEntry()?.relative, duringBusy: true });
    else {
      buildActions();
      updateProgress();
      updateFilter();
      for (const entry of state.entries) updateRow(entry);
      draw();
    }
    toast(removedStatuses ? `${result.reset?.count || 0} notes reset to unreviewed` : 'Folder settings saved');
  } catch (error) { settingsError.textContent = error.message; }
  finally { state.busy = false; submit.disabled = false; updateControls(); }
});
document.addEventListener('keydown', event => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  const tag = event.target?.tagName?.toLowerCase();
  if (event.target === $('#audit-note') && event.key === 'Enter') { event.preventDefault(); event.target.blur(); return; }
  if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable || $('#settings-dialog').open) return;
  if (event.key === 'Enter' && !event.shiftKey && cleanup.active && !event.target.closest('button, a, [role="button"]')) {
    if (currentEntry() && !$('#cleanup-done').disabled) { event.preventDefault(); $('#cleanup-done').click(); }
    return;
  }
  if (event.key.toLowerCase() === 'n' && !state.busy && !$('#action-dock').classList.contains('hidden')) { event.preventDefault(); $('#audit-note').focus(); return; }
  if (event.key.toLowerCase() === 'u' || ((event.key === 'z' || event.key === 'Z') && !event.shiftKey)) { event.preventDefault(); if (cleanup.active) cleanup.undo(); else undo(); return; }
  if (/^[1-9]$/.test(event.key)) { const status = state.statuses[Number(event.key) - 1]; if (status) { event.preventDefault(); review(status); } }
  if (event.key === 'ArrowLeft') { event.preventDefault(); nextVisible(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); nextVisible(1); }
});
const cleanup = createCleanup({ api, toast, onUpdate: cleanupUpdated, advance: nextCleanup, getEntry: currentEntry, isBusy: () => state.busy, setBusy: value => { state.busy = value; updateControls(); }, redraw: draw });
(async function init() {
  try {
    state.config = await api('/api/config'); state.statuses = state.config.statuses;
    if (state.config.ready) await refresh({ initial: true }); else openSettings();
  } catch (error) { $('#file-error').textContent = error.message; toast(error.message); }
})();
