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
    isTty: false,
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

function createInteractiveIo(input = '') {
  return {
    ...createIo(input),
    isTty: true,
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

test('default command shows suggestions when no agent-warmup setup is recorded', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli([], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Agent Warmup/);
  assert.match(io.stdout, /No agent-warmup routines are recorded yet/);
  assert.match(io.stdout, /claude: installed \(2\.1\.104 \(Claude Code\)\)/);
  assert.match(io.stdout, /claude: insufficient usage-limit hit history/);
  assert.match(io.stdout, /Run: agent-warmup setup --provider claude --time HH:MM/);
  assert.deepEqual(
    spawn.calls.map((call) => [call.command, call.args]),
    [['/bin/claude', ['--version']]],
  );
});

test('default command renders a polished interactive dashboard when stdout is a TTY', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createInteractiveIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli([], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /\u001b\[/);
  assert.match(io.stdout, /Agent Warmup/);
  assert.match(io.stdout, /Scanning local harness history/);
  assert.match(io.stdout, /Claude Code/);
  assert.match(io.stdout, /setup --provider claude --time HH:MM/);
});

test('plain flag disables terminal styling and animation output', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createInteractiveIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli(['--plain'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(io.stdout, /\u001b\[/);
  assert.doesNotMatch(io.stdout, /Scanning local harness history/);
  assert.match(io.stdout, /Agent Warmup/);
  assert.match(io.stdout, /claude: insufficient usage-limit hit history/);
});

test('default command shows routines recorded by agent-warmup', async () => {
  const configPath = '/tmp/agent-warmup/config.json';
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
    [configPath]: JSON.stringify({
      version: 1,
      providers: {
        claude: {
          enabled: true,
          routineName: 'Agent Warmup',
          schedule: 'daily at 09:00',
          promptHash: 'sha256:test',
        },
      },
    }),
  });
  const io = createIo();

  const exitCode = await runCli([], {
    env: { HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    spawnSync: createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' }).spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Configured routines\/automations:/);
  assert.match(io.stdout, /claude: Agent Warmup, daily at 09:00/);
  assert.match(io.stdout, /recorded by agent-warmup/);
  assert.doesNotMatch(io.stdout, /No agent-warmup routines are recorded yet/);
  assert.doesNotMatch(io.stdout, /Detected providers:/);
  assert.doesNotMatch(io.stdout, /Suggestions:/);
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
  assert.match(io.stdout, /Agent Warmup/);
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
      name: 'Agent Warmup',
      schedule: 'daily at 09:00',
      prompt:
        'Reply with exactly: ok\nDo not inspect files, do not run commands, do not modify anything, and do not use connectors or tools.',
    },
  ]);
  assert.equal(fs.writeCalls.length, 1);
  assert.equal(fs.renameCalls.length, 1);
  assert.match(fs.writeCalls[0].contents, /"automationName": "Agent Warmup"/);
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

test('setup without enough limit-hit history and no time asks for explicit time', async () => {
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
  assert.match(io.stdout, /insufficient usage-limit hit history/i);
  assert.match(io.stdout, /Re-run with --time HH:MM/);
});

test('remove deletes local provider metadata and prints native removal instructions', async () => {
  const configPath = '/tmp/agent-warmup/config.json';
  const fs = createMemoryFs({
    [configPath]: JSON.stringify({
      version: 1,
      providers: {
        claude: {
          enabled: true,
          routineName: 'Agent Warmup',
          schedule: 'daily at 09:00',
          promptHash: 'sha256:test',
        },
        codex: {
          enabled: true,
          automationName: 'Agent Warmup',
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
    automationName: 'Agent Warmup',
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

test('reset padding minutes rejects partial integer values', async () => {
  const io = createIo();

  const exitCode = await runCli(
    ['setup', '--provider', 'claude', '--reset-padding-minutes', '1abc'],
    {
      env: { HOME: '/home/alex', PATH: '/bin' },
      fs: createMemoryFs(),
      io,
      platform: 'linux',
    },
  );

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /Invalid --reset-padding-minutes/);
  assert.match(io.stderr, /0\.\.1440/);
});

test('window minutes rejects negative values', async () => {
  const io = createIo();

  const exitCode = await runCli(['setup', '--provider', 'claude', '--window-minutes', '-40'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs: createMemoryFs(),
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /Invalid --window-minutes/);
  assert.match(io.stderr, /0\.\.1440/);
});

test('removed commands return nonzero and point to the simplified command set', async () => {
  for (const command of ['detect', 'plan', 'status', 'update']) {
    const io = createIo();

    const exitCode = await runCli([command], { io });

    assert.equal(exitCode, 1);
    assert.match(io.stderr, new RegExp(`Unknown command: ${command}`));
    assert.match(io.stdout, /^Usage: agent-warmup \[setup\|remove\]/);
    assert.doesNotMatch(io.stdout, /detect|plan|status|update/);
  }
});

test('help prints the simplified command set', async () => {
  const io = createIo();

  const exitCode = await runCli(['--help'], { io });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /^Usage: agent-warmup \[setup\|remove\]/);
  assert.match(io.stdout, /remove/);
  assert.doesNotMatch(io.stdout, /detect|plan|status|update/);
});
