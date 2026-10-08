# Journal Audit

A small local web app for reviewing Markdown journal folders. It shows one rendered journal at a time, links and backlinks, word counts, and a fixed row of keyboard actions. Review statuses and optional notes are stored in YAML frontmatter. Choosing **Delete** records that status only; it never removes the file.

## Run a synthetic demo

The generator creates Markdown files under `demo-vault/` in this project. It never scans or modifies another folder. Existing synthetic files are left as they are.

```sh
npm install
npm run demo -- 300
npm start
```

Open the local URL printed by `npm start` (normally [http://127.0.0.1:4178](http://127.0.0.1:4178)). In **Settings**, use the full path printed by the demo generator for **Journal folder path** (`.../demo-vault/Journal`) and optionally set **Vault root** to `.../demo-vault` to include its backlink index.

For a smaller demo, pass a number such as `npm run demo -- 12`. The default is 300 journals and the maximum is 2,000.

## Use your own journals

Start the app on the computer where the vault is stored, then enter the full path to the journal folder. To include backlinks from elsewhere in the vault, add the vault root too. The vault root must contain the selected journal folder. Paths and status settings are saved locally in `.journal-audit-data/config.json`; no journal content is uploaded or sent to a remote service.

The server listens on `127.0.0.1` only, accepts local host names, and rejects cross-origin mutations. It ignores `.obsidian`, `.git`, `node_modules`, and `.trash` while indexing. Folder traversal and symlinks are excluded from scans, and each save rechecks containment and the selected file’s content hash.

## Review controls

- Press **1–9** to save one of the configured statuses and advance to the next journal in the current queue view.
- Press **← / →** or use the side navigation to move without saving.
- Add an optional review note before saving. The note is written as `audit_note` beside `audit_status`.
- Press **N** to focus the review note, then **Enter** to leave the field. Typing a note does not save it until you choose a status.
- Use **Undo**, **U**, or **Z** to restore the previous file contents for the last review action in this browser session. Undo checks the file hash first and stops if another edit happened after the action.
- Filter the queue by all, to review, completed, or skipped. The current journal and filter resume in the same browser.
- **Files by status** shows totals for the entire journal folder, including custom statuses and unreviewed files. Counts update after Save and Undo and remain visible while filtering the queue.
- Outgoing links are grouped by target; repeated links show a count such as **×4**, including references with different display aliases. **Links out** shows unique targets and the total number of references.
- Use **View source** to see the full Markdown file, including YAML. Editing stays in your regular text editor; this app has no general YAML editor.

If a file has invalid YAML frontmatter, the app displays the error and disables review actions for that file. Fix the frontmatter in your editor, then rescan. When a file changes outside the app, the stale save is rejected and asks you to rescan. Body text, including CRLF endings and the final newline state, is kept byte-for-byte during metadata edits; unrelated frontmatter fields and comments are retained through YAML document editing.

## Commands

```sh
npm start       # local server at http://127.0.0.1:4178
npm test        # file preservation, undo, conflict, and path-safety checks
npm run demo    # generate 300 synthetic journal entries
npm run benchmark # time an isolated 600-journal / 3,600-note synthetic vault
```

If port 4178 is occupied, `npm start` tries the next available local port and prints its URL. Set `PORT` to require a specific port. A second server normally reads the same configuration; set `JOURNAL_AUDIT_DATA_DIR` to a different directory if you want an independent setup.

Custom status names, colors, number assignments, and folder paths are saved in `.journal-audit-data/config.json` when you click **Save folders**. They return when you close and reopen the site. Audit decisions and saved review notes live in each Markdown file's YAML frontmatter. The current journal and queue filter live in this browser's local storage, so they are specific to the browser address and port. Unsaved note text and the last Undo action only last for the current page session.

## Performance and refresh

The initial request loads a compact journal index. Journal bodies load when selected, with nearby entries prefetched and up to 32 recent entries kept in the browser. Navigation reuses queue rows, and Save/Undo update only the affected journal. Undo history is held in the running server, so restarting the server clears it.

The server caches parsed files and rendered Markdown, and resolves backlinks through path/name lookup maps. Opening the app or pressing **Rescan** checks file timestamps and rebuilds links, reading and parsing changed files only. Save and Undo still check the actual file contents before writing, even when the displayed entry came from a cache.

`npm run benchmark` creates a disposable synthetic vault, launches an isolated server, measures cold indexing, rescanning, detail loading, Save and Undo, then removes its temporary files. Use `npm run benchmark -- 1000` to test 1,000 journals plus 5,000 linked notes. It never accesses your configured vault.

## Review a category or remove a status

Click a **Files by status** card to show only that category. Previous/Next and arrow keys stay within it; the position counter shows where you are within that group. The selected category resumes after a browser reload. Use **All** to return to the whole folder.

To start over on a category, remove its status in **Settings**, then save. This clears `audit_status` from all matching Markdown files under the current journal folder (including subfolders). Other YAML fields, saved `audit_note` comments, and journal body text remain. Canceling settings does not change files. Renaming a status label keeps its existing key and decisions.

Before resetting, originals are copied to `.journal-audit-data/reset-backups/<batch-id>/files/` with a manifest beside them (or the corresponding directory under `JOURNAL_AUDIT_DATA_DIR`). Bulk resets clear the single-action Undo history; use the backup files for recovery. Invalid YAML blocks the reset before writing. If an external edit or disk error interrupts a batch, the error reports how many files changed and where the originals were backed up. Save folder changes separately from status removals.

## Export copies grouped by YAML value

```sh
npm run export -- "/path/to/journals" "/path/to/journals-sorted"
# Optionally use another top-level YAML field:
npm run export -- "/path/to/journals" "/path/to/journals-sorted" category
```

The default field is `audit_status`. A note marked `keep` becomes `journals-sorted/keep/<original-relative-path>.md`, with `audit_status` removed from the copy. Files without a value go into `unreviewed/`. Review comments and other YAML fields remain; originals are never modified.

Choose a new output folder outside the input folder, with an existing parent directory. Nested paths are preserved so duplicate filenames are safe. Unsafe or conflicting category names receive distinct folder names, listed in the command's output. The script accepts scalar field values and validates every journal before creating output. It copies Markdown files only; attachments are not copied and links are not rewritten, so moved notes may require link adjustments.
