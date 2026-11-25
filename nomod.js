#!/usr/bin/env node
// nomod: find node_modules (and optionally other build/cache folders) under a
// folder, show how much space each takes, pick which to delete, delete them.
// No dependencies on purpose: the tool must never need its own node_modules.

process.env.UV_THREADPOOL_SIZE ??= '32'; // must run before any async fs call

import { execFile } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { access, lstat, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
const LLMS_TXT = fileURLToPath(new URL('./llms.txt', import.meta.url));

// ---------------------------------------------------------------- constants

// Folders never descended into while looking for projects (case-insensitive).
const SKIP_DIRS = new Set([
  'appdata',
  'application data',
  'local settings',
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'library',
  'scoop',
  'bower_components',
  'jspm_packages',
  '__pycache__',
  'site-packages',
]);
// Build/cache output inside a Node project (has package.json). Only with --all.
const NODE_JUNK = new Set([
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.angular',
  '.docusaurus',
  '.cache',
  'dist',
  'build',
  'coverage',
]);
// Junk folders that could hold committed files: dropped if git tracks them.
const MAYBE_TRACKED = new Set(['dist', 'build', 'coverage']);
const VENV_NAMES = new Set(['.venv', 'venv', 'env', '.env']);
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];
const PY_MARKERS = ['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'uv.lock', 'poetry.lock'];
const DAY = 86_400_000;

// ---------------------------------------------------------------- cli args

const HELP = `nomod ${VERSION}: find node_modules folders, see their size, delete the ones you don't need.

Usage: nomod [options] [folder ...]

  folder              where to look (default: your user folder, ${os.homedir()})

Options:
  -a, --all           also list build/cache folders: .next .nuxt .turbo .svelte-kit
                      .parcel-cache .angular .cache dist build coverage, and Python venvs
  -n, --dry-run       list and size only, delete nothing
  -r, --recent <days> projects used within this many days start unchecked (default 14)
  -m, --min <MB>      hide folders smaller than this (default 0)
  -x, --exclude <re>  skip paths matching this regular expression (repeatable)
  -p, --pick <re>     check exactly the folders whose full path matches (repeatable),
                      ignoring the defaults below. Others start unchecked. With
                      --yes, nothing is deleted if any --pick matches no folder
      --delete-from <file|->
                      delete exactly these folders, no scan: one path per line, or
                      a JSON array of paths (or of objects with a "path"), - for
                      stdin. Each is checked again first, as a scan would
  -y, --yes           don't ask "are you sure" after the picker. Without a terminal
                      (piped / scripted, e.g. an agent), deletes what is checked
      --json          print JSON instead of text. Alone: the scan, nothing deleted.
                      With --yes: deletes, then prints what was deleted. One line
                      when piped, indented in a terminal
      --brief         with --json, only the fields needed to choose: path, kind,
                      name, size, lastUsed, tags, keepReasons, checked
  -h, --help          show this help
  -v, --version       show the version

A folder starts unchecked (kept) when its project was used recently, when a
node_modules has no lockfile or no package.json next to it (a reinstall might not
give you the same thing back), when dist/build/coverage is in a project with no git,
or when a venv has no requirements/pyproject file. dist/build/coverage folders that
git tracks are never listed.

Picker keys: up/down (or j/k) move, space toggle, a all, n none, i invert,
s change sort, PgUp/PgDn/Home/End jump, enter delete selected, q / esc quit.

Exit codes: 0 done, 1 error, 2 nothing found, 3 cancelled.

Agents and scripts: the full guide (JSON fields, workflow) is ${LLMS_TXT}`;

// How each option's value is read: a number >= 0, or a case-insensitive regex.
function toNumber(flag, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`${flag}: not a number: ${v}`);
  return n;
}
function toRegExp(flag, v) {
  try {
    return new RegExp(v, 'i');
  } catch (e) {
    fail(`${flag}: ${e.message}`);
  }
}

// Each option: its long name, short name, and what it does to the options
// `o`. `takes` reads its value, for options that have one.
const OPTIONS = [
  { long: '--all', short: '-a', set: (o) => (o.all = true) },
  { long: '--dry-run', short: '-n', set: (o) => (o.dryRun = true) },
  { long: '--recent', short: '-r', takes: toNumber, set: (o, v) => (o.recent = v) },
  { long: '--min', short: '-m', takes: toNumber, set: (o, v) => (o.min = v) },
  { long: '--exclude', short: '-x', takes: toRegExp, set: (o, v) => o.exclude.push(v) },
  { long: '--pick', short: '-p', takes: toRegExp, set: (o, v) => o.pick.push(v) },
  { long: '--yes', short: '-y', set: (o) => (o.yes = true) },
  { long: '--json', set: (o) => (o.json = true) },
  { long: '--brief', set: (o) => (o.brief = true) },
  { long: '--delete-from', takes: (_, v) => v, set: (o, v) => (o.deleteFrom = v) },
  { long: '--help', short: '-h', set: () => printAndExit(HELP) },
  { long: '--version', short: '-v', set: () => printAndExit(VERSION) },
];

