import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import crypto from 'node:crypto';
import { resetStatuses } from './audit-operations.js';
import { VaultIndex } from './vault-index.js';
import taskLists from 'markdown-it-task-lists';
import { fileURLToPath } from 'node:url';
import { realFolder, resolveSafeFile, saveAudit, undoAudit, isInside } from './journal.js';

const md = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(taskLists, { enabled: true, label: true });
md.inline.ruler.before('text', 'wikilink', (state, silent) => {
  const rest = state.src.slice(state.pos);
  const match = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(rest);
  if (!match) return false;
  if (!silent) { const token = state.push('wikilink', '', 0); token.meta = { target: match[1].trim(), label: (match[2] || match[1]).trim() }; }
  state.pos += match[0].length; return true;
});
md.renderer.rules.wikilink = (tokens, idx) => { const { target, label } = tokens[idx].meta; return `<a class="wiki-link" data-target="${md.utils.escapeHtml(target)}">${md.utils.escapeHtml(label)}</a>`; };
md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content || tokens[idx].attrGet('alt') || '');
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.JOURNAL_AUDIT_DATA_DIR || path.join(here, '.journal-audit-data');
const configPath = path.join(dataDir, 'config.json');
const defaultStatuses = [
  { key: 'keep', label: 'Keep', color: '#19746e' },
  { key: 'skip', label: 'Skip', color: '#738396' },
  { key: 'delete', label: 'Delete', color: '#b95a51' }
];
let config = { journalFolder: '', vaultFolder: '', statuses: defaultStatuses };
let writeTail = Promise.resolve();
function serialized(fn) {
  const result = writeTail.then(fn, fn);
  writeTail = result.catch(() => {});
  return result;
}
async function loadConfig() {
  try {
    const data = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config = { ...config, ...data, statuses: Array.isArray(data.statuses) && data.statuses.length ? data.statuses : defaultStatuses };
    if (config.journalFolder) config.journalFolder = await realFolder(config.journalFolder);
    if (config.vaultFolder) config.vaultFolder = await realFolder(config.vaultFolder);
  } catch { /* first run */ }
}
async function persistConfig(value = config) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, configPath);
}
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error('Request too large.'); }
  return raw ? JSON.parse(raw) : {};
}
function baseFolder() { if (!config.journalFolder) throw new Error('Choose your journal folder first.'); return config.journalFolder; }
let index;
const undoRecords = new Map();
function vaultIndex() {
  const root = baseFolder();
  const vault = config.vaultFolder || root;
  if (!index || index.journalFolder !== root || index.vaultFolder !== vault) index = new VaultIndex(root, vault, body => md.render(body));
  return index;
}
function rememberUndo(filePath, hash, previous) {
  const token = crypto.randomUUID();
  undoRecords.set(token, { filePath, hash, previous });
  if (undoRecords.size > 32) undoRecords.delete(undoRecords.keys().next().value);
  return token;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === Number(server.address().port);
  } catch { return false; }
}
const server = http.createServer(async (req, res) => {
  try {
    const host = (() => { try { return new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } })();
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return send(res, 403, { error: 'Requests must use the local server address.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/') && req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-origin requests are blocked.' });
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { ...config, ready: !!config.journalFolder });
    if (url.pathname === '/api/config' && req.method === 'POST') return await serialized(async () => {
      const payload = await body(req);
      const next = { ...config };
      if (payload.journalFolder !== undefined) next.journalFolder = payload.journalFolder ? await realFolder(payload.journalFolder) : '';
      if (payload.vaultFolder !== undefined) next.vaultFolder = payload.vaultFolder ? await realFolder(payload.vaultFolder) : '';
      if (next.vaultFolder && next.journalFolder && !isInside(next.vaultFolder, next.journalFolder)) throw new Error('The vault folder must contain the journal folder.');
      if (payload.statuses !== undefined) {
        if (!Array.isArray(payload.statuses) || payload.statuses.length < 1 || payload.statuses.length > 9) throw new Error('Add between 1 and 9 statuses.');
        const keys = new Set();
        next.statuses = payload.statuses.map(s => {
          const key = String(s.key ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
          const label = String(s.label ?? '').trim().slice(0, 32);
          if (!key || !label || keys.has(key)) throw new Error('Each status needs a unique key and a label.');
          keys.add(key); return { key, label, color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#147c78' };
        });
      }
      const removed = config.statuses.filter(status => !next.statuses.some(s => s.key === status.key)).map(status => status.key);
      if (removed.length && next.journalFolder !== config.journalFolder) throw new Error('Save the folder change first, then remove statuses from that folder.');
      const reset = removed.length && config.journalFolder
        ? await resetStatuses(config.journalFolder, removed, path.join(dataDir, 'reset-backups'))
        : { count: 0, backup: null };
      await persistConfig(next);
      config = next;
      if (removed.length) { index = null; undoRecords.clear(); }
      send(res, 200, { ...config, ready: !!config.journalFolder, reset });
    });
    if (url.pathname === '/api/entries' && req.method === 'GET') return await serialized(async () => {
      const current = vaultIndex();
      send(res, 200, { entries: await current.rescan(), statuses: config.statuses });
    });
    if (url.pathname === '/api/entry' && req.method === 'GET') return await serialized(async () => {
      send(res, 200, await vaultIndex().detail(url.searchParams.get('relative')));
    });
    if (url.pathname === '/api/action' && req.method === 'POST') return await serialized(async () => {
      const payload = await body(req);
      const status = config.statuses.find(s => s.key === payload.status);
      if (!status) throw new Error('Choose a configured status.');
      const filePath = await resolveSafeFile(baseFolder(), payload.relative);
      const saved = await saveAudit({ filePath, expectedHash: payload.hash, status: status.key, note: String(payload.note ?? '').slice(0, 4000) });
      const undoToken = rememberUndo(filePath, saved.hash, saved.undo);
      send(res, 200, { hash: saved.hash, undoToken, entry: await vaultIndex().detail(payload.relative) });
    });
    if (url.pathname === '/api/undo' && req.method === 'POST') return await serialized(async () => {
      const payload = await body(req);
      const filePath = await resolveSafeFile(baseFolder(), payload.relative);
      const record = undoRecords.get(payload.undoToken);
      if (!record || record.filePath !== filePath || record.hash !== payload.hash) throw new Error('This Undo action has expired.');
      await undoAudit({ filePath, expectedHash: record.hash, previous: record.previous });
      undoRecords.delete(payload.undoToken);
      send(res, 200, { entry: await vaultIndex().detail(payload.relative) });
    });
    if (url.pathname === '/api/reload' && req.method === 'POST') return await serialized(async () => {
      send(res, 200, { entries: await vaultIndex().rescan(), statuses: config.statuses });
    });
    if (url.pathname === '/' || url.pathname.startsWith('/assets/')) {
      const filename = url.pathname === '/' ? 'index.html' : path.join('public', decodeURIComponent(url.pathname.slice('/assets/'.length)));
      if (url.pathname !== '/' && !url.pathname.startsWith('/assets/')) return send(res, 404, { error: 'Not found.' });
      const full = path.resolve(here, filename);
      if (!full.startsWith(`${path.resolve(here, 'public')}${path.sep}`) && filename !== 'index.html') return send(res, 404, { error: 'Not found.' });
      const file = await fs.readFile(filename === 'index.html' ? path.join(here, 'public/index.html') : full);
      res.writeHead(200, { 'content-type': filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' }); res.end(file); return;
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    const status = error.code === 'INVALID_YAML' ? 422 : error.code === 'CONFLICT' ? 409 : error.code === 'ENOENT' ? 404 : 400;
    send(res, status, { error: error.message, code: error.code });
  }
});
const preferredPort = process.env.PORT === undefined ? 4178 : Number(process.env.PORT);
if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
  throw new Error('PORT must be a number from 1 to 65535.');
}
await loadConfig();
function listen(port) {
  const onListening = () => console.log(`Journal Audit is ready at http://127.0.0.1:${port}`);
  server.once('listening', onListening);
  server.once('error', error => {
    server.off('listening', onListening);
    if (error.code === 'EADDRINUSE' && process.env.PORT === undefined && port < preferredPort + 99) {
      listen(port + 1);
    } else {
      console.error(`Cannot start Journal Audit on port ${port}: ${error.message}`);
      process.exitCode = 1;
    }
  });
  server.listen(port, '127.0.0.1');
}
listen(preferredPort);
