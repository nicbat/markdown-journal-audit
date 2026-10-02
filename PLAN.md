# Journal audit: first release

A local browser app for reviewing hundreds of Markdown journals inside an Obsidian vault. The browser talks to a loopback-only file server. No accounts, uploads, or AI processing.

## Workflow

Choose a journal folder and optionally the surrounding vault for backlink indexing. Read one entry, add an optional comment, then press 1–9 to save a named audit status and advance. Default assignments: 1 keep, 2 skip, 3 delete. Delete only marks a file; skip is deferred and reported separately. Add custom statuses up to nine. Shortcuts do not run while typing.

Rendered Markdown includes headings, tasks, lists and wikilinks. Raw source is available. Show filename, word count, outgoing links and incoming backlinks. Previous/next navigation does not undo; Undo reverses the last mutation. Filter the queue and resume after restart. Persist decisions in `audit_status` and `audit_note` YAML fields, with application configuration separate from journal content.

## Boundaries and correctness

Preserve entry text and unrelated YAML. Malformed frontmatter must never be silently replaced. Detect external edits before writes or undo. Use atomic writes, restrict operations to the chosen roots, and avoid traversing symlinks outside those roots. Exclude application and dependency folders from indexing. Do not access a real vault during development.

## Build sequence

1. Generate a synthetic vault with ordinary journals and edge cases; implement and test scanning and safe metadata edits.
2. Implement the complete reading, decision, comment, navigation, undo, progress and resume loop.
3. Add custom statuses, backlink indexing, filters, responsive layout and browser verification.

## Verification

Automated checks for frontmatter/body preservation, absent and malformed YAML, external edit conflicts, undo, and path restrictions. Browser checks against synthetic data for keyboard decision/advance, comment typing, raw view, custom status, filters, undo, and reload persistence. Inspect both wide and narrow layouts.

## Deferred

Physical deletion, full Markdown editing, arbitrary YAML editing, app packaging, and Obsidian plugin integration.

## Delegation

GPT-6 Luna implements the app and its tests. The parent agent reviews persistence behavior and independently tests the browser workflow.
