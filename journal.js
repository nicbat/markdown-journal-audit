import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';

export const AUDIT_FIELDS = ['audit_status', 'audit_note'];
export const hashText = text => crypto.createHash('sha256').update(text).digest('hex');

export function splitJournal(source) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const start = bom.length;
  const opening = /^(---)(\r?\n)/.exec(source.slice(start));
  if (!opening) return { hasFrontmatter: false, bom: '', body: source, eol: source.includes('\r\n') ? '\r\n' : '\n' };
  const eol = opening[2];
  const contentStart = start + opening[0].length;
  const close = /^(---)(?:\r?\n|$)/gm;
  close.lastIndex = contentStart;
  const match = close.exec(source);
  if (!match) return { hasFrontmatter: true, malformed: true, bom, body: '', frontmatter: source.slice(contentStart), eol };
  const closeLineStart = match.index;
  return {
    hasFrontmatter: true,
    bom,
    frontmatter: source.slice(contentStart, closeLineStart).replace(/\r?\n$/, ''),
    body: source.slice(match.index + match[0].length),
    eol
  };
}

export function parseMetadata(source) {
  const parts = splitJournal(source);
  if (!parts.hasFrontmatter) return { metadata: {}, parts };
  if (parts.malformed) { const error = new Error('Frontmatter starts with --- but has no closing --- line. Add the closing delimiter before saving.'); error.code = 'INVALID_YAML'; throw error; }
  const doc = YAML.parseDocument(parts.frontmatter, { keepSourceTokens: true, uniqueKeys: true });
  if (doc.errors.length) {
    const error = new Error(`Frontmatter YAML is invalid: ${doc.errors[0].message}`);
    error.code = 'INVALID_YAML';
    throw error;
  }
  if (doc.contents && !YAML.isMap(doc.contents)) {
    const error = new Error('Frontmatter must be a YAML mapping.');
    error.code = 'INVALID_YAML';
    throw error;
  }
  return { metadata: doc.toJS() ?? {}, parts, doc };
}

export async function readJournal(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  const { metadata, parts } = parseMetadata(source);
  return { source, hash: hashText(source), body: parts.body, metadata, hasFrontmatter: parts.hasFrontmatter };
}

function updateAuditSource(source, status, note) {
  const parsed = parseMetadata(source);
  const { parts } = parsed;
  const doc = parsed.doc ?? new YAML.Document({});
  doc.contents ??= new YAML.YAMLMap();
  doc.set('audit_status', status);
  if (note?.trim()) doc.set('audit_note', note.trim());
  else doc.delete('audit_note');
  let yaml = doc.toString({ lineWidth: 0 }).trimEnd();
  if (parts.eol === '\r\n') yaml = yaml.replace(/\r?\n/g, '\r\n');
  if (parts.hasFrontmatter) return `${parts.bom}---${parts.eol}${yaml}${parts.eol}---${parts.eol}${parts.body}`;
  return `${parts.bom}---${parts.eol}${yaml}${parts.eol}---${parts.eol}${source}`;
}

export async function atomicWrite(filePath, content) {
  const temp = `${filePath}.audit-${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`;
  const stat = await fs.stat(filePath);
  try {
    await fs.writeFile(temp, content, { mode: stat.mode });
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function saveAudit({ filePath, expectedHash, status, note = '' }) {
  const current = await fs.readFile(filePath, 'utf8');
  if (hashText(current) !== expectedHash) {
    const error = new Error('This journal changed on disk. Reload it before saving.');
    error.code = 'CONFLICT';
    throw error;
  }
  const next = updateAuditSource(current, status, note);
  await atomicWrite(filePath, next);
  const old = parseMetadata(current).metadata;
  return {
    hash: hashText(next),
    undo: { source: current, fields: Object.fromEntries(AUDIT_FIELDS.map(field => [field, Object.hasOwn(old, field) ? { present: true, value: old[field] } : { present: false }])) }
  };
}

export async function undoAudit({ filePath, expectedHash, previous }) {
  const current = await fs.readFile(filePath, 'utf8');
  if (hashText(current) !== expectedHash) {
    const error = new Error('This journal changed after your review action. Undo was stopped to protect the newer edit.');
    error.code = 'CONFLICT';
    throw error;
  }
  if (typeof previous?.source === 'string') {
    await atomicWrite(filePath, previous.source);
    return { hash: hashText(previous.source) };
  }
  const parsed = parseMetadata(current);
  const snapshot = previous?.fields ?? previous;
  const doc = parsed.doc ?? new YAML.Document({});
  doc.contents ??= new YAML.YAMLMap();
  for (const field of AUDIT_FIELDS) {
    if (snapshot[field]?.present) doc.set(field, snapshot[field].value);
    else doc.delete(field);
  }
  const eol = parsed.parts.eol;
  let yaml = doc.toString({ lineWidth: 0 }).trimEnd();
  if (eol === '\r\n') yaml = yaml.replace(/\r?\n/g, '\r\n');
  const restored = parsed.parts.hasFrontmatter
    ? `${parsed.parts.bom}---${eol}${yaml}${eol}---${eol}${parsed.parts.body}`
    : `${parsed.parts.bom}---${eol}${yaml}${eol}---${eol}${current}`;
  await atomicWrite(filePath, restored);
  return { hash: hashText(restored) };
}

export async function realFolder(folder) {
  const resolved = await fs.realpath(folder);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Choose a folder.');
  return resolved;
}

export function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export async function resolveSafeFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid journal path.');
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) throw new Error('Journal path is outside the selected folder.');
  const real = await fs.realpath(candidate);
  if (!isInside(root, real)) throw new Error('Journal symlink points outside the selected folder.');
  const stat = await fs.stat(real);
  if (!stat.isFile() || path.extname(real).toLowerCase() !== '.md') throw new Error('Choose a Markdown file.');
  return real;
}

const IGNORED = new Set(['.obsidian', '.git', 'node_modules', '.trash']);
export async function scanMarkdown(root) {
  const output = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.journal-audit')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(path.relative(root, absolute));
    }
  }
  await walk(root);
  return output.sort((a, b) => a.localeCompare(b));
}

export function extractWikilinks(markdown) {
  const found = [];
  for (const match of markdown.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) found.push({ target: match[1].trim(), label: match[2]?.trim() || match[1].trim() });
  return found;
}
