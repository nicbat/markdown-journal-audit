// Reproducible HTTP benchmark. All reads/writes are confined to a disposable vault.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const count = Number(process.argv[2] || 600);
if (!Number.isInteger(count) || count < 2 || count > 10000) throw new Error('Pass a journal count between 2 and 10000.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-audit-benchmark-'));
const journals = path.join(root, 'vault', 'Daily');
const notes = path.join(root, 'vault', 'Notes');
const config = path.join(root, 'config');
let child;
try {
  await Promise.all([fs.mkdir(journals, { recursive: true }), fs.mkdir(notes, { recursive: true }), fs.mkdir(config)]);
  const paragraph = 'A synthetic journal reflects on work, reading, and small observations from the day. Keeping these details helps make sense of the week.\n\n';
  for (let i = 0; i < count * 6; i++) {
    const journal = i < count;
    const name = String(journal ? i : i - count).padStart(5, '0');
    const links = Array.from({ length: 8 }, (_, j) => `[[Daily/${String((i + j) % count).padStart(5, '0')}]]`).join(' ');
    await fs.writeFile(path.join(journal ? journals : notes, `${name}.md`), `---\ntags: [journal, sample]\n---\n# Entry ${name}\n\n${paragraph.repeat(journal ? 30 : 3)}${links}\n`);
  }
  await fs.writeFile(path.join(config, 'config.json'), JSON.stringify({ journalFolder: journals, vaultFolder: path.dirname(journals) }));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, ['server.js'], { cwd: here, env: { ...process.env, PORT: String(port), JOURNAL_AUDIT_DATA_DIR: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('is ready')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.once('error', reject);
  });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  const timings = {};
  const timed = async (label, fn) => { const start = performance.now(); const result = await fn(); timings[label] = +(performance.now() - start).toFixed(1); return result; };
  const summary = await timed('coldIndexMs', () => request('/api/entries'));
  await timed('rescanUnchangedMs', () => request('/api/reload', {}));
  const relative = summary.entries[0].relative;
  const before = await timed('firstEntryMs', () => request(`/api/entry?relative=${encodeURIComponent(relative)}`));
  await timed('cachedEntryMs', () => request(`/api/entry?relative=${encodeURIComponent(relative)}`));
  const saved = await timed('saveMs', () => request('/api/action', { relative, hash: before.hash, status: 'keep', note: 'Benchmark' }));
  const undone = await timed('undoMs', () => request('/api/undo', { relative, hash: saved.hash, undoToken: saved.undoToken }));
  assert.equal(undone.entry.source, before.source);
  console.log(JSON.stringify({ journals: count, vaultFiles: count * 6, summaryBytes: Buffer.byteLength(JSON.stringify(summary)), ...timings }, null, 2));
} finally {
  if (child && child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
  await fs.rm(root, { recursive: true, force: true });
}
