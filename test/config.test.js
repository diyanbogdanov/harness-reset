import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildProviderMetadata,
  hashPrompt,
  readConfig,
  writeConfig,
} from '../src/config.js';

function createMemoryFs(files = {}) {
  const state = {
    files: new Map(Object.entries(files)),
    mkdirCalls: [],
    renameCalls: [],
    writeCalls: [],
  };

  return {
    state,
    existsSync(filePath) {
      return state.files.has(filePath);
    },
    readFileSync(filePath, encoding) {
      assert.equal(encoding, 'utf8');
      return state.files.get(filePath);
    },
    mkdirSync(dirPath, options) {
      state.mkdirCalls.push({ dirPath, options });
    },
    writeFileSync(filePath, contents, encoding) {
      state.writeCalls.push({ filePath, contents, encoding });
      state.files.set(filePath, contents);
    },
    renameSync(oldPath, newPath) {
      state.renameCalls.push({ oldPath, newPath });
      state.files.set(newPath, state.files.get(oldPath));
      state.files.delete(oldPath);
    },
  };
}

test('hashPrompt returns the sha256 digest with the expected prefix', () => {
  assert.equal(
    hashPrompt('hello'),
    'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

test('readConfig returns the default config when the file is missing', () => {
  const fs = createMemoryFs();

  assert.deepEqual(readConfig('/tmp/agent-warmup/config.json', { fs }), {
    version: 1,
    providers: {},
  });
});

test('readConfig keeps only supported provider metadata fields', () => {
  const fs = createMemoryFs({
    '/tmp/agent-warmup/config.json': JSON.stringify({
      version: 1,
      providers: {
        claude: {
          enabled: true,
          routineName: 'Agent Warmup',
          schedule: 'daily at 08:30',
          promptHash: 'sha256:abc',
          apiKey: 'secret',
        },
        unknown: { token: 'secret' },
      },
    }),
  });

  assert.deepEqual(readConfig('/tmp/agent-warmup/config.json', { fs }), {
    version: 1,
    providers: {
      claude: {
        enabled: true,
        routineName: 'Agent Warmup',
        schedule: 'daily at 08:30',
        promptHash: 'sha256:abc',
      },
    },
  });
});

test('writeConfig creates the parent directory and writes pretty JSON with a trailing newline', () => {
  const fs = createMemoryFs();
  const config = {
    version: 1,
    providers: {
      claude: { enabled: true },
    },
  };

  writeConfig('/tmp/agent-warmup/config.json', config, { fs });

  assert.deepEqual(fs.state.mkdirCalls, [
    { dirPath: '/tmp/agent-warmup', options: { recursive: true } },
  ]);
  assert.equal(fs.state.writeCalls.length, 1);
  assert.equal(fs.state.writeCalls[0].contents, `${JSON.stringify(config, null, 2)}\n`);
  assert.equal(fs.state.writeCalls[0].encoding, 'utf8');
});

test('writeConfig writes to a same-directory temp file before renaming into place', () => {
  const fs = createMemoryFs();
  const config = { version: 1, providers: {} };

  writeConfig('/tmp/agent-warmup/config.json', config, { fs });

  assert.equal(fs.state.writeCalls.length, 1);
  assert.equal(fs.state.renameCalls.length, 1);

  const tempPath = fs.state.writeCalls[0].filePath;
  assert.equal(tempPath.startsWith('/tmp/agent-warmup/.config.json.'), true);
  assert.equal(tempPath.endsWith('.tmp'), true);
  assert.deepEqual(fs.state.renameCalls, [
    {
      oldPath: tempPath,
      newPath: '/tmp/agent-warmup/config.json',
    },
  ]);
});

test('buildProviderMetadata returns Claude routine metadata', () => {
  assert.deepEqual(
    buildProviderMetadata('claude', {
      schedule: 'daily at 08:30',
      prompt: 'ok prompt',
    }),
    {
      enabled: true,
      routineName: 'Agent Warmup',
      schedule: 'daily at 08:30',
      promptHash: hashPrompt('ok prompt'),
    },
  );
});

test('buildProviderMetadata returns Codex automation metadata', () => {
  assert.deepEqual(
    buildProviderMetadata('codex', {
      schedule: 'daily at 08:30',
      prompt: 'ok prompt',
    }),
    {
      enabled: true,
      automationName: 'Agent Warmup',
      schedule: 'daily at 08:30',
      promptHash: hashPrompt('ok prompt'),
    },
  );
});

test('buildProviderMetadata stores multiple warmup schedules when present', () => {
  assert.deepEqual(
    buildProviderMetadata('codex', {
      schedule: 'daily at 06:10, daily at 11:11',
      schedules: ['daily at 06:10', 'daily at 11:11'],
      prompt: 'ok prompt',
    }),
    {
      enabled: true,
      automationName: 'Agent Warmup',
      schedule: 'daily at 06:10, daily at 11:11',
      schedules: ['daily at 06:10', 'daily at 11:11'],
      promptHash: hashPrompt('ok prompt'),
    },
  );
});
