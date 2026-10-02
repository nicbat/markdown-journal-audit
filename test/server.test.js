import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('summary/detail API, compact undo, cached conflict checks and external refresh', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-server-test-'));
  const journals = path.join(root, 'journals');
  const config = path.join(root, 'config');
  await fs.mkdir(journals); await fs.mkdir(config);
  const original = '# Long journal\n' + 'A memory worth preserving.\n'.repeat(5000);
  const file = path.join(journals, 'day.md');
  await fs.writeFile(file, original);
  await fs.writeFile(path.join(config, 'config.json'), JSON.stringify({ journalFolder: journals, vaultFolder: journals }));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: here, env: { ...process.env, PORT: String(port), JOURNAL_AUDIT_DATA_DIR: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Startup timed out')), 10000);
    child.stdout.on('data', data => { if (data.toString().includes('is ready')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Exited ${code}`)); });
  });
  async function api(route, data) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {});
    return { status: response.status, data: await response.json() };
  }
  let response = await api('/api/entries');
  assert.equal(response.data.entries.length, 1);
  assert.equal('source' in response.data.entries[0], false);
  assert.equal('rendered' in response.data.entries[0], false);
  const before = (await api('/api/entry?relative=day.md')).data;
  const saved = (await api('/api/action', { relative: 'day.md', hash: before.hash, status: 'keep', note: 'A note' })).data;
  assert.equal(saved.entry.metadata.audit_status, 'keep');
  assert.equal(typeof saved.undoToken, 'string');
  assert.equal('undo' in saved, false);
  assert.equal((await api('/api/action', { relative: 'day.md', hash: before.hash, status: 'delete' })).status, 409);
  assert.equal((await api('/api/undo', { relative: 'day.md', hash: saved.hash, undoToken: 'invalid' })).status, 400);
  const undone = await api('/api/undo', { relative: 'day.md', hash: saved.hash, undoToken: saved.undoToken });
  assert.equal(undone.status, 200); assert.equal(undone.data.entry.source, original);
  await fs.appendFile(file, '\nExternal change.');
  assert.equal((await api('/api/action', { relative: 'day.md', hash: undone.data.entry.hash, status: 'delete' })).status, 409);
  await fs.writeFile(path.join(journals, 'new.md'), '# New entry');
  response = await api('/api/entries');
  assert.equal(response.data.entries.length, 2);
  assert.notEqual(response.data.entries.find(entry => entry.relative === 'day.md').hash, before.hash);
  assert.equal((await api('/api/entry?relative=../config/config.json')).status, 400);
});
