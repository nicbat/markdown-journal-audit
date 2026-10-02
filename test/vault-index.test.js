import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultIndex } from '../vault-index.js';
import { saveAudit, undoAudit } from '../journal.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journals = path.join(root, 'Daily');
  await fs.mkdir(journals);
  await fs.writeFile(path.join(journals, 'day.md'), '---\ntags: [journal]\n---\n# Day\n\n[[Reference]]\n');
  await fs.writeFile(path.join(root, 'Reference.md'), '[[Daily/day]] [[Daily/day]]');
  const index = new VaultIndex(journals, root, text => `<p>${text}</p>`);
  return { root, journals, index };
}

test('summary index skips rendering; unchanged rescans reuse parsed files and detail rendering', async t => {
  const { index } = await fixture(t);
  const [summary] = await index.rescan();
  assert.equal(summary.incoming, 1);
  assert.equal(summary.linkCount, 1);
  for (const field of ['source', 'body', 'rendered', 'links']) assert.equal(field in summary, false);
  assert.deepEqual(index.stats, { reads: 2, renders: 0 });
  const detail = await index.detail('day.md');
  assert.equal(detail.links[0].resolves, true);
  assert.equal((await index.detail('day.md')).rendered, detail.rendered);
  await index.rescan();
  assert.deepEqual(index.stats, { reads: 2, renders: 1 });
});

test('save/undo invalidate metadata while retaining unchanged Markdown rendering', async t => {
  const { index, journals } = await fixture(t);
  const before = await index.detail('day.md');
  const filePath = path.join(journals, 'day.md');
  const saved = await saveAudit({ filePath, expectedHash: before.hash, status: 'keep', note: 'Remember' });
  const after = await index.detail('day.md');
  assert.equal(after.metadata.audit_status, 'keep');
  assert.match(after.source, /audit_note: Remember/);
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.body, before.body);
  assert.equal(index.stats.renders, 1);
  await undoAudit({ filePath, expectedHash: after.hash, previous: saved.undo });
  assert.equal((await index.detail('day.md')).source, before.source);
  assert.equal(index.stats.renders, 1);
});

test('rescan detects edits, new files and deleted files; backlinks are rebuilt', async t => {
  const { index, root, journals } = await fixture(t);
  await index.detail('day.md');
  await fs.writeFile(path.join(root, 'Reference.md'), 'No links');
  await fs.writeFile(path.join(journals, 'day.md'), '# Changed content');
  await fs.writeFile(path.join(journals, 'new.md'), '[[day]]');
  const entries = await index.rescan();
  assert.equal(entries.length, 2);
  assert.equal(entries.find(e => e.name === 'day').incoming, 1);
  assert.match((await index.detail('day.md')).rendered, /Changed content/);
  await fs.unlink(path.join(journals, 'new.md'));
  await index.rescan();
  assert.equal(index.summaries().length, 1);
  assert.equal(index.summaries()[0].incoming, 0);
});

test('invalid YAML stays visible, duplicate basenames stay ambiguous, symlinks are ignored', async t => {
  const { index, root, journals } = await fixture(t);
  await fs.mkdir(path.join(root, 'Other'));
  await fs.writeFile(path.join(root, 'Other', 'Reference.md'), 'Another reference');
  await fs.writeFile(path.join(journals, 'bad.md'), '---\ntitle: [broken\n---\nBody');
  await fs.symlink(path.join(journals, 'day.md'), path.join(journals, 'alias.md'));
  const entries = await index.rescan();
  assert.equal(entries.length, 2);
  assert.match(entries.find(e => e.name === 'bad').error, /invalid/);
  // An exact vault-root path still resolves despite duplicate basenames.
  assert.equal((await index.detail('day.md')).links[0].resolves, true);
  await fs.rename(path.join(root, 'Reference.md'), path.join(root, 'Other', 'First.md'));
  await fs.mkdir(path.join(root, 'Second'));
  await fs.writeFile(path.join(root, 'Second', 'Reference.md'), 'Duplicate');
  await index.rescan();
  assert.equal((await index.detail('day.md')).links[0].resolves, false);
  await assert.rejects(index.detail('../Reference.md'));
});
