# nomod-cli

[![GitHub Release](https://img.shields.io/github/v/release/piyook/nomod-cli)](https://github.com/piyook/nomod-cli/releases)
[![checks workflow](https://github.com/piyook/nomod-cli/actions/workflows/checks.yaml/badge.svg)](https://github.com/piyook/nomod-cli/actions/workflows/checks.yaml)
[![npm version](https://img.shields.io/npm/v/nomod-cli)](https://www.npmjs.com/package/nomod-cli)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Free disk space by deleting the `node_modules` folders you don't need. Use it yourself in a terminal, or let your AI agent do it for you.

- **By hand:** a checklist of every `node_modules` on your machine, biggest first, with what's safe to delete already ticked.
- **For agents:** one command does the work an agent would otherwise piece together from hundreds of `find`, `du` and `git` calls, and hands back a short JSON summary. That saves tool calls and tokens. Ask your agent to "free up some disk space" and it can scan, show you the list, and delete just what you agree to.

No dependencies. Needs Node 22 or newer. Works on Windows, macOS and Linux.

![nomod listing node_modules folders with their size, last use, git status and project name, and the free space you'd have after deleting the checked ones](docs/screenshot.svg)

## Install

```sh
npm install -g nomod-cli
```

Or run it once without installing: `npx nomod-cli`.

## Use it yourself

```sh
nomod                 # scan your user folder and pick what to delete
nomod ~/projects      # scan one folder instead
nomod --all           # also build/cache folders (.next, dist, coverage…) and Python venvs
nomod --dry-run       # just show the list and sizes, delete nothing
```

nomod scans, then opens a checklist sorted by size (as in the picture above):

| Key | Action |
| --- | --- |
| `↑` `↓` | move |
| `space` | check / uncheck |
| `a` / `n` / `i` | check all / none / invert |
| `s` | sort by size, last used or path |
| `enter` | delete the checked folders (asks you to confirm first) |
| `q` / `esc` | quit without deleting |

The header shows how much free space you'll have after deleting what's checked. The columns:

- **used**: when you last worked on the project (its newest file or git commit).
- **git**: `clean` means nothing uncommitted. `4 dirty` means 4 files with uncommitted changes, a hint you left work in progress there. `no git` means the project isn't in a repo. It's for information only: deleting `node_modules` never touches your code. (A repo whose `.gitignore` doesn't list `node_modules` shows `1 dirty` from `node_modules` alone.)
- **notes**: why a folder might not reinstall cleanly (see below). `pnpm` means it shares a store, so it frees less than its size (`pnpm store prune` frees the rest).
- **project**: the repo's name on its remote (e.g. GitHub), with a sub-path for packages inside a repo (`recipe-box/web`). Repos with no remote use their folder name.

## Let your AI agent do it

Agents run commands without a terminal, so nomod never opens the checklist for them and never deletes without `--yes`. The workflow is three steps, with you agreeing in the middle:

```sh
# 1. Scan: a short JSON summary on stdout, nothing deleted
nomod --json --brief ~/projects

# 2. The agent shows you the folders, sizes and reasons, and you agree on a list

# 3. Delete exactly that list: no second scan, no prompt
nomod --json --yes --delete-from chosen.txt     # one path per line, or a JSON array
```

**It saves tokens.** nomod does the finding, sizing, git and lockfile checks itself and reports only the result. Measured on 40 projects:

| Approach | Tool calls | Output |
| --- | --- | --- |
| The agent works it out with `find`, `du`, `git`, `ls` | ~200 | ~3,400 tokens of raw output, still to be added up and reasoned over |
| `nomod --json --brief` | 1 | ~2,700 tokens, already summed, with the reason for each verdict |

JSON is printed on one line when piped, since indentation only costs tokens. Leave out `--brief` for the full detail (file counts, git status, project and repo paths).

What makes it safe to hand to an agent:

- **It deletes exactly what you saw.** `--delete-from` takes the paths from the scan, so a second scan can't change the list. Each path is checked again before it goes, and anything a scan wouldn't have listed (a source folder, a link, a folder inside another `node_modules`, a committed `dist`) is refused.
- **Reasons, not just sizes.** Each folder in the JSON comes with `keepReasons` ("used 3d ago", "no lockfile: a reinstall may differ") so the agent can tell you why something should stay.
- **Mistakes stop it.** A `--pick` pattern that matches nothing deletes nothing. Errors are JSON too (`{ "error": … }`), and the exit codes are documented.
- **A stable format.** Every JSON result carries a `schemaVersion`.

Setting up your agent:

- **Any agent:** point it at [llms.txt](llms.txt), the full guide to the workflow, fields and exit codes. The installed copy's path is on the last line of `nomod --help`.
- **Claude Code:** copy [skills/nomod](skills/nomod) to `~/.claude/skills/`. After that, "free up some disk space" or "clean up my old node_modules" is enough.

## What starts checked

Everything starts checked, and so is deleted by `--yes` without `--delete-from`, except:

- projects you used in the last 14 days (change this with `--recent <days>`)
- `node_modules` with no lockfile next to it, because a reinstall may not give you the same versions
- `node_modules` with no `package.json` next to it
- with `--all`: `dist`/`build`/`coverage` in a project with no git, and venvs with no requirements file

The checklist shows why the highlighted row is unchecked; the JSON has it in `keepReasons`.

## Options

| Option | What it does |
| --- | --- |
| `-n`, `--dry-run` | list and size only |
| `-a`, `--all` | also list build and cache folders (`.next`, `.nuxt`, `.turbo`, `.svelte-kit`, `.cache`, `dist`, `build`, `coverage`…) and Python virtualenvs |
| `-r`, `--recent <days>` | how recent counts as "still in use" (default 14) |
| `-m`, `--min <MB>` | hide folders smaller than this |
| `-x`, `--exclude <regex>` | skip matching paths (you can repeat it) |
| `-p`, `--pick <regex>` | check only the folders whose path matches, ignoring the defaults |
| `--delete-from <file\|->` | delete exactly the folders listed in a file (or `-` for stdin), without scanning |
| `-y`, `--yes` | skip the confirmation. With no terminal, deletes what is checked |
| `--json` | JSON output: the scan, or with `--yes` what was deleted |
| `--brief` | with `--json`, only the fields needed to choose: about half the size |
| `-h`, `--help` | show help |
| `-v`, `--version` | show the version |

Exit codes: `0` done, `1` error (or a folder that couldn't be deleted), `2` nothing found, `3` cancelled.

## Safe by design

- It only deletes folders with these names: `node_modules`, the `--all` build folders, and virtualenvs.
- It never follows symlinks or junctions, so pnpm's shared store is left alone.
- It skips `AppData`, dot-folders (`.vscode`, `.npm`…) and system folders, so editor extensions and global installs are never touched.
- `dist`, `build` and `coverage` are never listed if git tracks them.
- With no terminal and no `--yes`, it only prints a report.

To get a deleted folder back, run `npm install` (or `pnpm install`, `yarn`, `bun install`) in the project.

## Contributing

```sh
npm install              # dev tools only; nomod itself has no dependencies
npm test                 # node:test, runs the CLI against throwaway folders
npm run test:coverage    # the same, with coverage (fails below the minimum in .c8rc.json)
npm run lint             # Biome lint + format check (npm run lint:fix to fix)
npm run fallow           # fallow audit of your changes against origin/main
```

Git hooks check your work before it leaves your machine:

- **pre-commit**: Biome on the staged files
- **commit-msg**: [Conventional Commits](https://www.conventionalcommits.org) (`feat: …`, `fix: …`, `chore: …`)
- **pre-push**: the branch name (`main`, `dev`, or `feat|fix|hotfix|release|chore/<name>`), Biome, the tests with coverage, and fallow

CI runs the same checks on pull requests, plus the tests on Linux, macOS and Windows with every supported Node version, and a check of what the npm package would contain.

## License

MIT