function parseArgs(argv) {
  const o = { roots: [], all: false, dryRun: false, recent: 14, min: 0, exclude: [], pick: [], yes: false, json: false, brief: false, deleteFrom: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const opt = OPTIONS.find((x) => x.long === a || x.short === a);
    if (!opt) {
      if (a.startsWith('-')) fail(`unknown option ${a} (see nomod --help)`);
      o.roots.push(path.resolve(a));
      continue;
    }
    if (!opt.takes) {
      opt.set(o);
      continue;
    }
    if (i + 1 >= argv.length) fail(`${a} needs a value`);
    opt.set(o, opt.takes(opt.long, argv[++i]));
  }
  if (o.deleteFrom != null && (o.roots.length || o.pick.length)) fail('--delete-from takes no folder and no --pick: the list says what to delete');
  if (!o.roots.length) o.roots.push(os.homedir());
  return o;
}

// Bumped when a JSON field is renamed or removed (new fields don't bump it).
const SCHEMA_VERSION = 1;
// Known before the arguments are parsed, so that errors in them come out as JSON too.
const JSON_MODE = process.argv.slice(2).includes('--json');

// Indented for a person at a terminal; on one line when piped (an agent, a
// script), where indentation only costs tokens.
function printJson(obj) {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...obj }, null, process.stdout.isTTY ? 2 : 0));
}

// With --json, errors are also a JSON object on stdout: { schemaVersion, error }.
function printAndExit(text) {
  console.log(text);
  process.exit(0);
}

