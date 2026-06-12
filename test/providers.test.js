import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { detectProvider, detectProviders } from '../src/providers.js';

function fakeFsWith(paths) {
  const existingPaths = new Set(paths);

  return {
    existsSync(candidate) {
      return existingPaths.has(candidate);
    },
  };
}

test('detectProvider reports installed Claude with subscription auth warning', () => {
  const spawnCalls = [];
  const result = detectProvider('claude', {
    env: {
      ANTHROPIC_API_KEY: 'present',
      HOME: '/home/alex',
      PATH: '/bin',
    },
    fs: fakeFsWith(['/bin/claude', '/home/alex/.claude']),
    platform: 'linux',
    spawnSync(executable, args, options) {
      spawnCalls.push({ executable, args, options });
      return {
        status: 0,
        stdout: '2.1.104 (Claude Code)\n',
      };
    },
  });

  assert.deepEqual(spawnCalls, [
    {
      executable: '/bin/claude',
      args: ['--version'],
      options: {
        encoding: 'utf8',
        env: {
          ANTHROPIC_API_KEY: 'present',
          HOME: '/home/alex',
          PATH: '/bin',
        },
      },
    },
  ]);
  assert.equal(result.provider, 'claude');
  assert.equal(result.installed, true);
  assert.equal(result.version, '2.1.104 (Claude Code)');
  assert.equal(result.stateDirExists, true);
  assert.match(result.warnings[0], /ANTHROPIC_API_KEY/);
});

test('detectProvider reports missing Codex without spawning', () => {
  const spawnCalls = [];
  const result = detectProvider('codex', {
    env: {
      HOME: '/home/alex',
      PATH: '/bin',
    },
    fs: fakeFsWith([]),
    platform: 'linux',
    spawnSync(...args) {
      spawnCalls.push(args);
      return { status: 0, stdout: 'unused\n' };
    },
  });

  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(result, {
    provider: 'codex',
    executable: null,
    installed: false,
    version: null,
    stateDir: path.posix.normalize('/home/alex/.codex'),
    stateDirExists: false,
    warnings: [],
  });
});

test('detectProviders checks providers in deterministic order', () => {
  const results = detectProviders({
    env: {
      HOME: '/home/alex',
      PATH: '/bin',
    },
    fs: fakeFsWith([]),
    platform: 'linux',
    spawnSync() {
      throw new Error('missing providers should not spawn');
    },
  });

  assert.deepEqual(
    results.map((result) => result.provider),
    ['claude', 'codex'],
  );
});

test('detectProvider keeps installed true when version command fails', () => {
  const result = detectProvider('claude', {
    env: {
      HOME: '/home/alex',
      PATH: '/bin',
    },
    fs: fakeFsWith(['/bin/claude']),
    platform: 'linux',
    spawnSync() {
      return {
        status: 1,
        stdout: 'unexpected output\n',
      };
    },
  });

  assert.equal(result.installed, true);
  assert.equal(result.executable, '/bin/claude');
  assert.equal(result.version, null);
});

test('detectProvider warns when installed Codex sees API env vars', () => {
  const result = detectProvider('codex', {
    env: {
      CODEX_API_KEY: 'codex-key',
      HOME: '/home/alex',
      OPENAI_API_KEY: 'openai-key',
      PATH: '/bin',
    },
    fs: fakeFsWith(['/bin/codex']),
    platform: 'linux',
    spawnSync() {
      return {
        status: 0,
        stdout: '0.46.0\n',
      };
    },
  });

  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /CODEX_API_KEY/);
  assert.match(result.warnings[1], /OPENAI_API_KEY/);
});

test('detectProvider runs Windows cmd shims through cmd.exe for version detection', () => {
  const env = {
    Path: 'C:\\Tools',
    PATHEXT: '.CMD',
    USERPROFILE: 'C:\\Users\\Alex',
  };
  const executable = path.win32.normalize('C:\\Tools\\claude.CMD');
  const spawnCalls = [];
  const result = detectProvider('claude', {
    env,
    fs: fakeFsWith([executable]),
    platform: 'win32',
    spawnSync(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        status: 0,
        stdout: '2.1.104 (Claude Code)\r\n',
      };
    },
  });

  assert.deepEqual(spawnCalls, [
    {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${executable}" --version`],
      options: {
        encoding: 'utf8',
        env,
      },
    },
  ]);
  assert.equal(result.executable, executable);
  assert.equal(result.installed, true);
  assert.equal(result.version, '2.1.104 (Claude Code)');
});
