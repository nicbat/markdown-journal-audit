import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const count = Math.max(1, Math.min(2000, Number(process.argv[2] || 300)));
const root = path.join(here, 'demo-vault');
const journal = path.join(root, 'Journal');
const projects = path.join(root, 'Projects');
await fs.mkdir(journal, { recursive: true });
await fs.mkdir(projects, { recursive: true });
try { await fs.writeFile(path.join(root, 'Projects', 'Field Notes.md'), '# Field Notes\n\nA synthetic note used to demonstrate backlinks from outside the journal folder. It points back to [[2025-01-01]].\n', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const moods = ['clear', 'restless', 'hopeful', 'tired', 'curious', 'steady'];
for (let i = 0; i < count; i++) {
  const date = new Date(Date.UTC(2025, 0, 1 + i));
  const stamp = date.toISOString().slice(0, 10);
  const file = path.join(journal, `${stamp}.md`);
  try { await fs.access(file); continue; } catch {}
  const content = `---\ndate: ${stamp}\ntags:\n  - journal\nmood: ${moods[i % moods.length]}\n---\n\n# ${new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' }).format(date)}\n\nToday I made some space to notice what was happening around me. The morning started slowly, then a small conversation changed the shape of the afternoon.\n\nI want to remember the light across the kitchen table and the relief of finishing one task without rushing into the next. I have been thinking about [[Projects/Field Notes]] and how a few careful observations can become something useful later.\n\n> Leave a little room for the unexpected.\n\n- Take a walk before lunch\n- Write down one question worth returning to\n- [ ] Make time for a longer read\n\nThe day did not need a big conclusion. It was enough to be here and pay attention.\n`;
  await fs.writeFile(file, content, { flag: 'wx' });
}
const examples = path.join(journal, 'examples');
for (const folder of ['one', 'two']) await fs.mkdir(path.join(examples, folder), { recursive: true });
const fixtures = [
  ['short.md', '---\ndate: 2024-01-01\n---\n\nA short synthetic entry.'],
  ['no-frontmatter.md', '# No frontmatter\n\nThis synthetic file shows that the app can add audit metadata while keeping body text in place.'],
  ['invalid-yaml.md', '---\ndate: [unfinished\n---\n\nThis file intentionally has malformed YAML so the app can show its recovery message.'],
  ['one/Shared.md', '---\ntitle: First Shared\n---\n\nThis duplicate filename is used to demonstrate that an ambiguous link is not guessed. Try [[Shared]].'],
  ['two/Shared.md', '---\ntitle: Second Shared\n---\n\nAnother synthetic file with the same name in a different folder.'],
  ['long.md', `---\ndate: 2024-02-01\nmood: reflective\n---\n\n# A longer synthetic entry\n\n${Array.from({ length: 14 }, (_, n) => `## Passage ${n + 1}\n\nI took a longer walk through the neighborhood and let a few small details stay in my attention: the shifting weather, a familiar doorway, and the sound of someone practicing piano nearby. Writing these things down gives the day a place to settle. I am trying to notice where energy gathers and where it thins out, then make one thoughtful choice before the evening begins. This is sample text for scrolling and reading layout checks.`).join('\n\n')}`]
];
for (const [relative, content] of fixtures) { const file = path.join(examples, relative); await fs.mkdir(path.dirname(file), { recursive: true }); try { await fs.writeFile(file, content + '\n', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
console.log(`Generated ${count} synthetic journals at ${journal}`);
console.log(`Optional vault root: ${root}`);