function fail(msg) {
  process.stderr.write(`nomod: ${msg}\n`);
  if (JSON_MODE) printJson({ error: String(msg).split('\n')[0] });
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
  inverse: paint('7'),
};

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    b /= 1024;
    i++;
  } while (b >= 1024 && i < u.length - 1);
  return `${b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
}

function fmtAge(ms) {
  if (ms == null) return '?';
  const d = Math.floor((Date.now() - ms) / DAY);
  if (d < 1) return 'today';
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  if (d < 730) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

function freeBytes(p) {
  try {
    const s = statfsSync(p);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function git(cwd, args, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer }, (err, stdout) => resolve(err ? null : stdout));
  });
}

let statusShown = false;
function status(msg) {
  if (!process.stderr.isTTY) return;
  const w = (process.stderr.columns || 80) - 1;
  process.stderr.write(`\r\x1b[K${msg.length > w ? `${msg.slice(0, w - 1)}…` : msg}`);
  statusShown = true;
}
function clearStatus() {
  if (statusShown) process.stderr.write('\r\x1b[K');
  statusShown = false;
}

// Run visit(dir) over a tree with up to `limit` visits in flight. visit returns
// the child folders to go into next.
function parallelWalk(starts, visit, limit = 64) {
  return new Promise((resolve) => {
    const stack = [...starts];
    let active = 0;
    const pump = () => {
      while (active < limit && stack.length) {
        const dir = stack.pop();
        active++;
        visit(dir)
          .then(
            (kids) => {
              if (kids) stack.push(...kids);
            },
            () => {},
          )
          .finally(() => {
            active--;
            if (!stack.length && !active) resolve();
            else pump();
          });
      }
    };
    if (!stack.length) resolve();
    else pump();
  });
}

// ---------------------------------------------------------------- scanning

async function discover(opts) {
  const found = [];
  let dirs = 0;
  const excluded = (p) => opts.exclude.some((re) => re.test(p));

  await parallelWalk(opts.roots, async (dir) => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    if (++dirs % 500 === 0) status(`Scanning… ${dirs.toLocaleString()} folders, ${found.length} found  ${dir}`);

    const names = new Set(ents.map((e) => e.name));
    const isNode = names.has('package.json');
    const next = [];
    for (const e of ents) {
      // Dirent.isDirectory() is false for symlinks and junctions, so links are never followed.
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const lname = e.name.toLowerCase();
      if (excluded(full)) continue;
      if (lname === 'node_modules') {
        found.push({ path: full, kind: 'node_modules', project: dir, hasPkg: isNode });
        continue;
      }
      if (VENV_NAMES.has(lname) && (await exists(path.join(full, 'pyvenv.cfg')))) {
        if (opts.all) found.push({ path: full, kind: 'venv', project: dir, hasReqs: PY_MARKERS.some((m) => names.has(m)) });
        continue;
      }
      if (opts.all && isNode && NODE_JUNK.has(lname)) {
        found.push({ path: full, kind: e.name, project: dir });
        continue;
      }
      if (e.name.startsWith('.') || SKIP_DIRS.has(lname)) continue;
      next.push(full);
    }
    return next;
  });
  clearStatus();
  return { found, dirs };
}

async function dirSize(root, onProgress) {
  let bytes = 0;
  let files = 0;
  await parallelWalk(
    [root],
    async (dir) => {
      let ents;
      try {
        ents = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const kids = [];
      const sizes = [];
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) kids.push(full);
        else if (e.isFile())
          sizes.push(
            lstat(full).then(
              (s) => s.size,
              () => 0,
            ),
          );
      }
      for (const s of await Promise.all(sizes)) {
        bytes += s;
        files++;
      }
      onProgress?.(files);
      return kids;
    },
    96,
  );
  return { bytes, files };
}

// Latest mtime among a project's own files (a few levels deep, skipping
// dependencies and build output), plus the latest git commit touching it.
async function lastUsed(project, gitRoot) {
  let latest = 0;
  let budget = 4000;
  const walk = async (dir, depth) => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = [];
    const stats = [];
    for (const e of ents) {
      if (budget-- <= 0) break;
      const lname = e.name.toLowerCase();
      if (e.name.startsWith('.') || lname === 'node_modules' || NODE_JUNK.has(lname) || VENV_NAMES.has(lname)) continue;
      const full = path.join(dir, e.name);
      if (e.isFile())
        stats.push(
          lstat(full).then(
            (s) => s.mtimeMs,
            () => 0,
          ),
        );
      else if (e.isDirectory() && depth < 3) subdirs.push(full);
    }
    for (const m of await Promise.all(stats)) if (m > latest) latest = m;
    for (const d of subdirs) await walk(d, depth + 1);
  };
  await walk(project, 0);
  if (gitRoot) {
    const out = await git(project, ['log', '-1', '--format=%ct', '--', '.']);
    const t = Number(out?.trim()) * 1000;
    if (t > latest) latest = t;
  }
  return latest || null;
}

async function findGitRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (await exists(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

async function hasLockfile(project, stopAt) {
  for (let d = project; ; d = path.dirname(d)) {
    for (const f of LOCKFILES) if (await exists(path.join(d, f))) return true;
    if (d === stopAt || path.dirname(d) === d || !stopAt) return false;
  }
}

async function enrich(found, opts) {
  const gitRoots = new Map(); // project -> git root or null
  const dirty = new Map(); // git root -> promise of number | null
  const used = new Map(); // project -> promise of ms | null
  const remotes = new Map(); // git root -> promise of remote repo name | null
  const rows = [];
  let done = 0;
  let filesSeen = 0;

  // Sizing is the slow part: a few folders at a time, each walked in parallel.
  const queue = [...found];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const base = filesSeen;
      const { bytes, files } = await dirSize(f.path, (n) => {
        filesSeen = base + n;
        status(`Sizing ${done + 1}/${found.length}… ${filesSeen.toLocaleString()} files  ${f.path}`);
      });
      filesSeen = base + files;
      done++;
      if (bytes / 1048576 < opts.min) continue;

      if (!gitRoots.has(f.project)) gitRoots.set(f.project, findGitRoot(f.project));
      const gitRoot = await gitRoots.get(f.project);
      if (gitRoot && !dirty.has(gitRoot)) {
        dirty.set(
          gitRoot,
          git(gitRoot, ['status', '--porcelain']).then((o) => (o == null ? null : o.split('\n').filter(Boolean).length)),
        );
      }
      if (gitRoot && !remotes.has(gitRoot)) remotes.set(gitRoot, remoteRepoName(gitRoot));
      if (!used.has(f.project)) used.set(f.project, lastUsed(f.project, gitRoot));

      const row = {
        ...f,
        size: bytes,
        files,
        gitRoot,
        repoName: gitRoot ? await remotes.get(gitRoot) : null,
        lastUsed: await used.get(f.project),
        dirty: gitRoot ? await dirty.get(gitRoot) : null,
        tags: [],
        why: [],
      };

      if (f.kind === 'node_modules') {
        if (f.hasPkg) row.lock = await hasLockfile(f.project, gitRoot ?? opts.roots.find((r) => f.project.startsWith(r)));
        if (await exists(path.join(f.path, '.pnpm'))) row.tags.push('pnpm');
      }
      if (MAYBE_TRACKED.has(f.kind.toLowerCase()) && gitRoot) {
        const tracked = await git(f.project, ['ls-files', '--', f.kind], 64 * 1024 * 1024);
        if (tracked == null || tracked.trim()) continue; // committed output: not junk, never list it
      }
      rows.push(row);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  clearStatus();

  const recentMs = opts.recent * DAY;
  for (const r of rows) {
    r.name = projectName(r);
    if (r.lastUsed && Date.now() - r.lastUsed < recentMs) r.why.push(fmtAge(r.lastUsed) === 'today' ? 'used today' : `used ${fmtAge(r.lastUsed)} ago`);
    if (r.kind === 'node_modules' && !r.hasPkg) {
      r.tags.push('no-pkg');
      r.why.push('no package.json next to it');
    } else if (r.kind === 'node_modules' && !r.lock) {
      r.tags.push('no-lock');
      r.why.push('no lockfile: a reinstall may differ');
    }
    if (r.kind === 'venv' && !r.hasReqs) {
      r.tags.push('no-reqs');
      r.why.push('no requirements/pyproject file');
    }
    if (MAYBE_TRACKED.has(r.kind.toLowerCase()) && !r.gitRoot) {
      r.tags.push('no-git');
      r.why.push('not in git: may not be rebuildable');
    }
    if (!r.gitRoot) r.git = 'no git';
    else if (r.dirty == null) r.git = '?';
    else r.git = r.dirty ? `${r.dirty} dirty` : 'clean';
    r.checked = opts.pick.length ? opts.pick.some((re) => re.test(r.path)) : r.why.length === 0;
  }
  return rows;
}

// ---------------------------------------------------------------- display

const SORTS = {
  size: (a, b) => b.size - a.size,
  age: (a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0),
  path: (a, b) => a.path.localeCompare(b.path),
};

// Paths compared the way the file system does: case-insensitive on Windows only.
const normPath = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const withSep = (p) => (p.endsWith(path.sep) ? p : p + path.sep); // "C:\" already ends in one
const isInside = (child, parent) => normPath(child).startsWith(withSep(normPath(parent)));

function relPath(p, roots) {
  const r = roots.find((r) => isInside(p, r));
  return r ? p.slice(withSep(r).length) : p;
}

// The repo's name from its remote URL (origin, else the first remote):
// "https://github.com/me/recipe-box.git" and "git@github.com:me/recipe-box" both
// give "recipe-box". null when the repo has no remote.
async function remoteRepoName(gitRoot) {
  const out = await git(gitRoot, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  if (!out) return null;
  // Each line is "<key> <url>"; split on the first space only, URLs can hold spaces.
  const urls = out
    .trim()
    .split('\n')
    .map((l) => {
      const t = l.trim();
      const i = t.search(/\s/);
      return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1).trim()];
    });
  const [, url] = urls.find(([key]) => key === 'remote.origin.url') ?? urls[0] ?? [];
  const name = url
    ?.replace(/[\\/]+$/, '')
    .split(/[\\/:]/)
    .pop()
    ?.replace(/\.git$/i, '');
  return name || null;
}

// The project's name as you'd recognise it: the repo's name on its remote
// (falling back to the repo folder's name), plus the sub-folder for packages
// inside a repo ("recipe-box/web"). Without git, or when the repo sits at the
// home folder or a drive root (a dotfiles repo, a stray `git init`, which
// holds unrelated projects), the project folder's own name.
function projectName(r) {
  if (!r.gitRoot) return path.basename(r.project);
  const g = normPath(r.gitRoot);
  if (g === normPath(os.homedir()) || path.dirname(g) === g) return path.basename(r.project);
  const repo = r.repoName ?? path.basename(r.gitRoot);
  if (g === normPath(r.project)) return repo;
  return [repo, ...path.relative(r.gitRoot, r.project).split(path.sep)].join('/');
}

// Cut s to w characters, keeping both ends: "my-company-frontend/packages/ui-icons"
// -> "my-company-f…ckages/ui-icons", so sibling packages stay distinguishable.
function truncMiddle(s, w) {
  if (s.length <= w) return s;
  if (w <= 1) return w === 1 ? '…' : '';
  const head = Math.floor((w - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (w - 1 - head))}`;
}

