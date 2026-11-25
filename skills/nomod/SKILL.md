---
name: nomod
description: Free disk space by finding and deleting unused node_modules folders (and, on request, build/cache folders and Python venvs) with the nomod CLI. Use when the user wants to free disk space, clean up old projects, or delete node_modules.
---

# Cleaning up node_modules with nomod

`nomod` scans a folder for `node_modules` (and with `--all`, `.next`, `dist`, `coverage`, venvs and the like), sizes them, and deletes the ones chosen. If it is not installed, use `npx nomod-cli` in place of `nomod`. The full reference is `llms.txt`, its path is the last line of `nomod --help`.

Never delete anything without the user's agreement to the exact list.

## Steps

1. **Scan.** `nomod --json <folder>` prints JSON on stdout and deletes nothing. Scan the folder the user means (their projects folder, say), not the whole home folder, unless they ask: a home-folder scan can take several minutes, so give the command a long timeout (10 minutes) or run it in the background. Add `--all` only if the user wants build/cache folders and venvs too.
2. **Show the user** a table of the folders: `name`, `kind`, size (`size` is bytes), `lastUsed`, and `keepReasons` for the ones that start unchecked. Say how much the checked ones free (`checkedBytes`) and what free space would become (`freeBytes` + that).
3. **Agree on the list.** The default is the folders with `checked: true`. If the user picks others that have `keepReasons` (used recently, no lockfile, no package.json, not in git), say what the reason means before including them.
4. **Delete exactly that list,** with no second scan: write the chosen paths to a file, one per line (or pass the chosen `folders` entries as a JSON array), then
   `nomod --json --yes --delete-from <file>` (or `--delete-from -` to read stdin).
   Each path is checked again before deleting: nomod refuses anything that is not a folder it would have listed.
5. **Report** `freedBytes` and `freeBytesAfter`, and every entry in `failed` with its `error`. `EBUSY`/`EPERM` usually means an editor, dev server or watcher has files open: ask the user to close it, then retry with `--delete-from` listing just those.

## Things to know

- Exit codes: `0` done, `1` error or at least one folder failed or was refused, `2` nothing found (or a `--pick` matched nothing), `3` cancelled.
- With `--json`, an error is `{ "schemaVersion": 1, "error": "..." }` on stdout.
- `pnpm` in `tags`: the folder shares pnpm's store, so it frees less than `size`. `pnpm store prune` frees the rest; suggest it, don't run it unasked.
- Restoring a deleted folder: `npm install` (or `pnpm install`, `yarn`, `bun install`) in the project; for a venv, recreate it and install from requirements/pyproject.
- `--pick '<regex>'` also selects folders, but matching paths by regex is easy to get wrong, especially with Windows backslashes. Prefer `--delete-from`.
