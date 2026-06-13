import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('package publishes only src and points bin at an executable CLI stub', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.deepEqual(packageJson.files, ['src']);

  const binTarget = packageJson.bin?.['agent-warmup'];
  assert.equal(typeof binTarget, 'string');

  const binPath = path.join(process.cwd(), binTarget);
  await access(binPath);

  const binContents = await readFile(binPath, 'utf8');
  assert.equal(binContents.split('\n')[0], '#!/usr/bin/env node');
});

test('installed package bin prints usage from the CLI stub', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-warmup-package-'));
  const installDir = path.join(tempDir, 'install');

  try {
    await mkdir(installDir);

    const { stdout: packOutput } = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', tempDir],
      { cwd: process.cwd() },
    );
    const [{ filename }] = JSON.parse(packOutput);
    const tarballPath = path.join(tempDir, filename);

    await execFileAsync('npm', ['install', '--prefix', installDir, tarballPath]);

    const binName = process.platform === 'win32' ? 'agent-warmup.cmd' : 'agent-warmup';
    const binPath = path.join(installDir, 'node_modules', '.bin', binName);
    const { stdout } = await execFileAsync(binPath);

    assert.match(stdout, /^Usage: agent-warmup/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('CLI import does not throw when argv path is not realpath-able', async () => {
  await execFileAsync('node', [
    '--input-type=module',
    '-e',
    "process.argv[1] = '-'; await import('./src/cli.js');",
  ]);
});