const NAME_MAX = 28;
const MIN_PATH = 10;
const BASE_W = 4 + 8 + 1 + 12 + 1 + 5 + 1 + 9 + 1 + 12 + 1; // checkbox .. notes, with spaces
let nameWidth = 7; // set from the rows by setNameWidth, at least as wide as "project"
function setNameWidth(rows) {
  nameWidth = Math.min(
    NAME_MAX,
    rows.reduce((m, r) => Math.max(m, r.name.length), 7),
  );
}

// Column widths for a row of `width` characters: the project column shrinks
// (and goes away below 7) before the path drops under MIN_PATH, so a row
// never runs past the edge of the terminal.
function layout(width) {
  let name = Math.min(nameWidth, width - BASE_W - MIN_PATH - 1);
  if (name < 7) name = 0; // narrower than the "project" heading: drop the column
  const pathW = Math.max(0, width - BASE_W - (name ? name + 1 : 0));
  return { name, path: pathW };
}

function rowCells(r, roots) {
  return {
    size: fmtSize(r.size).padStart(8),
    kind: r.kind.padEnd(12),
    age: fmtAge(r.lastUsed).padEnd(5),
    git: r.git.padEnd(9),
    tags: r.tags.join(',').padEnd(12),
    path: relPath(r.path, roots),
  };
}

function colorRow(cells, r, width) {
  const lay = layout(width);
  let p = cells.path;
  if (p.length > lay.path) p = lay.path ? `…${p.slice(p.length - lay.path + 1)}` : '';
  const sizeCol = r.size >= 1024 ** 3 ? c.red(cells.size) : r.size >= 300 * 1024 ** 2 ? c.yellow(cells.size) : cells.size;
  const recent = r.why.some((w) => w.startsWith('used'));
  return [
    r.checked ? c.green('[x]') : c.dim('[ ]'),
    sizeCol,
    c.dim(cells.kind),
    recent ? c.green(cells.age) : c.dim(cells.age),
    r.git.includes('dirty') ? c.yellow(cells.git) : c.dim(cells.git),
    c.yellow(cells.tags),
    ...(lay.name ? [c.bold(truncMiddle(r.name, lay.name).padEnd(lay.name))] : []),
    c.dim(p),
  ].join(' ');
}

