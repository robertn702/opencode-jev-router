import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const setup = fileURLToPath(new URL('./setup.sh', import.meta.url));

function fixture(t, { main = false, failInstall = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  const worktree = main ? root : join(dir, 'worktree');
  mkdirSync(root);
  if (!main) mkdirSync(worktree);
  execFileSync('git', ['init', '-q', root]);
  const scripts = join(worktree, 'scripts');
  mkdirSync(scripts);
  copyFileSync(setup, join(scripts, 'setup.sh'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexit ${failInstall ? 1 : 0}\n`, { mode: 0o755 });
  const run = () => spawnSync('bash', [join(scripts, 'setup.sh')], {
    cwd: worktree,
    env: { ...process.env, ORCA_ROOT_PATH: root, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  return { root, worktree, run };
}

test('copies local environment files without overwriting existing files or copying templates', (t) => {
  const { root, worktree, run } = fixture(t);
  writeFileSync(join(root, '.env'), 'secret=from-main\n');
  writeFileSync(join(root, '.env.local'), 'local=from-main\n');
  writeFileSync(join(root, '.env.example'), 'template=main\n');
  writeFileSync(join(worktree, '.env.example'), 'template=worktree\n');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'secret=from-main\n');
  assert.equal(readFileSync(join(worktree, '.env.local'), 'utf8'), 'local=from-main\n');
  assert.equal(readFileSync(join(worktree, '.env.example'), 'utf8'), 'template=worktree\n');
  writeFileSync(join(worktree, '.env'), 'secret=worktree\n');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'secret=worktree\n');
});

test('creates .env from the example when the main checkout has no .env', (t) => {
  const { worktree, run } = fixture(t);
  writeFileSync(join(worktree, '.env.example'), 'TYPESAFE_API_KEY=\n');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'TYPESAFE_API_KEY=\n');
});

test('links shared scratch and local agent notes when available', (t) => {
  const { root, worktree, run } = fixture(t);
  mkdirSync(join(root, '.scratch', 'shared'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'shared', 'AGENTS.local.md'), 'notes\n');
  assert.equal(run().status, 0);
  assert.ok(lstatSync(join(worktree, '.scratch', 'shared')).isSymbolicLink());
  assert.ok(lstatSync(join(worktree, 'AGENTS.local.md')).isSymbolicLink());
  assert.equal(readFileSync(join(worktree, 'AGENTS.local.md'), 'utf8'), 'notes\n');
});

test('stops before copying local files when npm ci fails', (t) => {
  const { root, worktree, run } = fixture(t, { failInstall: true });
  writeFileSync(join(root, '.env'), 'secret=from-main\n');
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(join(worktree, '.env')), false);
});

test('runs from the main checkout without worktree-specific changes', (t) => {
  const { root, run } = fixture(t, { main: true });
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(root, '.env')), false);
});
