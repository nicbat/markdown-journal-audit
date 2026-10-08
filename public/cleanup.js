export function createCleanup({ api, toast, setBusy, isBusy, getEntry, redraw }) {
  const $ = selector => document.querySelector(selector);
  let active = false, preview = false, sourceView = false, data = null, key = '', relative = '', sequence = 0, history = [], loading = false;
  let blocks = new Map(), painted = null;
  const body = $('#cleanup-body');
  function controls() {
    const busy = isBusy();
    $('#cleanup-mode').setAttribute('aria-pressed', String(active));
    $('#cleanup-mode').textContent = active ? 'Cleanup on' : 'Cleanup mode';
    $('#cleanup-preview').textContent = preview ? 'Show deletion marks' : 'Preview cleaned journal';
    $('#cleanup-preview').disabled = sourceView || loading || !data || data.stale || busy;
    $('#cleanup-preview').setAttribute('aria-pressed', String(preview));
    $('#cleanup-undo').disabled = loading || !history.length || !data || data.stale || busy;
    $('#cleanup-reset').classList.toggle('hidden', !data?.stale);
    $('#cleanup-reset').disabled = loading || busy;
    $('#cleanup-mode').disabled = busy;
    body.setAttribute('aria-busy', String(loading || busy));
    $('#cleanup-count').textContent = loading ? 'Loading cleanup marks…' : data ? `${data.marks.length} deletion mark${data.marks.length === 1 ? '' : 's'} · saved locally` : '';
  }
  function paint() {
    if (!data) return;
    const markup = preview && !data.stale ? data.preview : data.rendered;
    // Marking should not rebuild the journal DOM: preserve focus, selection and scroll.
    if (painted !== markup) { body.innerHTML = markup; painted = markup; }
    body.classList.toggle('cleanup-selectable', !preview && !data.stale);
    blocks = new Map(data.blocks.map(block => [block.id, block]));
    const ranges = data.marks.map(mark => {
      const block = blocks.get(mark.id);
      return block && { start: block.start, end: mark.section ? block.sectionEnd : block.end };
    }).filter(Boolean).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    for (const node of body.querySelectorAll('[data-cleanup-id]')) {
      const block = blocks.get(node.dataset.cleanupId);
      if (!block) continue;
      let lo = 0, hi = merged.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (merged[mid].start <= block.start) lo = mid + 1; else hi = mid; }
      const selected = lo > 0 && merged[lo - 1].end >= block.end;
      node.classList.toggle('cleanup-marked', selected && !data.stale && !preview);
      if (!preview && !data.stale) {
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
        node.setAttribute('aria-pressed', String(selected));
        node.title = block.type === 'heading' ? 'Click: heading only · Shift-click: whole section' : 'Click to toggle deletion mark';
        node.setAttribute('aria-label', `${selected ? 'Marked for deletion' : 'Mark for deletion'}: ${node.textContent.trim().slice(0, 100)}`);
      } else {
        for (const attr of ['tabindex', 'role', 'aria-pressed', 'aria-label', 'title']) node.removeAttribute(attr);
      }
    }
    // Links inside selectable blocks must not create a second keyboard action.
    for (const link of body.querySelectorAll('a[href]')) {
      if (!preview && !data.stale) link.tabIndex = -1;
      else link.removeAttribute('tabindex');
    }
    $('#cleanup-message').textContent = data.stale ? 'This journal’s body changed after marking. Old marks cannot be applied. Discard them, then review this version again.' : preview ? 'Preview only. Original files have not changed.' : 'Click a block to mark it. Shift-click a heading for its whole section. Enter or Space also works. Clicking covered content restores its containing selection.';
    controls();
  }
  async function draw(entry, source = false) {
    sourceView = source;
    $('#cleanup-toolbar').classList.toggle('hidden', !active || !entry);
    body.classList.toggle('hidden', !active || source || !entry);
    if (!entry) { reset(); controls(); return; }
    const nextKey = `${entry.relative}:${entry.hash}`;
    if (!active) {
      if (nextKey !== key) reset();
      controls(); return;
    }
    controls();
    if (nextKey === key) return;
    const sameFile = relative === entry.relative;
    const oldHash = data?.bodyHash, oldRevision = data?.revision;
    key = nextKey; relative = entry.relative; data = null; preview = false; loading = true; painted = null;
    if (!sameFile) history = [];
    const ticket = ++sequence;
    body.textContent = 'Loading cleanup…'; $('#cleanup-message').textContent = ''; controls();
    try {
      const result = await api(`/api/cleanup?relative=${encodeURIComponent(entry.relative)}`);
      if (ticket !== sequence) return;
      data = result;
      if (data.stale || (oldHash && (oldHash !== data.bodyHash || oldRevision !== data.revision))) history = [];
      paint();
    } catch (error) {
      if (ticket !== sequence) return;
      key = ''; body.textContent = error.message; toast(error.message);
    } finally { if (ticket === sequence) { loading = false; controls(); } }
  }
  async function save(marks, { undo = false, reset = false } = {}) {
    if (!data || loading || isBusy()) return;
    const previous = data.marks;
    const entry = getEntry();
    if (!entry || entry.relative !== relative) return;
    setBusy(true); controls();
    try {
      data = await api('/api/cleanup', 'POST', { relative: entry.relative, bodyHash: data.bodyHash, revision: data.revision, marks, reset });
      if (reset) history = [];
      else if (undo) history.pop();
      else { history.push(previous); if (history.length > 32) history.shift(); }
      paint();
    } catch (error) { key = ''; history = []; toast(error.message); await draw(entry, sourceView); }
    finally { setBusy(false); controls(); }
  }
  function toggle(event) {
    if (preview || loading || !data || data.stale) return;
    const node = event.target.closest('[data-cleanup-id]');
    if (!node || !body.contains(node)) return;
    event.preventDefault(); event.stopPropagation();
    if (isBusy()) return;
    const block = blocks.get(node.dataset.cleanupId);
    if (!block) return;
    const section = event.shiftKey && block.type === 'heading';
    const exact = data.marks.find(mark => mark.id === block.id && mark.section === section);
    if (exact) return save(data.marks.filter(mark => mark !== exact));
    const covering = new Set(data.marks.filter(mark => {
      const parent = blocks.get(mark.id);
      return parent && parent.start <= block.start && (mark.section ? parent.sectionEnd : parent.end) >= block.end;
    }));
    if (covering.size && !section) return save(data.marks.filter(mark => !covering.has(mark)));
    // Upgrade heading-only to whole-section without sending duplicate IDs.
    save([...data.marks.filter(mark => mark.id !== block.id), { id: block.id, section }]);
  }
  body.addEventListener('mousedown', event => {
    // Shift-click selects a section, not a browser text range from the last click.
    if (event.shiftKey && !preview && !data?.stale && event.target.closest('[data-cleanup-id]')) event.preventDefault();
  });
  body.addEventListener('click', toggle);
  body.addEventListener('keydown', event => {
    if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'Enter' || event.key === ' ')) toggle(event);
  });
  $('#cleanup-mode').addEventListener('click', () => {
    if (isBusy()) return;
    active = !active; redraw();
  });
  $('#cleanup-preview').addEventListener('click', () => { preview = !preview; paint(); });
  const undo = () => { if (history.length && !data?.stale) save(history.at(-1), { undo: true }); };
  $('#cleanup-undo').addEventListener('click', undo);
  $('#cleanup-reset').addEventListener('click', () => save([], { reset: true }));
  function reset() { key = ''; relative = ''; data = null; history = []; loading = false; painted = null; blocks.clear(); sequence++; }
  return { draw, undo, updateControls: controls, get active() { return active; }, reset };
}