const header = (width) => {
  const lay = layout(width);
  return (
    '    ' +
    'size'.padStart(8) +
    ' ' +
    'kind'.padEnd(12) +
    ' ' +
    'used'.padEnd(5) +
    ' ' +
    'git'.padEnd(9) +
    ' ' +
    'notes'.padEnd(12) +
    ' ' +
    (lay.name ? `${'project'.padEnd(lay.name)} ` : '') +
    'path'
  );
};

// "free now → free after deleting the selection", e.g. "2.1 GB → 4.0 GB"
function freeLine(free, selTotal) {
  if (free == null) return `frees ${c.bold(fmtSize(selTotal))}`;
  return `free: ${fmtSize(free)} → ${c.bold(c.green(fmtSize(free + selTotal)))} (+${fmtSize(selTotal)})`;
}

function printReport(rows, opts) {
  const w = process.stdout.columns || Number(process.env.COLUMNS) || 160;
  console.log(c.dim(header(w)));
  for (const r of rows) console.log(colorRow(rowCells(r, opts.roots), r, w));
  const total = rows.reduce((s, r) => s + r.size, 0);
  const sel = rows.filter((r) => r.checked);
  const selTotal = sel.reduce((s, r) => s + r.size, 0);
  console.log(`\n${rows.length} folders, ${c.bold(fmtSize(total))} in all. ` + `${sel.length} checked by default (${c.bold(fmtSize(selTotal))}).`);
  console.log(`Deleting the checked ones: ${freeLine(freeBytes(opts.roots[0]), selTotal)}`);
  console.log(`Deleting all of them:      ${freeLine(freeBytes(opts.roots[0]), total)}`);
}

// ---------------------------------------------------------------- picker

function picker(rows, opts) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const input = process.stdin;
    let sortKey = 'size';
    let cursor = 0;
    let top = 0;
    const free = freeBytes(opts.roots[0]);

    const render = () => {
      const width = out.columns || 120;
      const height = out.rows || 30;
      const view = Math.max(3, height - 6);
      if (cursor < top) top = cursor;
      if (cursor >= top + view) top = cursor - view + 1;

      const sel = rows.filter((r) => r.checked);
      const selTotal = sel.reduce((s, r) => s + r.size, 0);
      const total = rows.reduce((s, r) => s + r.size, 0);
      const lines = [];
      lines.push(
        `${c.bold('nomod')}  ${rows.length} folders, ${fmtSize(total)}  ·  ` +
          `${c.green(`${sel.length} selected`)}  ·  ${freeLine(free, selTotal)}  ·  sort: ${sortKey}`,
      );
      lines.push(c.dim('  ↑↓ move  space toggle  a all  n none  i invert  s sort  enter delete selected  q quit'));
      // Rows use width - 3: 2 for the cursor column, 1 spare so a full-width
      // line never triggers the terminal's wrap-at-last-column behaviour.
      lines.push(c.dim(`  ${header(width - 3)}`));
      for (let i = top; i < Math.min(rows.length, top + view); i++) {
        const r = rows[i];
        const line = colorRow(rowCells(r, opts.roots), r, width - 3);
        lines.push(i === cursor ? `${c.cyan('❯')} ${line}` : `  ${line}`);
      }
      for (let i = lines.length; i < view + 3; i++) lines.push('');
      const cur = rows[cursor];
      const info = cur.why.length ? `kept by default: ${cur.why.join('; ')}` : 'nothing against deleting it';
      lines.push(c.dim('─'.repeat(Math.min(width - 1, 100))));
      lines.push(c.cyan(cur.path.length > width - 1 ? `…${cur.path.slice(cur.path.length - width + 2)}` : cur.path));
      lines.push(
        c.dim(
          `${cur.files.toLocaleString()} files · last used ${cur.lastUsed ? new Date(cur.lastUsed).toLocaleDateString() : '?'} · ${info}`.slice(0, width - 1),
        ),
      );
      out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
    };

    const resort = () => {
      const current = rows[cursor];
      rows.sort(SORTS[sortKey]);
      cursor = rows.indexOf(current);
    };

    const finish = (result) => {
      input.off('data', onKey);
      out.off('resize', render);
      input.setRawMode(false);
      input.pause();
      out.write('\x1b[?7h\x1b[?25h\x1b[?1049l');
      resolve(result);
    };

    const onKey = (buf) => {
      const k = buf.toString();
      const page = Math.max(1, (out.rows || 30) - 7);
      switch (k) {
        case '\x1b[A':
        case 'k':
          cursor = Math.max(0, cursor - 1);
          break;
        case '\x1b[B':
        case 'j':
          cursor = Math.min(rows.length - 1, cursor + 1);
          break;
        case '\x1b[5~':
          cursor = Math.max(0, cursor - page);
          break;
        case '\x1b[6~':
          cursor = Math.min(rows.length - 1, cursor + page);
          break;
        case '\x1b[H':
        case '\x1b[1~':
        case 'g':
          cursor = 0;
          break;
        case '\x1b[F':
        case '\x1b[4~':
        case 'G':
          cursor = rows.length - 1;
          break;
        case ' ':
          rows[cursor].checked = !rows[cursor].checked;
          cursor = Math.min(rows.length - 1, cursor + 1);
          break;
        case 'a':
          for (const r of rows) r.checked = true;
          break;
        case 'n':
          for (const r of rows) r.checked = false;
          break;
        case 'i':
          for (const r of rows) r.checked = !r.checked;
          break;
        case 's': {
          const keys = Object.keys(SORTS);
          sortKey = keys[(keys.indexOf(sortKey) + 1) % keys.length];
          resort();
          break;
        }
        case '\r':
        case '\n':
          return finish(true);
        case 'q':
        case '\x1b':
        case '\x03':
          return finish(false);
        default:
          return;
      }
      render();
    };

    // Alternate screen, hidden cursor, and auto-wrap off: a line that is still
    // too wide (the summary line on a narrow terminal) is clipped, not wrapped,
    // so the layout never scrolls.
    out.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
    input.setRawMode(true);
    input.resume();
    input.on('data', onKey);
    out.on('resize', render);
    render();
  });
}

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(q, (a) => {
      rl.close();
      res(a.trim());
    }),
  );
}

