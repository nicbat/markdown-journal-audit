import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashText, readJournal, saveAudit, splitJournal, undoAudit, resolveSafeFile } from '../journal.js';

async function tempFolder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('metadata save preserves CRLF body, comments, and unrelated YAML fields', async t => {
  const root = await tempFolder(t); const file = path.join(root, 'entry.md');
  const body = '\r\nA journal body with [[Another note]].\r\n\r\nTrailing line stays.\r\n';
  const original = `---\r\ntitle: A day # title comment\r
tags:\r\n  - one\r\n# personal note\r
mood: calm\r\n---\r\n${body}`;
  await fs.writeFile(file, original);
  const loaded = await readJournal(file);
  const saved = await saveAudit({ filePath: file, expectedHash: loaded.hash, status: 'keep', note: 'Read again' });
  const after = await fs.readFile(file, 'utf8');
  assert.equal(splitJournal(after).body, body);
  assert.match(after, /title: A day # title comment/);
  assert.match(after, /# personal note/);
  assert.match(after, /mood: calm/);
  assert.match(after, /audit_status: keep/);
  assert.match(after, /audit_note: Read again/);
  await undoAudit({ filePath: file, expectedHash: saved.hash, previous: saved.undo });
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('file without frontmatter gets YAML while keeping original body bytes and undo restores exact file', async t => {
  const root = await tempFolder(t); const file = path.join(root, 'bare.md');
  const original = 'First line\r\n\r\nBody with no final newline';
  await fs.writeFile(file, original);
  const loaded = await readJournal(file);
  const saved = await saveAudit({ filePath: file, expectedHash: loaded.hash, status: 'skip' });
  const after = await fs.readFile(file, 'utf8');
  assert.equal(splitJournal(after).body, original);
  await undoAudit({ filePath: file, expectedHash: saved.hash, previous: saved.undo });
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('invalid and unterminated frontmatter refuses to write', async t => {
  const root = await tempFolder(t); const file = path.join(root, 'bad.md');
  for (const original of ['---\ntitle: [broken\n---\nbody', '---\ntitle: ok\nbody without closing delimiter']) {
    await fs.writeFile(file, original);
    await assert.rejects(saveAudit({ filePath: file, expectedHash: hashText(original), status: 'keep' }), { code: 'INVALID_YAML' });
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
});

test('save and undo stop on external edits', async t => {
  const root = await tempFolder(t); const file = path.join(root, 'entry.md');
  await fs.writeFile(file, '---\ntitle: day\n---\nbody\n');
  const loaded = await readJournal(file);
  await fs.appendFile(file, 'external\n');
  await assert.rejects(saveAudit({ filePath: file, expectedHash: loaded.hash, status: 'keep' }), { code: 'CONFLICT' });
  const current = await readJournal(file);
  const saved = await saveAudit({ filePath: file, expectedHash: current.hash, status: 'keep' });
  await fs.appendFile(file, 'another external edit\n');
  await assert.rejects(undoAudit({ filePath: file, expectedHash: saved.hash, previous: saved.undo }), { code: 'CONFLICT' });
});

test('file resolver rejects traversal and symlinks escaping the selected folder', async t => {
  const root = await tempFolder(t); const outside = await tempFolder(t);
  await fs.writeFile(path.join(root, 'inside.md'), 'ok');
  await fs.writeFile(path.join(outside, 'secret.md'), 'private');
  await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));
  await assert.rejects(resolveSafeFile(root, '../secret.md'));
  await assert.rejects(resolveSafeFile(root, 'linked.md'));
  assert.equal(await resolveSafeFile(root, 'inside.md'), path.join(root, 'inside.md'));
});
