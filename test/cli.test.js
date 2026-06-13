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

function metadataFromStatus(output) {
  const marker = 'Metadata:\n';
  const markerIndex = output.indexOf(marker);

  assert.notEqual(markerIndex, -1);
  return JSON.parse(output.slice(markerIndex + marker.length));
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

test('setup Claude on Windows uses detected cmd shim before writing metadata', async () => {
  const executable = 'C:\\Tools\\claude.CMD';
  const fs = createMemoryFs({
    [executable]: '',
    'C:\\Users\\Alex\\.claude': '',
  });
  const io = createIo();
  const spawnCalls = [];
  const spawnSync = (command, args, options) => {
    spawnCalls.push({ command, args, options });

    if (command === 'cmd.exe' && args.at(-1) === `"${executable}" --version`) {
      return { status: 0, stdout: '2.1.104 (Claude Code)\r\n' };
    }

    assert.equal(fs.writeCalls.length, 0);
    assert.equal(fs.renameCalls.length, 0);
    return { status: 0, stdout: '' };
  };

  const exitCode = await runCli(['setup', '--provider', 'claude', '--time', '09:00', '--yes'], {
    env: {
      APPDATA: 'C:\\Users\\Alex\\AppData\\Roaming',
      Path: 'C:\\Tools',
      PATHEXT: '.CMD',
      USERPROFILE: 'C:\\Users\\Alex',
    },
    fs,
    io,
    platform: 'win32',
    spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0], {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${executable}" --version`],
    options: {
      encoding: 'utf8',
      env: {
        APPDATA: 'C:\\Users\\Alex\\AppData\\Roaming',
        Path: 'C:\\Tools',
        PATHEXT: '.CMD',
        USERPROFILE: 'C:\\Users\\Alex',
      },
    },
  });
  assert.equal(spawnCalls[1].command, 'cmd.exe');
  assert.deepEqual(spawnCalls[1].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(spawnCalls[1].args[3], /^"C:\\Tools\\claude\.CMD" "\/schedule daily at 09:00 /);
  assert.deepEqual(spawnCalls[1].options, {
    encoding: 'utf8',
    env: {
      APPDATA: 'C:\\Users\\Alex\\AppData\\Roaming',
      Path: 'C:\\Tools',
      PATHEXT: '.CMD',
      USERPROFILE: 'C:\\Users\\Alex',
    },
    stdio: 'inherit',
  });
  assert.equal(fs.writeCalls.length, 1);
  assert.equal(fs.renameCalls.length, 1);
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
  assert.equal(fs.writeCalls.length, 0);
  assert.equal(fs.renameCalls.length, 0);
});

test('setup Codex with yes prints fallback without recording metadata', async () => {
  const fs = createMemoryFs({
    '/bin/codex': '',
    '/home/alex/.codex': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/codex': '0.46.0' });

  const exitCode = await runCli(['setup', '--provider', 'codex', '--time', '09:00', '--yes'], {
    env: { HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 1);
  assert.match(io.stdout, /Open a Codex thread/);
  assert.match(io.stdout, /Codex automation was not created by this CLI/);
  assert.equal(fs.writeCalls.length, 0);
  assert.equal(fs.renameCalls.length, 0);
});

test('setup Codex with injected native creator writes metadata', async () => {
  const fs = createMemoryFs({
    '/bin/codex': '',
    '/home/alex/.codex': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/codex': '0.46.0' });
  const createCalls = [];

  const exitCode = await runCli(['setup', '--provider', 'codex', '--time', '09:00', '--yes'], {
    codexAutomationCreate(request) {
      createCalls.push(request);
      assert.equal(fs.writeCalls.length, 0);
      return { id: 'automation_123' };
    },
    env: { HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(createCalls, [
    {
      name: 'Harness Reset Warmup',
      schedule: 'daily at 09:00',
      prompt:
        'Reply with exactly: ok\nDo not inspect files, do not run commands, do not modify anything, and do not use connectors or tools.',
    },
  ]);
  assert.equal(fs.writeCalls.length, 1);
  assert.equal(fs.renameCalls.length, 1);
  assert.match(fs.writeCalls[0].contents, /"automationName": "Harness Reset Warmup"/);
});

test('status prints provider availability and current config JSON from injected config path', async () => {
  const configPath = '/tmp/harness-reset/config.json';
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
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
    env: { HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    spawnSync: createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' }).spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /claude: installed \(2\.1\.104 \(Claude Code\)\); local state found/);
  assert.match(io.stdout, /codex: missing; local state missing/);
  assert.match(io.stdout, /Metadata:/);
  assert.deepEqual(metadataFromStatus(io.stdout), {
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

test('update dry-run for Claude routes through setup behavior', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli(
    ['update', '--provider', 'claude', '--time', '09:00', '--dry-run'],
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
  assert.match(io.stdout, /Native action: claude "\/schedule daily at 09:00/);
});

test('remove deletes local provider metadata and prints native removal instructions', async () => {
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
        codex: {
          enabled: true,
          automationName: 'Harness Reset Warmup',
          schedule: 'daily at 10:00',
          promptHash: 'sha256:codex',
        },
      },
    }),
  });
  const io = createIo();

  const exitCode = await runCli(['remove', '--provider', 'claude'], {
    env: { HOME: '/home/alex', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Removed local metadata for claude/);
  assert.match(io.stdout, /Native Claude routine was not deleted/);
  assert.match(io.stdout, /\/schedule list/);

  const writtenConfig = JSON.parse(fs.writeCalls[0].contents);
  assert.equal(writtenConfig.providers.claude, undefined);
  assert.deepEqual(writtenConfig.providers.codex, {
    enabled: true,
    automationName: 'Harness Reset Warmup',
    schedule: 'daily at 10:00',
    promptHash: 'sha256:codex',
  });
});

test('Claude schedule failure reports likely documented causes', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();
  const spawnCalls = [];

  const exitCode = await runCli(['setup', '--provider', 'claude', '--time', '09:00', '--yes'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync(command, args, options) {
      spawnCalls.push({ command, args, options });

      if (args.length === 1 && args[0] === '--version') {
        return { status: 0, stdout: '2.1.104 (Claude Code)\n' };
      }

      return { status: 7, stdout: '', stderr: 'routine denied\n' };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(fs.writeCalls.length, 0);
  assert.match(io.stderr, /exit code 7/);
  assert.match(io.stderr, /API-key\/cloud-provider auth/);
  assert.match(io.stderr, /older Claude Code CLI/);
  assert.match(io.stderr, /org policy disabling routines/);
});

test('lead minutes rejects partial integer values', async () => {
  const io = createIo();

  const exitCode = await runCli(['plan', '--provider', 'claude', '--lead-minutes', '1abc'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs: createMemoryFs(),
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /Invalid --lead-minutes/);
  assert.match(io.stderr, /0\.\.1440/);
});

test('lead minutes rejects negative values', async () => {
  const io = createIo();

  const exitCode = await runCli(['plan', '--provider', 'claude', '--lead-minutes', '-40'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs: createMemoryFs(),
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /Invalid --lead-minutes/);
  assert.match(io.stderr, /0\.\.1440/);
});

test('runCli prints usage when invoked with no args', async () => {
  const io = createIo();

  const exitCode = await runCli([], { io });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /^Usage: harness-reset/);
  assert.match(io.stdout, /update/);
  assert.match(io.stdout, /remove/);
});
