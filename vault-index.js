import fs from 'node:fs/promises';
import path from 'node:path';
import { parseMetadata, hashText, splitJournal, extractWikilinks, resolveSafeFile, scanMarkdown, isInside } from './journal.js';

const normalize = value => value.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
const signature = stat => `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

// Parsing is cached by file identity/size/timestamps. An explicit rescan still
// checks every file, so additions, removals and external edits remain visible.
export class VaultIndex {
  constructor(journalFolder, vaultFolder, render) {
    this.journalFolder = journalFolder;
    this.vaultFolder = vaultFolder || journalFolder;
    this.render = render;
    this.files = new Map();
    this.paths = new Map();
    this.names = new Map();
    this.incoming = new Map();
    this.journals = [];
    this.ready = false;
    this.pendingScan = null;
    this.stats = { reads: 0, renders: 0 };
  }

  async load(relative) {
    const fullPath = await resolveSafeFile(this.vaultFolder, relative);
    const stat = await fs.stat(fullPath, { bigint: true });
    const stamp = signature(stat);
    const old = this.files.get(fullPath);
    if (old?.stamp === stamp) return old;
    const source = await fs.readFile(fullPath, 'utf8');
    this.stats.reads++;
    const journal = isInside(this.journalFolder, fullPath);
    let metadata = {}, body, error = null;
    try {
      if (journal) { const parsed = parseMetadata(source); metadata = parsed.metadata; body = parsed.parts.body; }
      else body = splitJournal(source).body || source;
    }
    catch (e) { error = e.message; body = splitJournal(source).body || source; }
    const sameBody = old?.body === body;
    const file = {
      relative, fullPath, stamp, source, body, metadata, error,
      hash: error || !journal ? null : hashText(source),
      links: error ? [] : sameBody ? old.links : extractWikilinks(body),
      wordCount: !journal ? 0 : sameBody ? old.wordCount : (body.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length,
      rendered: sameBody ? old.rendered : undefined
    };
    this.files.set(fullPath, file);
    return file;
  }

  resolve(target, source) {
    const raw = normalize(target.replace(/^\//, ''));
    const relative = normalize(path.posix.normalize(path.posix.join(path.posix.dirname(source.replace(/\\/g, '/')), raw)));
    return this.paths.get(raw) || this.paths.get(relative) || this.names.get(raw) || null;
  }

  async rescan() {
    if (this.pendingScan) return this.pendingScan;
    this.pendingScan = this.scan();
    try { return await this.pendingScan; } finally { this.pendingScan = null; }
  }

  async scan() {
    if (!isInside(this.vaultFolder, this.journalFolder)) throw new Error('The vault folder must contain the journal folder.');
    const relatives = await scanMarkdown(this.vaultFolder);
    const files = await mapLimited(relatives, 24, relative => this.load(relative));
    const live = new Set(files.map(file => file.fullPath));
    for (const key of this.files.keys()) if (!live.has(key)) this.files.delete(key);
    this.paths.clear(); this.names.clear(); this.incoming.clear();
    for (const file of files) {
      this.paths.set(normalize(file.relative), file);
      const name = normalize(path.basename(file.relative));
      this.names.set(name, this.names.has(name) ? null : file);
    }
    for (const file of files) {
      for (const link of file.links) {
        const target = this.resolve(link.target, file.relative);
        if (!target || target.fullPath === file.fullPath) continue;
        if (!this.incoming.has(target.fullPath)) this.incoming.set(target.fullPath, new Set());
        this.incoming.get(target.fullPath).add(file.fullPath);
      }
    }
    this.journals = files.filter(file => isInside(this.journalFolder, file.fullPath)).map(file => file.fullPath);
    this.ready = true;
    return this.summaries();
  }

  summary(file) {
    const relative = path.relative(this.journalFolder, file.fullPath);
    return { relative, name: path.basename(relative, '.md'), hash: file.hash,
      metadata: file.metadata, wordCount: file.wordCount, linkCount: file.links.length,
      incoming: this.incoming.get(file.fullPath)?.size || 0, error: file.error };
  }

  summaries() { return this.journals.map(key => this.summary(this.files.get(key))); }

  async detail(relative) {
    if (!this.ready) await this.rescan();
    const fullPath = await resolveSafeFile(this.journalFolder, relative);
    const file = await this.load(path.relative(this.vaultFolder, fullPath));
    if (file.rendered === undefined) { file.rendered = this.render(file.body); this.stats.renders++; }
    return { ...this.summary(file), body: file.body, source: file.source, rendered: file.rendered,
      links: file.links.map(link => ({ ...link, resolves: !!this.resolve(link.target, file.relative) })) };
  }
}
