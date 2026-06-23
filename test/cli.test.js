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
    rmSync(filePath, options) {
      assert.deepEqual(options, { recursive: true, force: true });
      for (const key of [...files.keys()]) {
        if (key === filePath || key.startsWith(`${filePath}/`)) {
          files.delete(key);
        }
      }
    },
    readdirSync() {
      return [];
    },
  };
}

function createDashboardFs({ claudeLimitHitAt = '2026-06-10T17:22:00.000Z' } = {}) {
  const files = new Map([
    ['/bin/claude', ''],
    ['/home/alex/.claude', ''],
    [
      '/home/alex/.claude/session.jsonl',
      [
        `{"timestamp":"${claudeLimitHitAt}","message":"Usage limit reached. Please try again later."}`,
        '{"timestamp":"2026-06-09T17:22:00","message":"Usage limit reached. Please try again later."}',
        '{"timestamp":"2026-06-10T17:22:00","message":"Usage limit reached. Please try again later."}',
        '{"timestamp":"2026-06-11T17:22:00","message":"Usage limit reached. Please try again later."}',
        '{"timestamp":"2026-06-12T17:22:00","message":"Usage limit reached. Please try again later."}',
        '{"timestamp":"2026-06-13T17:22:00","message":"Usage limit reached. Please try again later."}',
      ].join('\n'),
    ],
  ]);

  return {
    existsSync(filePath) {
      return files.has(filePath);
    },
    readFileSync(filePath, encoding) {
      assert.equal(encoding, 'utf8');
      return files.get(filePath);
    },
    readdirSync(filePath, options) {
      assert.deepEqual(options, { withFileTypes: true });

      if (filePath === '/home/alex/.claude') {
        return [
          {
            name: 'session.jsonl',
            isDirectory: () => false,
            isFile: () => true,
          },
        ];
      }

      return [];
    },
    statSync(filePath) {
      if (!files.has(filePath)) {
        throw new Error(`missing file: ${filePath}`);
      }

      return { mtime: new Date('2026-06-13T17:22:00') };
    },
  };
}

function createSetupHistoryFs({ binaryPath, stateDir, sessionContents }) {
  const fs = createMemoryFs({
    [binaryPath]: '',
    [stateDir]: '',
    [`${stateDir}/session.jsonl`]: sessionContents,
  });

  fs.readdirSync = (filePath, options) => {
    assert.deepEqual(options, { withFileTypes: true });

    if (filePath === stateDir) {
      return [
        {
          name: 'session.jsonl',
          isDirectory: () => false,
          isFile: () => true,
        },
      ];
    }

    return [];
  };
  fs.statSync = (filePath) => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`missing file: ${filePath}`);
    }

    return { mtime: new Date('2026-06-13T17:22:00') };
  };

  return fs;
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

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
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

