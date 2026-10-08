import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetStatuses, exportByField, withoutField } from '../audit-operations.js';
import { parseMetadata, splitJournal } from '../journal.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-operations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'); await fs.mkdir(input);
  return { root, input };
}
test('reset backs up exact originals and preserves comments, review notes and CRLF bodies', async t => {
  const { root, input } = await fixture(t);
  const original = '\uFEFF---\r\naudit_status: keep\r\naudit_note: remember\r\ntitle: Day # comment\r\n---\r\n\r\nBody without final newline';
  await fs.writeFile(path.join(input, 'a.md'), original);
  const other = '---\naudit_status: skip\n---\nOther';
  await fs.writeFile(path.join(input, 'b.md'), other);
  const result = await resetStatuses(input, ['keep'], path.join(root, 'backups'));
  assert.equal(result.count, 1);
  assert.equal(await fs.readFile(path.join(result.backup, 'files/a.md'), 'utf8'), original);
  const updated = await fs.readFile(path.join(input, 'a.md'), 'utf8');
  assert.deepEqual(parseMetadata(updated).metadata, { audit_note: 'remember', title: 'Day' });
  assert.equal(splitJournal(updated).body, splitJournal(original).body);
  assert.ok(updated.startsWith('\uFEFF---\r\n')); assert.match(updated, /# comment/);
  assert.equal(await fs.readFile(path.join(input, 'b.md'), 'utf8'), other);
});
test('invalid YAML preflight prevents any reset or export writes', async t => {
  const { root, input } = await fixture(t);
  const original = '---\naudit_status: keep\n---\nBody';
  await fs.writeFile(path.join(input, 'a.md'), original);
  await fs.writeFile(path.join(input, 'z.md'), '---\nbroken: [\n---\nBody');
  await assert.rejects(resetStatuses(input, ['keep'], path.join(root, 'backups')), /valid YAML/);
  await assert.rejects(exportByField(input, path.join(root, 'output')), /z.md/);
  assert.equal(await fs.readFile(path.join(input, 'a.md'), 'utf8'), original);
  await assert.rejects(fs.stat(path.join(root, 'output')), { code: 'ENOENT' });
});
test('export groups copies, keeps paths and originals, and strips only requested field', async t => {
  const { root, input } = await fixture(t);
  await fs.mkdir(path.join(input, 'nested'));
  const files = { 'a.md': '---\naudit_status: keep\naudit_note: remember\n---\nA', 'nested/a.md': '---\naudit_status: keep\n---\nB', 'bare.md': '# Bare' };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(input, name), source);
  const output = path.join(root, 'output');
  const result = await exportByField(input, output);
  assert.equal(result.count, 3);
  for (const [name, source] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(input, name), 'utf8'), source);
    const copy = await fs.readFile(path.join(output, name === 'bare.md' ? 'unreviewed' : 'keep', name), 'utf8');
    assert.equal(splitJournal(copy).body, splitJournal(source).body);
    assert.equal(parseMetadata(copy).metadata.audit_status, undefined);
  }
  assert.equal(parseMetadata(await fs.readFile(path.join(output, 'keep/a.md'), 'utf8')).metadata.audit_note, 'remember');
  await assert.rejects(exportByField(input, output), /already exists/);
  await assert.rejects(exportByField(input, path.join(input, 'output')), /outside/);
  assert.deepEqual(parseMetadata(withoutField('---\ncategory: work\naudit_status: keep\n---\nBody', 'category')).metadata, { audit_status: 'keep' });
});
test('export handles unsafe, case-colliding and reserved categories separately', async t => {
  const { root, input } = await fixture(t);
  const values = ['../outside', 'Keep', 'keep', 'unreviewed', null, 'CON'];
  for (const [i, value] of values.entries()) await fs.writeFile(path.join(input, `${i}.md`), `---\ncategory: ${JSON.stringify(value)}\n---\nBody`);
  const result = await exportByField(input, path.join(root, 'output'), 'category');
  assert.equal(new Set(result.groups.map(g => g.folder.toLowerCase())).size, values.length);
  for (const group of result.groups) {
    assert.ok(!/[\\/]/.test(group.folder));
    const copy = await fs.readFile(path.join(result.output, group.folder, `${values.indexOf(group.value)}.md`), 'utf8');
    assert.equal(parseMetadata(copy).metadata.category, undefined);
  }
});
