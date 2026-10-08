import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { hashText, parseMetadata, resolveSafeFile } from './journal.js';

const fallbackMarkdown = new MarkdownIt({ html: false });
const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' });
export const cleanupManifestPath = (dataDir, root) => path.join(dataDir, 'cleanup', `${hashText(root)}.json`);

export async function readCleanupManifest(dataDir, root) {
  try {
    const value = JSON.parse(await fs.readFile(cleanupManifestPath(dataDir, root), 'utf8'));
    if (value.version !== 1 || value.root !== root || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('Invalid cleanup manifest.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, root, files: {} };
    throw error;
  }
}

// Token maps count normalized lines; offsets point into the untouched original source.
export function parseCleanup(body, md = fallbackMarkdown) {
  const offsets = [0];
  for (const match of body.matchAll(/\r\n|\r|\n/g)) offsets.push(match.index + match[0].length);
  const offset = line => offsets[line] ?? body.length;
  const tokens = md.parse(body, {}), blocks = [];
  let quoteDepth = 0, tableDepth = 0, listDepth = 0;
  for (const token of tokens) {
    const type = token.type;
    const suppressed = quoteDepth > 0 || tableDepth > 0;
    let kind;
    if (!suppressed && token.map) {
      if (type === 'list_item_open') kind = 'list_item';
      else if (!listDepth && type === 'heading_open') kind = 'heading';
      else if (!listDepth && type === 'paragraph_open') kind = 'paragraph';
      else if (!listDepth && type === 'blockquote_open') kind = 'quote';
      else if (!listDepth && type === 'table_open') kind = 'table';
      else if (!listDepth && ['fence', 'code_block', 'hr'].includes(type)) kind = type === 'hr' ? 'divider' : 'code';
    }
    if (kind) {
      const start = offset(token.map[0]), end = offset(token.map[1]);
      const id = `${kind}-${start}-${end}`;
      const block = { id, start, end, type: kind };
      if (kind === 'heading') block.level = Number(token.tag.slice(1));
      blocks.push(block);
      token.attrSet('data-cleanup-id', id);
      // Some code renderers ignore attributes; wrap just these leaf blocks.
      if (['fence', 'code_block'].includes(type)) {
        token.meta = { ...token.meta, cleanupId: id };
      }
    }
    if (type === 'blockquote_open') quoteDepth++;
    if (type === 'blockquote_close') quoteDepth--;
    if (type === 'table_open') tableDepth++;
    if (type === 'table_close') tableDepth--;
    if (type === 'list_item_open') listDepth++;
    if (type === 'list_item_close') listDepth--;
  }
  const headings = blocks.filter(block => block.type === 'heading');
  const openSections = [];
  for (const heading of headings) {
    while (openSections.length && openSections.at(-1).level >= heading.level) openSections.pop().sectionEnd = heading.start;
    openSections.push(heading);
  }
  for (const heading of openSections) heading.sectionEnd = body.length;
  // Render without changing the shared MarkdownIt renderer (normal journal rendering stays untouched).
  const rendered = tokens.map((token, i) => {
    if (token.meta?.cleanupId && token.nesting === 0) {
      return `<div data-cleanup-id="${token.meta.cleanupId}">${md.renderer.render([token], md.options, {})}</div>`;
    }
    if (token.type === 'inline') return md.renderer.renderInline(token.children, md.options, {});
    const rule = md.renderer.rules[token.type];
    return rule ? rule(tokens, i, md.options, {}, md.renderer) : md.renderer.renderToken(tokens, i, md.options);
  }).join('');
  return { bodyHash: hashText(body), blocks, rendered };
}

export function markedRanges(blocks, marks) {
  if (!Array.isArray(marks)) throw new Error('Cleanup marks must be a list.');
  const byId = new Map(blocks.map(block => [block.id, block]));
  const seen = new Set();
  const ranges = marks.map(mark => {
    const block = byId.get(mark?.id);
    if (!block || typeof mark.section !== 'boolean' || (mark.section && block.type !== 'heading') || seen.has(mark.id)) throw new Error('Invalid or duplicate cleanup selection. Reload the note.');
    seen.add(mark.id);
    return [block.start, mark.section ? block.sectionEnd : block.end];
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
export function removeMarked(body, blocks, marks) {
  let result = '', at = 0;
  for (const [start, end] of markedRanges(blocks, marks)) { result += body.slice(at, start); at = end; }
  return result + body.slice(at);
}
export function cleanupSource(source, record) {
  if (!record?.marks?.length) return source;
  const { parts } = parseMetadata(source);
  if (hashText(parts.body) !== record.bodyHash) throw conflict('Cleanup marks are stale. Re-review or reset this note before export.');
  const parsed = parseCleanup(parts.body);
  const cleaned = removeMarked(parts.body, parsed.blocks, record.marks);
  // A newly leading thematic break must not turn surviving journal text into YAML.
  const prefix = !parts.hasFrontmatter && /^(?:\uFEFF)?---\r?\n/.test(cleaned) ? parts.eol : '';
  return source.slice(0, source.length - parts.body.length) + prefix + cleaned;
}

export class CleanupStore {
  constructor(dataDir, md = fallbackMarkdown) { this.dataDir = dataDir; this.md = md; this.cache = new Map(); }
  parse(body) {
    const hash = hashText(body);
    if (this.cache.has(hash)) return this.cache.get(hash);
    const parsed = parseCleanup(body, this.md);
    this.cache.set(hash, parsed);
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    return parsed;
  }
  async detail(root, relative, payload) {
    // Shared data directories may be served by multiple local app instances.
    if (!payload) return this.readOrUpdate(root, relative);
    const lock = `${cleanupManifestPath(this.dataDir, root)}.lock`;
    await fs.mkdir(path.dirname(lock), { recursive: true });
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw conflict(`Another cleanup save is in progress. Retry shortly. If a previous process crashed, remove the stale lock at ${lock}.`);
      throw error;
    }
    try { return await this.readOrUpdate(root, relative, payload); }
    finally { await handle.close(); await fs.rm(lock, { force: true }); }
  }
  async readOrUpdate(root, relative, payload) {
    const filePath = await resolveSafeFile(root, relative);
    const canonical = path.relative(root, filePath);
    if (relative !== canonical) throw new Error('Use the journal’s canonical relative path.');
    const source = await fs.readFile(filePath, 'utf8');
    const body = parseMetadata(source).parts.body;
    const parsed = this.parse(body);
    const manifest = await readCleanupManifest(this.dataDir, root);
    let record = Object.hasOwn(manifest.files, relative) ? manifest.files[relative] : null;
    let stale = !!record?.marks?.length && record.bodyHash !== parsed.bodyHash;
    if (payload) {
      if (payload.bodyHash !== parsed.bodyHash || payload.revision !== (record?.revision ?? 0)) throw conflict('This note or its cleanup marks changed. Reload before marking.');
      if (stale && !payload.reset) throw conflict('Cleanup marks are stale. Reset them before marking this changed note.');
      if (payload.reset && (!Array.isArray(payload.marks) || payload.marks.length)) throw new Error('Reset requires an empty selection.');
      markedRanges(parsed.blocks, payload.marks);
      record = { bodyHash: parsed.bodyHash, revision: (record?.revision ?? 0) + 1, marks: payload.marks.map(({ id, section }) => ({ id, section })) };
      Object.defineProperty(manifest.files, relative, { value: record, enumerable: true, configurable: true, writable: true });
      const file = cleanupManifestPath(this.dataDir, root);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }); }
      stale = false;
    }
    const marks = record?.marks ?? [];
    return { ...parsed, revision: record?.revision ?? 0, marks, stale, preview: stale ? null : this.md.render(removeMarked(body, parsed.blocks, marks)) };
  }
}
