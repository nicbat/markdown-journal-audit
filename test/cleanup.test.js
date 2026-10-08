import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCleanup, removeMarked, CleanupStore, cleanupManifestPath } from '../cleanup.js';
import { exportByField } from '../audit-operations.js';
import { saveAudit, hashText } from '../journal.js';

const mark = (block, section = false) => ({ id: block.id, section });
test('heading-only and section ranges preserve CRLF, nested boundaries and overlapping marks', () => {
  const body = '# Day\r\n\r\nJournal.\r\n\r\n## Logs\r\n\r\nLog.\r\n\r\n### Detail\r\n\r\nMore.\r\n\r\n## Thoughts\r\n\r\nKeep.\r\n';
  const { blocks, rendered } = parseCleanup(body);
  const headings = blocks.filter(b => b.type === 'heading');
  assert.equal(removeMarked(body, blocks, [mark(headings[0])]), body.slice('# Day\r\n'.length));
  const marks = [mark(headings[1], true), mark(headings[2], true)];
  assert.equal(removeMarked(body, blocks, marks), body.slice(0, body.indexOf('## Logs')) + body.slice(body.indexOf('## Thoughts')));
  assert.ok(rendered.includes(`data-cleanup-id="${headings[0].id}"`));
});

test('nested list selections keep siblings and quote/code/table remain whole blocks', () => {
  const body = '- parent\n  - child one\n  - child two\n- sibling\n\n> quote\n> continued\n\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const { blocks, rendered } = parseCleanup(body);
  const items = blocks.filter(b => b.type === 'list_item');
  assert.equal(items.length, 4);
  assert.equal(removeMarked(body, blocks, [mark(items[1])]), body.replace('  - child one\n', ''));
  assert.equal(removeMarked(body, blocks, [mark(items[0])]), body.slice(body.indexOf('- sibling')));
  assert.deepEqual(blocks.slice(4).map(b => b.type), ['quote', 'code', 'table']);
  for (const b of blocks) assert.ok(rendered.includes(`data-cleanup-id="${b.id}"`));
  assert.throws(() => removeMarked(body, blocks, [mark(items[0], true)]), /Invalid/);
});

test('persistent marks, optimistic revisions, body conflicts and unified export', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'journals'), dataDir = path.join(temp, 'data');
  await fs.mkdir(root);
  const file = path.join(root, 'day.md');
  const original = '---\naudit_status: keep\naudit_note: Retain this\n---\n# Day\n\nKeep prose.\n\n## Logs\n\nDelete logs.\n';
  await fs.writeFile(file, original);
  let store = new CleanupStore(dataDir);
  let detail = await store.detail(root, 'day.md');
  const initial = detail;
  const logs = detail.blocks.find(b => b.type === 'heading' && b.level === 2);
  detail = await store.detail(root, 'day.md', { ...detail, marks: [mark(logs, true)] });
  assert.equal(detail.revision, 1);
  assert.ok(!detail.preview.includes('Delete logs'));
  await assert.rejects(store.detail(root, 'day.md', { ...initial, marks: [] }), /changed/);
  store = new CleanupStore(dataDir);
  assert.deepEqual((await store.detail(root, 'day.md')).marks, detail.marks);
  await saveAudit({ filePath: file, expectedHash: hashText(original), status: 'edit', note: 'Retain this' });
  assert.equal((await store.detail(root, 'day.md')).stale, false);
  const output = path.join(temp, 'export');
  const dry = await exportByField(root, output, 'audit_status', { dataDir, dryRun: true });
  assert.equal(dry.cleanedCount, 1);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  await exportByField(root, output, 'audit_status', { dataDir });
  const copy = await fs.readFile(path.join(output, 'edit/day.md'), 'utf8');
  assert.ok(copy.includes('Keep prose.'));
  assert.ok(copy.includes('audit_note: Retain this'));
  assert.ok(!copy.includes('audit_status'));
  assert.ok(!copy.includes('Delete logs'));
  assert.ok((await fs.readFile(file, 'utf8')).includes('Delete logs'));
  await fs.appendFile(file, '\nExternal edit.\n');
  detail = await store.detail(root, 'day.md');
  assert.equal(detail.stale, true);
  assert.equal(detail.preview, null);
  await assert.rejects(store.detail(root, 'day.md', { ...detail, marks: [] }), /stale/);
  const blockedOutput = path.join(temp, 'blocked');
  await assert.rejects(exportByField(root, blockedOutput, 'audit_status', { dataDir }), /day.md.*stale/);
  await assert.rejects(fs.stat(blockedOutput), { code: 'ENOENT' });
  detail = await store.detail(root, 'day.md', { ...detail, reset: true, marks: [] });
  assert.equal(detail.stale, false);
  assert.equal(detail.marks.length, 0);
  assert.ok((await fs.readFile(cleanupManifestPath(dataDir, root), 'utf8')).includes('"revision": 2'));
});

test('export does not reinterpret a surviving thematic break and prose as frontmatter', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-break-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'journals'), dataDir = path.join(temp, 'data');
  await fs.mkdir(root);
  const original = '# Intro\n---\naudit_status: secret\n---\n';
  await fs.writeFile(path.join(root, 'day.md'), original);
  const store = new CleanupStore(dataDir);
  const detail = await store.detail(root, 'day.md');
  await store.detail(root, 'day.md', { ...detail, marks: [mark(detail.blocks[0])] });
  const output = path.join(temp, 'output');
  await exportByField(root, output, 'audit_status', { dataDir });
  assert.equal(await fs.readFile(path.join(output, 'unreviewed/day.md'), 'utf8'), '\n---\naudit_status: secret\n---\n');
});

test('concurrent stores cannot overwrite each other’s revision', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-lock-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'journals'), dataDir = path.join(temp, 'data');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'day.md'), '# Day\n\nProse.\n');
  const first = new CleanupStore(dataDir), second = new CleanupStore(dataDir);
  const detail = await first.detail(root, 'day.md');
  const payload = { ...detail, marks: [mark(detail.blocks[0])] };
  const results = await Promise.allSettled([first.detail(root, 'day.md', payload), second.detail(root, 'day.md', payload)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal((await second.detail(root, 'day.md')).revision, 1);
});