// ---------------------------------------------------------------- deleting

const DELETABLE = new Set(['node_modules', ...NODE_JUNK, ...VENV_NAMES]);

async function removeOne(r) {
  const name = path.basename(r.path).toLowerCase();
  if (!DELETABLE.has(name)) throw new Error(`refusing: ${name} is not a folder nomod deletes`);
  const st = await lstat(r.path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('refusing: not a real folder (link or file)');
  // fs.rm does not follow links/junctions inside the folder, so pnpm's store is untouched.
  await rm(r.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
}

// `refused`: paths from --delete-from that failed their checks; they count as
// failed. `extra`: more fields for the JSON result.
async function deleteAll(sel, opts, refused = [], extra = {}) {
  const before = freeBytes(opts.roots[0]);
  let freed = 0;
  let failed = refused.length;
  const entry = (r) => ({ path: r.path, kind: r.kind ?? null, name: r.name ?? null, size: r.size ?? null });
  const result = { deleted: [], failed: refused.map((f) => ({ ...entry(f), error: f.error })) };
  const log = opts.json ? () => {} : console.log;
  for (const f of refused) log(`${c.red('✗')} ${''.padStart(8)}  ${f.path}\n            ${f.error}`);
  for (const [i, r] of sel.entries()) {
    status(`Deleting ${i + 1}/${sel.length}  ${r.path}`);
    try {
      await removeOne(r);
      freed += r.size;
      result.deleted.push(entry(r));
      clearStatus();
      log(`${c.green('✓')} ${fmtSize(r.size).padStart(8)}  ${r.path}`);
    } catch (e) {
      failed++;
      result.failed.push({ ...entry(r), error: errorText(e) });
      clearStatus();
      log(`${c.red('✗')} ${''.padStart(8)}  ${r.path}\n            ${c.red(e.code ?? '')} ${e.message}`);
    }
  }
  const after = freeBytes(opts.roots[0]);
  if (opts.json) {
    printJson({ ...result, freedBytes: freed, freeBytesBefore: before, freeBytesAfter: after, ...extra });
    return failed ? 1 : 0;
  }
  console.log(
    `\nDeleted ${result.deleted.length} of ${sel.length + refused.length} folders, about ${c.bold(fmtSize(freed))}.` +
      (before != null && after != null ? ` Free space: ${fmtSize(before)} → ${c.bold(fmtSize(after))}.` : ''),
  );
  if (refused.length) console.log(c.yellow(`${refused.length} refused: not a folder nomod deletes, or not there (see above).`));
  if (failed > refused.length)
    console.log(
      c.yellow(`${failed - refused.length} could not be deleted (a program may have files open there: close editors/dev servers and run nomod again).`),
    );
  if (sel.some((r) => r.tags.includes('pnpm')))
    console.log(c.dim('pnpm projects share a store, so they free less than their size. `pnpm store prune` reclaims the rest.'));
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- --delete-from

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

// The paths in a --delete-from list: one per line, or a JSON array of paths or
// of objects with a "path" (so a filtered `folders` array from a scan works).
async function readPathList(src) {
  let text;
  try {
    text = src === '-' ? await readStdin() : readFileSync(src, 'utf8');
  } catch (e) {
    fail(`--delete-from: ${e.message}`);
  }
  const t = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim(); // drop a byte-order mark
  let list;
  if (t.startsWith('{')) fail('--delete-from: give a list of paths (one per line, or a JSON array), not a whole scan result');
  if (t.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(t);
    } catch (e) {
      fail(`--delete-from: not valid JSON: ${e.message}`);
    }
    list = arr.map((x) => (typeof x === 'string' ? x : x?.path));
    if (list.some((p) => typeof p !== 'string' || !p)) fail('--delete-from: the JSON array must hold paths, or objects with a "path"');
  } else {
    list = t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const seen = new Set();
  return list.map((p) => path.resolve(p)).filter((p) => !seen.has(normPath(p)) && seen.add(normPath(p)));
}

// The checks a scan would have made before listing this folder. Returns its
// kind, or { error } when nomod must not delete it.
async function checkTarget(p) {
  const base = path.basename(p);
  const name = base.toLowerCase();
  if (!DELETABLE.has(name)) return { error: `refusing: ${base} is not a folder nomod deletes` };
  const st = await lstat(p).catch((e) => e);
  if (st instanceof Error) return { error: errorText(st) };
  if (st.isSymbolicLink() || !st.isDirectory()) return { error: 'refusing: not a real folder (link or file)' };
  const parent = path.dirname(p);
  if (parent.toLowerCase().split(/[\\/]/).includes('node_modules')) return { error: 'refusing: it is inside another node_modules' };
  if (name === 'node_modules') return { kind: 'node_modules' };
  if (VENV_NAMES.has(name)) return checkVenv(p);
  return checkBuildOutput(parent, base);
}

async function checkVenv(p) {
  return (await exists(path.join(p, 'pyvenv.cfg'))) ? { kind: 'venv' } : { error: 'refusing: not a Python venv (no pyvenv.cfg)' };
}

// An --all folder (dist, .next, ...): it must sit in a Node project, and
// dist/build/coverage must not be committed.
async function checkBuildOutput(parent, base) {
  if (!(await exists(path.join(parent, 'package.json')))) return { error: 'refusing: no package.json beside it, so not build output of a Node project' };
  if (!MAYBE_TRACKED.has(base.toLowerCase()) || !(await findGitRoot(parent))) return { kind: base };
  const tracked = await git(parent, ['ls-files', '--', base], 64 * 1024 * 1024);
  return tracked == null || tracked.trim() ? { error: 'refusing: git tracks files in it' } : { kind: base };
}

const errorText = (e) => `${e.code ? `${e.code}: ` : ''}${e.message}`;

// Split the listed paths into the ones nomod may delete (with their project
// name) and the refused ones.
async function checkListed(paths) {
  const ok = [];
  const refused = [];
  const repoNames = new Map(); // git root -> promise of remote repo name
  for (const p of paths) {
    const r = await checkTarget(p);
    if (r.error) {
      refused.push({ path: p, error: r.error });
      continue;
    }
    const project = path.dirname(p);
    const gitRoot = await findGitRoot(project);
    if (gitRoot && !repoNames.has(gitRoot)) repoNames.set(gitRoot, remoteRepoName(gitRoot));
    const row = { path: p, kind: r.kind, project, gitRoot, repoName: gitRoot ? await repoNames.get(gitRoot) : null };
    ok.push({ ...row, name: projectName(row) });
  }
  // A folder inside another one on the list goes with it: don't count it twice.
  return { rows: ok.filter((r) => !ok.some((o) => o !== r && isInside(r.path, o.path))), refused };
}

async function sizeListed(rows) {
  for (const [i, r] of rows.entries()) {
    const { bytes, files } = await dirSize(r.path, (n) => status(`Sizing ${i + 1}/${rows.length}… ${n.toLocaleString()} files  ${r.path}`));
    Object.assign(r, { size: bytes, files, tags: (await exists(path.join(r.path, '.pnpm'))) ? ['pnpm'] : [], checked: true });
  }
  clearStatus();
}

// The list --delete-from would delete, without deleting it. Its exit code.
function previewListed(rows, refused, total, opts) {
  const code = refused.length ? 1 : rows.length ? 0 : 2;
  if (opts.json) {
    printJson({
      freeBytes: freeBytes(opts.roots[0]),
      totalBytes: total,
      folders: rows.map(({ path: p, kind, name, size, files, tags }) => ({ path: p, kind, name, size, files, tags })),
      refused,
    });
    return code;
  }
  for (const r of rows) console.log(`  ${fmtSize(r.size).padStart(8)}  ${r.path}`);
  for (const f of refused) console.log(`${c.red('✗')} ${''.padStart(8)}  ${f.path}\n            ${f.error}`);
  console.log(`\n${rows.length} to delete: ${freeLine(freeBytes(opts.roots[0]), total)}${refused.length ? c.yellow(`. ${refused.length} refused.`) : ''}`);
  return code;
}

// "Delete these N folders?" False, after saying so, on anything but yes.
async function confirmDelete(rows, total) {
  const a = await ask(`Delete these ${rows.length} folders (${c.bold(fmtSize(total))})? [y/N] `);
  if (/^y(es)?$/i.test(a)) return true;
  console.log('Cancelled. Nothing deleted.');
  return false;
}

async function deleteListed(opts, interactive) {
  const paths = await readPathList(opts.deleteFrom);
  if (!paths.length) fail('--delete-from: the list is empty');
  const { rows, refused } = await checkListed(paths);
  await sizeListed(rows);
  opts.roots = [path.dirname(rows[0]?.path ?? process.cwd())]; // where free space is measured
  const total = rows.reduce((s, r) => s + r.size, 0);

  if (!opts.dryRun && opts.yes) return deleteAll(rows, opts, refused);
  const code = previewListed(rows, refused, total, opts);
  if (opts.json || opts.dryRun || !rows.length) return code;
  if (!interactive) {
    console.log(c.dim('\nNo terminal, so nothing was deleted. Add --yes to delete them.'));
    return code;
  }
  return (await confirmDelete(rows, total)) ? deleteAll(rows, opts, refused) : 3;
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  for (const r of opts.roots) {
    const st = await stat(r).catch(() => null);
    if (!st?.isDirectory()) fail(`not a folder: ${r}`);
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !opts.json;
  if (opts.deleteFrom != null) return deleteListed(opts, interactive);

  const t0 = Date.now();
  const { found, dirs } = await discover(opts);
  const rows = await enrich(found, opts);
  rows.sort(SORTS.size);
  setNameWidth(rows);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const unmatchedPicks = findUnmatchedPicks(opts, rows);
  if (opts.json && (!opts.yes || opts.dryRun)) return printScanJson(rows, opts, unmatchedPicks);
  if (!rows.length) {
    if (opts.json) printJson({ ...nothingDeleted(opts), unmatchedPicks });
    else console.log(`Nothing found (${dirs.toLocaleString()} folders scanned in ${secs}s).`);
    return 2;
  }
  console.error(c.dim(`Scanned ${dirs.toLocaleString()} folders in ${secs}s.`));

  if (opts.dryRun || (!interactive && !opts.yes)) {
    printReport(rows, opts);
    if (!opts.dryRun) console.log(c.dim('\nNo terminal, so nothing was deleted. Run nomod in a terminal, or add --yes to delete the checked ones.'));
    return 0;
  }
  if (opts.yes && unmatchedPicks.length) {
    if (opts.json) printJson({ ...nothingDeleted(opts), unmatchedPicks });
    else console.log('Nothing deleted: a --pick matches no folder (see above). Check the pattern against a scan.');
    return 2;
  }
  return deleteChosen(rows, opts, interactive, unmatchedPicks);
}

// A --pick that matches nothing is most likely a typo: say so. With --yes,
// main then deletes nothing, since the selection is not what was asked for.
function findUnmatchedPicks(opts, rows) {
  const unmatched = opts.pick.filter((re) => !rows.some((r) => re.test(r.path))).map((re) => re.source);
  for (const p of unmatched) process.stderr.write(`nomod: --pick '${p}' matches no folder\n`);
  return unmatched;
}

const nothingDeleted = (opts) => {
  const free = freeBytes(opts.roots[0]);
  return { deleted: [], failed: [], freedBytes: 0, freeBytesBefore: free, freeBytesAfter: free };
};

function printScanJson(rows, opts, unmatchedPicks) {
  const sum = (rs) => rs.reduce((s, r) => s + r.size, 0);
  printJson({
    roots: opts.roots,
    freeBytes: freeBytes(opts.roots[0]),
    totalBytes: sum(rows),
    checkedBytes: sum(rows.filter((r) => r.checked)),
    unmatchedPicks,
    folders: rows.map((r) => (opts.brief ? briefFolder(r) : fullFolder(r))),
  });
  return rows.length ? 0 : 2;
}

// What an agent needs to show the user and choose: no repeated paths
// (project, gitRoot), no file counts or git status.
const briefFolder = (r) => ({
  path: r.path,
  kind: r.kind,
  name: r.name,
  size: r.size,
  lastUsed: r.lastUsed && new Date(r.lastUsed).toISOString(),
  tags: r.tags,
  keepReasons: r.why,
  checked: r.checked,
});

const fullFolder = (r) => ({
  ...briefFolder(r),
  project: r.project,
  files: r.files,
  gitRoot: r.gitRoot,
  git: r.git,
});

// The picker (in a terminal), then "are you sure" (unless --yes), then delete.
async function deleteChosen(rows, opts, interactive, unmatchedPicks) {
  if (interactive && !(await picker(rows, opts))) {
    console.log('Cancelled. Nothing deleted.');
    return 3;
  }
  const sel = rows.filter((r) => r.checked);
  if (!sel.length && !opts.json) {
    console.log('Nothing selected. Nothing deleted.');
    return 0;
  }
  if (!opts.yes) {
    const selTotal = sel.reduce((s, r) => s + r.size, 0);
    for (const r of sel.slice(0, 25)) console.log(`  ${fmtSize(r.size).padStart(8)}  ${r.path}`);
    if (sel.length > 25) console.log(c.dim(`  … and ${sel.length - 25} more`));
    console.log(`\n${freeLine(freeBytes(opts.roots[0]), selTotal)}`);
    if (!(await confirmDelete(sel, selTotal))) return 3;
  }
  return deleteAll(sel, opts, [], { unmatchedPicks });
}

main().then(
  (code) => process.exit(code),
  (e) => {
    clearStatus();
    if (process.stdout.isTTY) process.stdout.write('\x1b[?7h\x1b[?25h');
    fail(e.stack || e.message);
  },
);
