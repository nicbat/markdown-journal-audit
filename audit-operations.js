import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readCleanupManifest, cleanupSource } from './cleanup.js';
import { parseMetadata, scanMarkdown, resolveSafeFile, realFolder, isInside, atomicWrite, hashText } from './journal.js';

export function withoutField(source, field = 'audit_status') {
  const { parts, doc } = parseMetadata(source);
  if (!doc?.has(field)) return source;
  doc.delete(field);
  let yaml = doc.toString({ lineWidth: 0 }).trimEnd();
  if (parts.eol === '\r\n') yaml = yaml.replace(/\r?\n/g, '\r\n');
  const result = `${parts.bom}---${parts.eol}${yaml}${parts.eol}---${parts.eol}${parts.body}`;
  parseMetadata(result); // Refuse removal if another field aliases an anchor on this field.
  return result;
}

export async function resetStatuses(folder, statuses, backupRoot) {
  const keys = new Set(statuses);
  if (!keys.size) return { count: 0, backup: null };
  const root = await realFolder(folder);
  const changes = [];
  for (const relative of await scanMarkdown(root)) {
    const file = await resolveSafeFile(root, relative);
    const source = await fs.readFile(file, 'utf8');
    let parsed;
    try { parsed = parseMetadata(source); }
    catch (error) { throw new Error(`Cannot reset statuses until ${relative} has valid YAML: ${error.message}`); }
    if (keys.has(parsed.metadata.audit_status)) changes.push({ relative, file, source, next: withoutField(source) });
  }
  if (!changes.length) return { count: 0, backup: null };
  const backup = path.join(backupRoot, crypto.randomUUID());
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ folder: root, statuses: [...keys], files: changes.map(c => c.relative) }, null, 2));
  for (const change of changes) {
    const destination = path.join(backup, 'files', change.relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, change.source, { flag: 'wx' });
  }
  let count = 0;
  try {
    for (const change of changes) {
      const file = await resolveSafeFile(root, change.relative);
      if (hashText(await fs.readFile(file, 'utf8')) !== hashText(change.source)) throw new Error(`${change.relative} changed on disk. Rescan and retry.`);
      await atomicWrite(file, change.next); count++;
    }
  } catch (error) {
    throw new Error(`Reset stopped after ${count} of ${changes.length} files: ${error.message} Original files are backed up at ${backup}.`);
  }
  return { count, backup };
}

export async function exportByField(input, output, field = 'audit_status', options = {}) {
  if (!field || typeof field !== 'string') throw new Error('Specify a YAML field name.');
  const root = await realFolder(input);
  const destination = path.join(await fs.realpath(path.dirname(path.resolve(output))), path.basename(path.resolve(output)));
  if (isInside(root, destination)) throw new Error('Choose an output folder outside the input folder.');
  try { await fs.lstat(destination); throw new Error('The output folder already exists. Choose a new folder.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dataDir = options.dataDir ?? process.env.JOURNAL_AUDIT_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.journal-audit-data');
  const cleanup = await readCleanupManifest(dataDir, root);
  const planned = [], groups = new Map(), names = new Map(), counts = new Map();
  for (const relative of await scanMarkdown(root)) {
    const source = await fs.readFile(await resolveSafeFile(root, relative), 'utf8');
    let metadata;
    try { metadata = parseMetadata(source).metadata; }
    catch (error) { throw new Error(`${relative}: ${error.message}`); }
    const value = metadata[field];
    if (value !== null && typeof value === 'object') throw new Error(`${relative}: ${field} must be text, a number, or a boolean.`);
    const missing = value === undefined || value === null || value === '';
    const key = missing ? null : String(value);
    let group = groups.get(key);
    if (!group) {
      const cleaned = missing ? 'unreviewed' : String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
      group = cleaned || 'status';
      if (!missing && (group !== key || group.toLowerCase() === 'unreviewed' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(group) || names.has(group.toLowerCase()))) {
        group = `status-${group}-${hashText(key).slice(0, 10)}`;
      }
      const base = group;
      let suffix = 2;
      while (names.has(group.toLowerCase())) group = `${base}-${suffix++}`;
      groups.set(key, group); names.set(group.toLowerCase(), key);
    }
    let cleaned;
    try { cleaned = cleanupSource(withoutField(source, field), Object.hasOwn(cleanup.files, relative) ? cleanup.files[relative] : null); }
    catch (error) { throw new Error(`${relative}: ${error.message}`); }
    planned.push({ relative, group, content: cleaned, cleaned: !!cleanup.files[relative]?.marks?.length });
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  // Preflight all YAML before creating output; wx never overwrites a copy.
  const result = { output: destination, count: planned.length, cleanedCount: planned.filter(p => p.cleaned).length, dryRun: !!options.dryRun, groups: [...groups].map(([value, folder]) => ({ value, folder, count: counts.get(folder) })) };
  if (options.dryRun) return result;
  await fs.mkdir(destination);
  try {
    for (const item of planned) {
      const file = path.join(destination, item.group, item.relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, item.content, { flag: 'wx' });
    }
  } catch (error) { throw new Error(`Export stopped; partial copies remain at ${destination}: ${error.message}`); }
  return result;
}
