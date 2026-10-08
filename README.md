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

## Cleanup pass

Turn on **Cleanup mode** in the top bar to mark content for removal from exported copies:

- Click a heading to mark just the heading. **Shift-click** it to mark the entire section, through its nested subsections until the next heading of equal or higher level.
- Click a paragraph, task/list item, quote/callout, code block, table, or divider to mark that block. A list item includes its nested children; a nested child can also be selected on its own.
- Marked content stays visible with deletion styling. Click again to restore it. Clicking a block covered by a larger selection restores that containing selection; any independent marks still remain.
- Focus a block with Tab and press Enter or Space to mark it (Shift also selects a heading's section).
- **Undo mark**, **U**, or **Z** reverses the most recent cleanup action on the current note, with up to 32 steps. The top-bar **Undo** button still reverses the last status review. Cleanup undo history resets on navigation, rescan, or reload, but saved marks remain and can be toggled off.
- **Preview cleaned journal** shows how the body will read after export. **View source** shows the original file, not the cleaned preview.

Each successful click saves marks locally in `.journal-audit-data/cleanup/<folder-hash>.json` (or under `JOURNAL_AUDIT_DATA_DIR`). They are separate from the Markdown files and survive browser/server restarts. Retain that data directory alongside your app. Marks belong to the selected journal folder and each file's relative path; moving or renaming files does not migrate marks.

Cleanup checks the body independently of YAML, so setting statuses or review comments does not invalidate marks. An external body edit makes existing marks stale: rescan to see the warning, then use **Discard outdated marks** and review the changed note again. Export refuses stale marks before creating any output.

### One export for both passes

The existing export command now applies cleanup marks, sorts the copies into status folders, and removes `audit_status` from the copies. It preserves all other metadata and unmarked source text. No original journal is modified.

```sh
# Validate the planned export and show counts without creating files:
npm run export -- "/path/to/journals" "/path/to/new-output" --dry-run

# Create the cleaned, categorized copies:
npm run export -- "/path/to/journals" "/path/to/new-output"
```

Use the same input folder selected in the app. If the server uses a custom `JOURNAL_AUDIT_DATA_DIR`, set that same environment variable for the command so it finds your marks. Output reports the number of files cleaned as well as the category totals. Attachments are still not copied and links are not rewritten.

### Track cleanup progress

The queue shows **Cleanup: reviewed / total** for the current category/filter. Marking blocks saves your work in progress; click **Done & next** when finished with a note. With no marks, the same button reads **Nothing to delete & next**. Both save completion and advance to the next unfinished note in that view, wrapping to earlier unfinished notes as needed.

Use **Next unfinished cleanup** to resume the current category, and **Reopen cleanup** to undo a completion without removing marks. Changing marks reopens the note. Completion persists in the local cleanup manifest, including notes with nothing to delete. Earlier marks remain intact and start as unfinished until you explicitly finish reviewing. Body edits invalidate completion; YAML-only status/comment edits do not. Export includes unfinished notes too, applying whatever marks have been saved.