test('interactive suggestions render as readable provider blocks after suggestion loading state', async () => {
  const io = createInteractiveIo();
  const spawn = createSpawn({ '/bin/claude': '2.1.104 (Claude Code)' });

  const exitCode = await runCli([], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs: createDashboardFs(),
    io,
    platform: 'linux',
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  const output = stripAnsi(io.stdout);
  assert.match(output, /Building warmup suggestions/);
  assert.match(output, /Suggestions/);
  assert.match(output, /Claude Code\n\s+Warmup\s+daily at 12:32/);
  assert.match(output, /Limit hit\s+17:22/);
  assert.match(output, /Target reset\s+17:32/);
  assert.match(output, /Run\s+agent-warmup setup --provider claude/);
  assert.doesNotMatch(output, /Claude Code daily at 12:32 17:22 -> 17:32 -> 12:32/);
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

test('default command verifies recorded Codex native automation file', async () => {
  const configPath = '/tmp/agent-warmup/config.json';
  const fs = createMemoryFs({
    '/state/codex/automations/agent-warmup/automation.toml': 'id = "agent-warmup"\n',
    [configPath]: JSON.stringify({
      version: 1,
      providers: {
        codex: {
          enabled: true,
          automationName: 'Agent Warmup',
          schedule: 'daily at 18:45',
          promptHash: 'sha256:codex',
        },
      },
    }),
  });
  const io = createIo();

  const exitCode = await runCli([], {
    env: { CODEX_HOME: '/state/codex', HOME: '/home/alex', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /codex: Agent Warmup, daily at 18:45/);
  assert.match(io.stdout, /native file found/);
  assert.doesNotMatch(io.stdout, /native status not verified/);
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
  assert.match(io.stdout, /claude "-p" "--model" "fable" "--effort" "low" "--output-format" "json" "\/schedule daily at 09:00/);
  assert.deepEqual(
    spawn.calls.map((call) => [call.command, call.args]),
    [['/bin/claude', ['--version']]],
  );
});

test('setup creates Claude routine through non-interactive print mode', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo('no');
  const spawnCalls = [];
  const spawnSync = (command, args, options) => {
    spawnCalls.push({ command, args, options });

    if (args.length === 1 && args[0] === '--version') {
      return { status: 0, stdout: '2.1.104 (Claude Code)\n' };
    }

    return {
      status: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result:
          'Routine created successfully. Routine ID: trig_123. URL: https://claude.ai/code/routines/trig_123',
      }),
    };
  };

  const exitCode = await runCli(['setup', '--provider', 'claude', '--time', '09:00'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(io.stdout, /Type "create" to continue/);
  assert.doesNotMatch(io.stdout, /Aborted/);
  assert.match(io.stdout, /Created Claude Code Routine/);
  assert.match(io.stdout, /https:\/\/claude\.ai\/code\/routines\/trig_123/);
  assert.deepEqual(
    spawnCalls.map((call) => [call.command, call.args, call.options]),
    [
      [
        '/bin/claude',
        ['--version'],
        {
          encoding: 'utf8',
          env: { HOME: '/home/alex', PATH: '/bin' },
        },
      ],
      [
        '/bin/claude',
        [
          '-p',
          '--model',
          'fable',
          '--effort',
          'low',
          '--output-format',
          'json',
          '/schedule daily at 09:00 Reply with exactly: ok Do not inspect files, do not run commands, do not modify anything, and do not use connectors or tools.',
        ],
        {
          encoding: 'utf8',
          env: { HOME: '/home/alex', PATH: '/bin' },
        },
      ],
    ],
  );
});

test('setup creates a Claude routine for each inferred warmup schedule', async () => {
  const fs = createSetupHistoryFs({
    binaryPath: '/bin/claude',
    stateDir: '/home/alex/.claude',
    sessionContents: [
      '{"timestamp":"2026-06-08T11:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-08T15:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-09T10:45:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-09T14:45:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-10T11:15:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-10T15:15:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-11T11:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-11T15:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-12T11:05:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-12T15:05:00","message":"Usage limit reached. Please try again later."}',
    ].join('\n'),
  });
  const io = createIo();
  const spawnCalls = [];
  const spawnSync = (command, args, options) => {
    spawnCalls.push({ command, args, options });

    if (args.length === 1 && args[0] === '--version') {
      return { status: 0, stdout: '2.1.104 (Claude Code)\n' };
    }

    return {
      status: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result:
          'Routine created successfully. Routine ID: trig_multi. URL: https://claude.ai/code/routines/trig_multi',
      }),
    };
  };

  const exitCode = await runCli(['setup', '--provider', 'claude'], {
    env: { HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    spawnSync,
  });

  assert.equal(exitCode, 0);
  const routineCalls = spawnCalls.filter((call) => call.args.includes('-p'));
  assert.equal(routineCalls.length, 2);
  assert.match(routineCalls[0].args.at(-1), /^\/schedule daily at 06:10 /);
  assert.match(routineCalls[1].args.at(-1), /^\/schedule daily at 11:11 /);
  assert.match(fs.writeCalls.at(-1).contents, /"schedules": \[\n\s+"daily at 06:10",\n\s+"daily at 11:11"\n\s+\]/);
});

test('setup does not record Claude metadata when print mode exits without creating a routine', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();

  const exitCode = await runCli(['setup', '--provider', 'claude', '--time', '09:00'], {
    env: { HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync(command, args) {
      if (args.length === 1 && args[0] === '--version') {
        return { status: 0, stdout: '2.1.104 (Claude Code)\n' };
      }

      return {
        status: 0,
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'What would you like to do with scheduled cloud agents?',
        }),
      };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(fs.writeCalls.length, 0);
  assert.match(io.stderr, /did not confirm routine creation/);
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
    return {
      status: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result:
          'Routine created successfully. Routine ID: trig_win. URL: https://claude.ai/code/routines/trig_win',
      }),
    };
  };

  const exitCode = await runCli(['setup', '--provider', 'claude', '--time', '09:00'], {
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
  assert.match(spawnCalls[1].args[3], /^"C:\\Tools\\claude\.CMD" "-p" "--model" "fable" "--effort" "low" "--output-format" "json" "\/schedule daily at 09:00 /);
  assert.deepEqual(spawnCalls[1].options, {
    encoding: 'utf8',
    env: {
      APPDATA: 'C:\\Users\\Alex\\AppData\\Roaming',
      Path: 'C:\\Tools',
      PATHEXT: '.CMD',
      USERPROFILE: 'C:\\Users\\Alex',
    },
  });
  assert.equal(fs.writeCalls.length, 1);
  assert.equal(fs.renameCalls.length, 1);
});

test('setup dry-run for Codex previews native automation file creation', async () => {
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
  assert.match(io.stdout, /DRY RUN/);
  assert.match(io.stdout, /Create native Codex Automation/);
  assert.match(io.stdout, /automation\.toml/);
  assert.match(io.stdout, /Agent Warmup/);
  assert.doesNotMatch(io.stdout, /Open a Codex thread/);
  assert.equal(fs.writeCalls.length, 0);
  assert.equal(fs.renameCalls.length, 0);
});

test('setup Codex creates a native automation file without agent-warmup confirmation', async () => {
  const fs = createMemoryFs({
    '/bin/codex': '',
    '/home/alex/.codex': '',
  });
  const io = createIo('no');
  const spawn = createSpawn({ '/bin/codex': '0.46.0' });

  const exitCode = await runCli(['setup', '--provider', 'codex', '--time', '09:00'], {
    cwd: '/work/project',
    env: { CODEX_HOME: '/state/codex', HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    now: () => 1781379056290,
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(io.stdout, /Open a Codex thread/);
  assert.doesNotMatch(io.stdout, /Type "create" to continue/);
  assert.doesNotMatch(io.stdout, /Aborted/);
  assert.match(io.stdout, /Native file: \/state\/codex\/automations\/agent-warmup\/automation\.toml/);
  assert.match(io.stdout, /Workspace: \/work\/project/);
  assert.equal(fs.writeCalls.length, 2);
  assert.equal(fs.renameCalls.length, 2);
  assert.match(fs.writeCalls[0].filePath, /\/state\/codex\/automations\/agent-warmup\/\.automation\.toml\./);
  assert.match(fs.writeCalls[0].contents, /id = "agent-warmup"/);
  assert.match(fs.writeCalls[0].contents, /name = "Agent Warmup"/);
  assert.match(fs.writeCalls[0].contents, /status = "ACTIVE"/);
  assert.match(fs.writeCalls[0].contents, /model = "gpt-5\.3-codex-spark"/);
  assert.match(fs.writeCalls[0].contents, /reasoning_effort = "minimal"/);
  assert.match(
    fs.writeCalls[0].contents,
    /rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=9;BYMINUTE=0"/,
  );
  assert.match(fs.writeCalls[0].contents, /execution_environment = "local"/);
  assert.match(fs.writeCalls[0].contents, /cwds = \["\/work\/project"\]/);
  assert.match(fs.writeCalls[1].contents, /"automationName": "Agent Warmup"/);
});

test('setup Codex writes separate native automation files for inferred warmup schedules', async () => {
  const fs = createSetupHistoryFs({
    binaryPath: '/bin/codex',
    stateDir: '/home/alex/.codex',
    sessionContents: [
      '{"timestamp":"2026-06-08T11:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-08T15:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-09T10:45:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-09T14:45:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-10T11:15:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-10T15:15:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-11T11:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-11T15:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-12T11:05:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-12T15:05:00","message":"Usage limit reached. Please try again later."}',
    ].join('\n'),
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/codex': '0.46.0' });

  const exitCode = await runCli(['setup', '--provider', 'codex'], {
    cwd: '/work/project',
    env: { CODEX_HOME: '/state/codex', HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    now: () => 1781379056290,
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Created Codex Automation: agent-warmup\n/);
  assert.match(io.stdout, /Created Codex Automation: agent-warmup-2\n/);
  assert.match(fs.writeCalls[0].filePath, /\/state\/codex\/automations\/agent-warmup\/\.automation\.toml\./);
  assert.match(fs.writeCalls[0].contents, /id = "agent-warmup"/);
  assert.match(fs.writeCalls[0].contents, /rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=6;BYMINUTE=10"/);
  assert.match(fs.writeCalls[1].filePath, /\/state\/codex\/automations\/agent-warmup-2\/\.automation\.toml\./);
  assert.match(fs.writeCalls[1].contents, /id = "agent-warmup-2"/);
  assert.match(fs.writeCalls[1].contents, /rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=11;BYMINUTE=11"/);
  assert.match(fs.writeCalls[2].contents, /"schedules": \[\n\s+"daily at 06:10",\n\s+"daily at 11:11"\n\s+\]/);
});

test('setup Codex uses one native automation when inferred warmup schedules share a minute', async () => {
  const fs = createSetupHistoryFs({
    binaryPath: '/bin/codex',
    stateDir: '/home/alex/.codex',
    sessionContents: [
      '{"timestamp":"2026-06-08T11:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-08T19:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-09T10:45:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-09T18:45:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-10T11:15:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-10T19:15:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-11T11:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-11T19:00:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-12T11:05:00","message":"Usage limit reached. Please try again later."}',
      '{"timestamp":"2026-06-12T19:05:00","message":"Usage limit reached. Please try again later."}',
    ].join('\n'),
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/codex': '0.46.0' });

  const exitCode = await runCli(['setup', '--provider', 'codex'], {
    cwd: '/work/project',
    env: { CODEX_HOME: '/state/codex', HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    now: () => 1781379056290,
    spawnSync: spawn.spawnSync,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Created Codex Automation: agent-warmup\n/);
  assert.doesNotMatch(io.stdout, /agent-warmup-2/);
  assert.equal(fs.writeCalls.length, 2);
  assert.match(fs.writeCalls[0].filePath, /\/state\/codex\/automations\/agent-warmup\/\.automation\.toml\./);
  assert.match(fs.writeCalls[0].contents, /id = "agent-warmup"/);
  assert.match(fs.writeCalls[0].contents, /rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=6,14;BYMINUTE=10"/);
  assert.match(fs.writeCalls[1].contents, /"schedules": \[\n\s+"daily at 06:10",\n\s+"daily at 14:10"\n\s+\]/);
});

test('setup creates Codex automation before launching Claude interactive scheduler', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/bin/codex': '',
    '/home/alex/.claude': '',
    '/home/alex/.codex': '',
  });
  const io = createIo();
  const events = [];
  const originalWriteFileSync = fs.writeFileSync.bind(fs);

  fs.writeFileSync = (filePath, contents, encoding) => {
    if (filePath.includes('/automations/agent-warmup/')) {
      events.push('codex-automation-file');
    }

    originalWriteFileSync(filePath, contents, encoding);
  };

  const exitCode = await runCli(['setup', '--time', '09:00'], {
    cwd: '/work/project',
    env: { CODEX_HOME: '/state/codex', HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    spawnSync(command, args) {
      if (args.length === 1 && args[0] === '--version') {
        return { status: 0, stdout: `${command} 1.0.0\n` };
      }

      if (command === '/bin/claude' && args.includes('-p')) {
        events.push('claude-schedule');
      }

      return {
        status: 0,
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result:
            'Routine created successfully. Routine ID: trig_order. URL: https://claude.ai/code/routines/trig_order',
        }),
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['codex-automation-file', 'claude-schedule']);
});

test('setup refuses to overwrite recorded warmups before creating anything', async () => {
  const configPath = '/tmp/agent-warmup/config.json';
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/bin/codex': '',
    '/home/alex/.claude': '',
    '/home/alex/.codex': '',
    [configPath]: JSON.stringify({
      version: 1,
      providers: {
        codex: {
          enabled: true,
          automationName: 'Agent Warmup',
          schedule: 'daily at 18:45',
          promptHash: 'sha256:codex',
        },
      },
    }),
  });
  const io = createIo();
  const spawnCalls = [];

  const exitCode = await runCli(['setup', '--time', '09:00'], {
    env: { HOME: '/home/alex', PATH: '/bin', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
    spawnSync(...args) {
      spawnCalls.push(args);
      return { status: 0, stdout: '' };
    },
  });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /codex: existing agent-warmup setup found/);
  assert.match(io.stderr, /agent-warmup remove --provider codex/);
  assert.deepEqual(spawnCalls, []);
  assert.equal(fs.writeCalls.length, 0);
});

test('setup refuses to overwrite native Codex automation even without local metadata', async () => {
  const fs = createMemoryFs({
    '/bin/codex': '',
    '/home/alex/.codex': '',
    '/state/codex/automations/agent-warmup/automation.toml': 'id = "agent-warmup"\n',
  });
  const io = createIo();
  const spawnCalls = [];

  const exitCode = await runCli(['setup', '--provider', 'codex', '--time', '09:00'], {
    env: { CODEX_HOME: '/state/codex', HOME: '/home/alex', PATH: '/bin' },
    fs,
    io,
    platform: 'linux',
    spawnSync(...args) {
      spawnCalls.push(args);
      return { status: 0, stdout: '' };
    },
  });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /codex: existing agent-warmup setup found/);
  assert.deepEqual(spawnCalls, []);
  assert.equal(fs.writeCalls.length, 0);
});

test('setup Codex with injected native creator writes metadata', async () => {
  const fs = createMemoryFs({
    '/bin/codex': '',
    '/home/alex/.codex': '',
  });
  const io = createIo();
  const spawn = createSpawn({ '/bin/codex': '0.46.0' });
  const createCalls = [];

  const exitCode = await runCli(['setup', '--provider', 'codex', '--time', '09:00'], {
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
    '/home/alex/.codex/automations/agent-warmup/automation.toml': 'id = "agent-warmup"\n',
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

test('remove deletes native Codex automation file created by setup', async () => {
  const configPath = '/tmp/agent-warmup/config.json';
  const fs = createMemoryFs({
    '/state/codex/automations/agent-warmup/automation.toml': 'id = "agent-warmup"\n',
    [configPath]: JSON.stringify({
      version: 1,
      providers: {
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

  const exitCode = await runCli(['remove', '--provider', 'codex'], {
    env: { CODEX_HOME: '/state/codex', HOME: '/home/alex', XDG_CONFIG_HOME: '/tmp' },
    fs,
    io,
    platform: 'linux',
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Removed local metadata for codex/);
  assert.match(io.stdout, /Removed native Codex Automation/);
  assert.deepEqual(fs.writeCalls.length, 1);
});

test('Claude schedule failure reports likely documented causes', async () => {
  const fs = createMemoryFs({
    '/bin/claude': '',
    '/home/alex/.claude': '',
  });
  const io = createIo();
  const spawnCalls = [];

  const exitCode = await runCli(['setup', '--provider', 'claude', '--time', '09:00'], {
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
