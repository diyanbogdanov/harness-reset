import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCli } from '../src/cli.js';

function createMemoryFs(entries = {}) {
  const files = new Map(Object.entries(entries));
  const dirs = new Set();
  const writeCalls = [];
  const renameCalls = [];

  return {
    writeCalls,
    renameCalls,
    existsSync(filePath) {
      return files.has(filePath) || dirs.has(filePath);
    },
    readFileSync(filePath, encoding) {
      assert.equal(encoding, 'utf8');
      return files.get(filePath);
    },
    mkdirSync(dirPath, options) {
      assert.deepEqual(options, { recursive: true });
      dirs.add(dirPath);
    },
    writeFileSync(filePath, contents, encoding) {
      assert.equal(encoding, 'utf8');
      writeCalls.push({ filePath, contents });
      files.set(filePath, contents);
    },
    renameSync(oldPath, newPath) {
      renameCalls.push({ oldPath, newPath });
      files.set(newPath, files.get(oldPath));
      files.delete(oldPath);
    },
    readdirSync() {
      return [];
    },
  };
}

function createIo(input = '') {
  return {
    stdout: '',
    stderr: '',
    stdin: {
      read() {
        return input;
      },
    },
    writeStdout(text) {
      this.stdout += text;
    },
    writeStderr(text) {
      this.stderr += text;
    },
  };
}

function createSpawn(versionByCommand = {}) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });

    if (args.length === 1 && args[0] === '--version') {
      return { status: 0, stdout: `${versionByCommand[command] || '1.0.0'}\n` };
    }

    return { status: 0, stdout: '' };
  };

  return { calls, spawnSync };
}

test('detect prints installed and missing provider availability', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli(['detect'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /claude: installed \(2\.1\.104 \(Claude Code\)\); local state found/);
  assert.match(io.stdout, /codex: missing; local state missing/);
  assert.deepEqual(
    spawn.calls.map((call) => [call.command, call.args]),
    [['/bin/claude', ['--version']]],
  );
});

test('setup dry-run for Claude prints schedule and native action without creating it', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli(
    ['setup', '--provider', 'claude', '--time', '09:00', '--dry-run'],
    {
      env: { HOME: '/home/alex', PATH: '/bin' },
      fs,
      io,
      platform: 'linux',
      spawnSync: spawn.spawnSync,
    },
  );

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /DRY RUN/);
  assert.match(io.stdout, /Schedule: daily at 09:00/);
  assert.match(io.stdout, /Prompt:/);
  assert.match(io.stdout, /consume normal plan usage/);
  assert.match(io.stdout, /claude "\/schedule daily at 09:00/);
  assert.deepEqual(
    spawn.calls.map((call) => [call.command, call.args]),
    [['/bin/claude', ['--version']]],
  );
});

test('setup without yes requires typed confirmation before creating Claude routine', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo('no');
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli(['setup', '--provider', 'claude', '--time', '09:00'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 1);
  assert.match(io.stdout, /Type "create" to continue/);
  assert.match(io.stdout, /Aborted/);
  assert.deepEqual(
    spawn.calls.map((call) => [call.command, call.args]),
    [['/bin/claude', ['--version']]],
  );
});

test('setup dry-run for Codex prints fallback automation instructions', async () => {
  const fs = createMemoryFs({
    '/bin/codex': '',
    '/home/alex/.codex': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/codex': '0.46.0' });

  const exitCode = await runCli(
    ['setup', '--provider', 'codex', '--time', '09:00', '--dry-run'],
    {
      env: { HOME: '/home/alex', PATH: '/bin' },
      fs,
      io,
      platform: 'linux',
      spawnSync: spawn.spawnSync,
    },
  );

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Open a Codex thread/);
  assert.match(io.stdout, /Harness Reset Warmup/);
});

test('status prints current config JSON from injected config path', async () => {
  const configPath = '/tmp/harness-reset/config.json';
  const fs = createMemoryFs({
    [configPath]: JSON.stringify({
      version: 1,
      providers: {
        claude: {
          enabled: true,
          routineName: 'Harness Reset Warmup',
          schedule: 'daily at 09:00',
          promptHash: 'sha256:test',
        },
      },
    }),
  });
  const io = createIo();

  const exitCode = await runCli(['status'], {
    env: { HOME: '/home/alex', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(io.stdout), {
    version: 1,
    providers: {
      claude: {
        enabled: true,
        routineName: 'Harness Reset Warmup',
        schedule: 'daily at 09:00',
        promptHash: 'sha256:test',
      },
    },
  });
});

test('unsupported provider returns nonzero with a useful stderr message', async () => {
  const io = createIo();

  const exitCode = await runCli(['setup', '--provider', 'vim', '--time', '09:00'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs: createMemoryFs(),
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /Unsupported provider: vim/);
  assert.match(io.stderr, /claude, codex/);
});

test('setup without enough history and no time asks for explicit time', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli(['setup', '--provider', 'claude', '--dry-run'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 1);
  assert.match(io.stdout, /insufficient history/i);
  assert.match(io.stdout, /Re-run with --time HH:MM/);
});

test('runCli prints usage when invoked with no args', async () => {
  const io = createIo();

  const exitCode = await runCli([], { io });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /^Usage: harness-reset/);
});
