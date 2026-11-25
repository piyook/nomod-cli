#!/usr/bin/env node
// Prepare and publish nomod-cli to npm.
//
//   npm run release                  publish the current version if npm doesn't have it yet,
//                                    otherwise bump the patch version first
//   npm run release -- minor         bump minor (or: patch, major, 1.4.0) and publish
//   npm run release -- --dry-run     run every check and show the package, publish nothing
//
// Steps: check git is clean, on main and in sync with origin -> smoke tests ->
// bump the version (commit + tag) -> show the package contents and confirm ->
// npm login if needed (you type your credentials / one-time code) -> npm publish ->
// git push with tags.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpArg = args.find((a) => !a.startsWith('-'));

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (s) => console.log(`\n${bold('▸ ' + s)}`);

function die(msg) {
  console.error(`\n${red('✗ ' + msg)}`);
  process.exit(1);
}

// Run a command. `capture` returns trimmed stdout; otherwise output goes to
// the terminal (needed for npm login / one-time-password prompts).
// On Windows npm is npm.cmd, which only runs through a shell.
function run(cmd, cmdArgs, { capture = false, allowFail = false, env } = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd === 'npm',
    env: env ?? process.env,
  });
  if (r.status !== 0 && !allowFail) {
    die(`${cmd} ${cmdArgs.join(' ')} failed${capture ? `:\n${(r.stderr || r.stdout || '').trim()}` : ''}`);
  }
  return capture ? (r.stdout || '').trim() : r.status;
}

const git = (...a) => run('git', a, { capture: true });
const version = () => JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const name = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

// ---------------------------------------------------------------- 1. git

step('Checking git');
// In a dry run these are warnings, so you can check a release before committing.
const gitProblem = (msg) => (dryRun ? console.log(`\x1b[33m! ${msg} (a real release stops here)\x1b[0m`) : die(msg));
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') gitProblem(`on branch ${branch}: switch to main first`);
const dirty = Boolean(git('status', '--porcelain'));
if (dirty) gitProblem('there are uncommitted changes: commit or stash them first');
run('git', ['fetch', '--quiet', 'origin'], { capture: true });
const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD').split(/\s+/).map(Number);
if (behind) gitProblem(`main is ${behind} commit(s) behind origin/main: git pull first`);
console.log(`${branch}${dirty ? ', uncommitted changes' : ', clean'}${ahead ? `, ${ahead} commit(s) to push` : ', in sync with origin'}`);

// ---------------------------------------------------------------- 2. smoke tests

step('Smoke tests');
const nodeEnv = { ...process.env };
delete nodeEnv.ELECTRON_RUN_AS_NODE;
const nomod = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'nomod.js'), ...a], { encoding: 'utf8', env: nodeEnv });

run(process.execPath, ['--check', path.join(ROOT, 'nomod.js')]);
const check = (ok, label) => { if (!ok) die(`smoke test failed: ${label}`); console.log(`${green('✓')} ${label}`); };

check(nomod('--version').stdout.trim() === version(), '--version prints the package version');
check(nomod('--help').stdout.includes('Usage: nomod'), '--help prints usage');
check(nomod('--bogus').status === 1, 'an unknown option exits 1');

// A tiny fixture: one old project with a lockfile (deleted), one without (kept).
const fx = mkdtempSync(path.join(os.tmpdir(), 'nomod-release-'));
try {
  for (const p of ['locked', 'nolock']) {
    mkdirSync(path.join(fx, p, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(fx, p, 'package.json'), '{}');
    writeFileSync(path.join(fx, p, 'node_modules', 'dep', 'index.js'), 'x'.repeat(1000));
  }
  writeFileSync(path.join(fx, 'locked', 'package-lock.json'), '{}');

  const scan = JSON.parse(nomod('--json', '--recent', '0', fx).stdout);
  check(scan.folders.length === 2, '--json finds both node_modules');
  check(scan.folders.find((f) => f.name === 'locked')?.checked === true, 'a project with a lockfile starts checked');
  check(scan.folders.find((f) => f.name === 'nolock')?.checked === false, 'a project without a lockfile starts unchecked');

  const del = JSON.parse(nomod('--json', '--yes', '--recent', '0', fx).stdout);
  check(del.deleted.length === 1 && del.failed.length === 0, '--json --yes deletes only the checked folder');
  check(JSON.parse(nomod('--json', fx).stdout).folders.length === 1, 'the deleted folder is gone, the other is still there');
} finally {
  rmSync(fx, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. version

step('Version');
const published = run('npm', ['view', name, 'versions', '--json'], { capture: true, allowFail: true });
// A list (or a single string) of versions; a not-yet-published package gives
// an {"error": ...} object instead, which means none.
let onNpm = [];
try {
  const v = JSON.parse(published || '[]');
  if (Array.isArray(v) || typeof v === 'string') onNpm = [].concat(v);
} catch { /* not published yet */ }
console.log(onNpm.length ? `on npm: ${onNpm.slice(-5).join(', ')}` : `${name} is not on npm yet`);

const bump = bumpArg ?? (onNpm.includes(version()) ? 'patch' : null);
if (bump && !dryRun) {
  // Commits package.json and tags vX.Y.Z.
  run('npm', ['version', bump, '-m', 'Release %s']);
} else if (bump) {
  console.log(`would run: npm version ${bump}`);
}
const v = version();
if (!dryRun && onNpm.includes(v)) die(`${v} is already on npm: pass patch, minor, major or a new version`);
console.log(`publishing ${bold(`${name}@${v}`)}`);

// ---------------------------------------------------------------- 4. contents

step('Package contents');
run('npm', ['pack', '--dry-run']);

if (dryRun) {
  console.log(`\n${green('Dry run finished.')} Nothing was published. Run without --dry-run to publish.`);
  process.exit(0);
}

const answer = await ask(`\nPublish ${bold(`${name}@${v}`)} to npm? [y/N] `);
if (!/^y(es)?$/i.test(answer)) {
  console.log(`Not published. To undo the version bump: git tag -d v${v} && git reset --hard HEAD~1`);
  process.exit(3);
}

// ---------------------------------------------------------------- 5. login + publish

step('npm login');
const who = run('npm', ['whoami'], { capture: true, allowFail: true });
if (who) console.log(`logged in as ${who}`);
else {
  console.log('Not logged in. Log in below (this opens a browser or asks for your details).');
  run('npm', ['login']);
}

step('Publishing');
// npm asks for a one-time password here if your account has 2FA on.
run('npm', ['publish']);

// ---------------------------------------------------------------- 6. push

step('Pushing to GitHub');
run('git', ['push', '--follow-tags', 'origin', 'main']);

console.log(`\n${green(`✓ Published ${name}@${v}`)}  https://www.npmjs.com/package/${name}`);
console.log(`  Install: npm install -g ${name}`);
