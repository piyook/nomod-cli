// Tests for nomod, run as a real CLI against throwaway folders in the OS temp
// folder. No dependencies: node:test only. Run with `npm test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const NOMOD = fileURLToPath(new URL('../nomod.js', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set in VS Code shells; would break nothing here, but keep runs clean
env.NO_COLOR = '1';

function nomod(args, input) {
  const r = spawnSync(process.execPath, [NOMOD, ...args], { encoding: 'utf8', env, input: input ?? '' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const hasGit = spawnSync('git', ['--version']).status === 0;
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

let fx;
// A Node project at fx/<name>: package.json, a node_modules with one file, and a lockfile unless lock: false.
function project(name, { lock = true } = {}) {
  const dir = path.join(fx, name);
  mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{}');
  writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x'.repeat(1000));
  if (lock) writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  return dir;
}
const nm = (name) => path.join(fx, name, 'node_modules');

beforeEach(() => {
  fx = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nomod-test-')));
});
afterEach(() => {
  rmSync(fx, { recursive: true, force: true });
});

describe('basics', () => {
  test('--version prints the package version', () => {
    assert.match(nomod(['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('--help points to llms.txt, and the file is there', () => {
    const m = nomod(['--help']).stdout.match(/guide .* is (.*llms\.txt)/);
    assert.ok(m, 'help mentions llms.txt');
    assert.ok(existsSync(m[1].trim()), `llms.txt exists at ${m[1]}`);
  });

  test('an unknown option exits 1 with a text error', () => {
    const r = nomod(['--bogus']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown option --bogus/);
  });

  test('with --json, errors are JSON on stdout too', () => {
    const r = nomod(['--json', '--bogus']);
    assert.equal(r.code, 1);
    assert.equal(r.json.schemaVersion, 1);
    assert.match(r.json.error, /unknown option --bogus/);
  });

  test('a folder that does not exist is an error', () => {
    const r = nomod(['--json', path.join(fx, 'nope')]);
    assert.equal(r.code, 1);
    assert.match(r.json.error, /not a folder/);
  });

  test('nothing found exits 2', () => {
    const r = nomod(['--json', fx]);
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.folders, []);
  });
});

describe('scan', () => {
  test('lists node_modules with schemaVersion, sizes and default checks', () => {
    project('locked');
    project('nolock', { lock: false });
    const r = nomod(['--json', '--recent', '0', fx]);
    assert.equal(r.code, 0);
    assert.equal(r.json.schemaVersion, 1);
    assert.deepEqual(r.json.unmatchedPicks, []);
    assert.equal(r.json.folders.length, 2);
    const locked = r.json.folders.find((f) => f.name === 'locked');
    const nolock = r.json.folders.find((f) => f.name === 'nolock');
    assert.equal(locked.checked, true);
    assert.deepEqual(locked.keepReasons, []);
    assert.ok(locked.size >= 1000);
    assert.equal(nolock.checked, false);
    assert.ok(nolock.tags.includes('no-lock'));
    assert.equal(r.json.checkedBytes, locked.size);
  });

  test('JSON is one line when piped', () => {
    project('a');
    const out = nomod(['--json', fx]).stdout;
    assert.equal(out.trim().split('\n').length, 1);
    assert.equal(JSON.parse(out).folders.length, 1);
  });

  test('--brief keeps only the fields needed to choose, and is smaller', () => {
    project('a');
    project('b', { lock: false });
    const full = nomod(['--json', '--recent', '0', fx]);
    const brief = nomod(['--json', '--brief', '--recent', '0', fx]);
    assert.equal(brief.code, 0);
    assert.deepEqual(Object.keys(brief.json.folders[0]).sort(), ['checked', 'keepReasons', 'kind', 'lastUsed', 'name', 'path', 'size', 'tags']);
    assert.deepEqual(
      brief.json.folders.map((f) => [f.name, f.checked]),
      full.json.folders.map((f) => [f.name, f.checked]),
    );
    assert.equal(brief.json.checkedBytes, full.json.checkedBytes);
    assert.ok(brief.stdout.length < full.stdout.length);
  });

  test('recently used projects start unchecked', () => {
    project('fresh');
    const f = nomod(['--json', fx]).json.folders[0];
    assert.equal(f.checked, false);
    assert.match(f.keepReasons.join(), /used today/);
  });

  test('--exclude and --min leave folders out', () => {
    project('a');
    project('b');
    assert.equal(nomod(['--json', '--exclude', '[\\\\/]a[\\\\/]', fx]).json.folders.length, 1);
    assert.equal(nomod(['--json', '--min', '1', fx]).code, 2);
  });

  test('without a terminal and without --yes, nothing is deleted', () => {
    project('a');
    const r = nomod(['--recent', '0', fx]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /nothing was deleted/);
    assert.ok(existsSync(nm('a')));
  });

  test('--dry-run overrides --yes', () => {
    project('a');
    nomod(['--json', '--yes', '--dry-run', '--recent', '0', fx]);
    assert.ok(existsSync(nm('a')));
  });

  test('--all lists venvs and build output, but not dist that git tracks', { skip: !hasGit && 'git not installed' }, () => {
    const p = project('app');
    mkdirSync(path.join(p, '.venv'));
    writeFileSync(path.join(p, '.venv', 'pyvenv.cfg'), '');
    mkdirSync(path.join(p, 'coverage'));
    writeFileSync(path.join(p, 'coverage', 'x'), 'x');
    mkdirSync(path.join(p, 'dist'));
    writeFileSync(path.join(p, 'dist', 'index.js'), 'x');
    git(p, 'init', '-q');
    git(p, 'add', 'dist');
    git(p, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'dist');
    const kinds = nomod(['--json', '--all', fx])
      .json.folders.map((f) => f.kind)
      .sort();
    assert.deepEqual(kinds, ['coverage', 'node_modules', 'venv']);
    assert.deepEqual(
      nomod(['--json', fx]).json.folders.map((f) => f.kind),
      ['node_modules'],
    );
  });
});

describe('delete with --yes', () => {
  test('deletes only the checked folders and reports kind and name', () => {
    project('locked');
    project('nolock', { lock: false });
    const r = nomod(['--json', '--yes', '--recent', '0', fx]);
    assert.equal(r.code, 0);
    assert.equal(r.json.schemaVersion, 1);
    assert.equal(r.json.deleted.length, 1);
    assert.equal(r.json.failed.length, 0);
    assert.equal(r.json.deleted[0].kind, 'node_modules');
    assert.equal(r.json.deleted[0].name, 'locked');
    assert.equal(r.json.freedBytes, r.json.deleted[0].size);
    assert.ok(!existsSync(nm('locked')));
    assert.ok(existsSync(nm('nolock')));
    assert.ok(existsSync(path.join(fx, 'locked', 'package.json')), 'the project itself is untouched');
  });

  test('--pick checks exactly the matching folders, even ones kept by default', () => {
    project('locked');
    project('nolock', { lock: false });
    const preview = nomod(['--json', '--recent', '0', '--pick', 'nolock', fx]).json;
    assert.deepEqual(
      preview.folders.filter((f) => f.checked).map((f) => f.name),
      ['nolock'],
    );
    const r = nomod(['--json', '--yes', '--recent', '0', '--pick', 'nolock', fx]);
    assert.equal(r.code, 0);
    assert.ok(existsSync(nm('locked')));
    assert.ok(!existsSync(nm('nolock')));
  });

  test('a --pick that matches nothing: warned, and with --yes nothing is deleted (exit 2)', () => {
    project('a');
    project('b');
    const scan = nomod(['--json', '--recent', '0', '--pick', 'typo', fx]);
    assert.deepEqual(scan.json.unmatchedPicks, ['typo']);
    assert.match(scan.stderr, /--pick 'typo' matches no folder/);

    const r = nomod(['--json', '--yes', '--recent', '0', '--pick', '[\\\\/]a[\\\\/]', '--pick', 'typo', fx]);
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.deleted, []);
    assert.deepEqual(r.json.unmatchedPicks, ['typo']);
    assert.ok(existsSync(nm('a')), 'the folder the other --pick matched is kept too');
  });
});

describe('--delete-from', () => {
  test('deletes exactly the listed paths (one per line), no scan', () => {
    project('a');
    project('b');
    project('c');
    const list = path.join(fx, 'list.txt');
    // Byte-order mark (as Windows PowerShell 5 writes), CRLF, a blank line, a duplicate.
    writeFileSync(list, `${String.fromCharCode(0xfeff)}${nm('a')}\r\n\n${nm('b')}\n${nm('b')}\n`);
    const r = nomod(['--json', '--yes', '--delete-from', list]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.deleted.map((d) => d.name).sort(), ['a', 'b']);
    assert.ok(r.json.deleted.every((d) => d.kind === 'node_modules' && d.size >= 1000));
    assert.ok(!existsSync(nm('a')) && !existsSync(nm('b')));
    assert.ok(existsSync(nm('c')), 'unlisted folders are untouched');
  });

  test('reads a JSON array of scan entries from stdin', () => {
    project('a');
    project('b');
    const scan = nomod(['--json', '--recent', '0', fx]).json;
    const pickA = JSON.stringify(scan.folders.filter((f) => f.name === 'a'));
    const r = nomod(['--json', '--yes', '--delete-from', '-'], pickA);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.deleted.length, 1);
    assert.ok(!existsSync(nm('a')));
    assert.ok(existsSync(nm('b')));
  });

  test('without --yes it previews and deletes nothing', () => {
    project('a');
    const r = nomod(['--json', '--delete-from', '-'], nm('a'));
    assert.equal(r.code, 0);
    assert.equal(r.json.folders.length, 1);
    assert.equal(r.json.folders[0].name, 'a');
    assert.ok(r.json.totalBytes >= 1000);
    assert.ok(existsSync(nm('a')));

    const text = nomod(['--delete-from', '-'], nm('a'));
    assert.match(text.stdout, /nothing was deleted/);
    assert.ok(existsSync(nm('a')));
  });

  test('refuses anything a scan would not list, and still deletes the rest (exit 1)', () => {
    const p = project('a');
    project('b');
    mkdirSync(path.join(p, 'src'));
    mkdirSync(path.join(p, 'env')); // venv name, but no pyvenv.cfg
    mkdirSync(path.join(fx, 'loose', 'dist'), { recursive: true }); // no package.json beside it
    mkdirSync(path.join(nm('a'), 'dep', 'node_modules')); // nested dependency
    const listed = [
      nm('b'),
      path.join(p, 'src'),
      path.join(p, 'env'),
      path.join(fx, 'loose', 'dist'),
      path.join(nm('a'), 'dep', 'node_modules'),
      path.join(fx, 'missing', 'node_modules'),
    ];
    const r = nomod(['--json', '--yes', '--delete-from', '-'], JSON.stringify(listed));
    assert.equal(r.code, 1);
    assert.deepEqual(
      r.json.deleted.map((d) => d.path),
      [nm('b')],
    );
    const why = Object.fromEntries(r.json.failed.map((f) => [path.relative(fx, f.path), f.error]));
    assert.match(why[path.join('a', 'src')], /not a folder nomod deletes/);
    assert.match(why[path.join('a', 'env')], /not a Python venv/);
    assert.match(why[path.join('loose', 'dist')], /no package\.json/);
    assert.match(why[path.join('a', 'node_modules', 'dep', 'node_modules')], /inside another node_modules/);
    assert.match(why[path.join('missing', 'node_modules')], /ENOENT/);
    for (const l of listed.slice(1, 5)) assert.ok(existsSync(l), `${l} is kept`);
  });

  test('refuses a node_modules that is a link, and leaves its target alone', () => {
    const target = path.join(fx, 'store');
    mkdirSync(target);
    writeFileSync(path.join(target, 'keep.js'), 'x');
    mkdirSync(path.join(fx, 'linked'));
    try {
      symlinkSync(target, path.join(fx, 'linked', 'node_modules'), 'junction');
    } catch {
      return; // no permission to make links here: nothing to test
    }
    const r = nomod(['--json', '--yes', '--delete-from', '-'], path.join(fx, 'linked', 'node_modules'));
    assert.equal(r.code, 1);
    assert.match(r.json.failed[0].error, /not a real folder/);
    assert.ok(existsSync(path.join(target, 'keep.js')));
  });

  test('refuses dist that git tracks', { skip: !hasGit && 'git not installed' }, () => {
    const p = project('app');
    mkdirSync(path.join(p, 'dist'));
    writeFileSync(path.join(p, 'dist', 'index.js'), 'x');
    git(p, 'init', '-q');
    git(p, 'add', 'dist');
    git(p, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'dist');
    const r = nomod(['--json', '--yes', '--delete-from', '-'], path.join(p, 'dist'));
    assert.equal(r.code, 1);
    assert.match(r.json.failed[0].error, /git tracks/);
    assert.ok(existsSync(path.join(p, 'dist', 'index.js')));
  });

  test('takes no folder and no --pick, and rejects a whole scan object', () => {
    project('a');
    assert.match(nomod(['--json', '--delete-from', '-', fx], nm('a')).json.error, /takes no folder/);
    assert.match(nomod(['--json', '--delete-from', '-', '--pick', 'a'], nm('a')).json.error, /no --pick/);
    assert.match(nomod(['--json', '--delete-from', '-'], '{"folders":[]}').json.error, /not a whole scan/);
    assert.match(nomod(['--json', '--delete-from', '-'], '  ').json.error, /empty/);
    assert.ok(existsSync(nm('a')));
  });
});
