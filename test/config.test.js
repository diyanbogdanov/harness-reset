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

  assert.deepEqual(readConfig('/tmp/harness-reset/config.json', { fs }), {
    version: 1,
    providers: {},
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

  writeConfig('/tmp/harness-reset/config.json', config, { fs });

  assert.deepEqual(fs.state.mkdirCalls, [
    { dirPath: '/tmp/harness-reset', options: { recursive: true } },
  ]);
  assert.deepEqual(fs.state.writeCalls, [
    {
      filePath: '/tmp/harness-reset/config.json',
      contents: `${JSON.stringify(config, null, 2)}\n`,
      encoding: 'utf8',
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
      routineName: 'Harness Reset Warmup',
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
      automationName: 'Harness Reset Warmup',
      schedule: 'daily at 08:30',
      promptHash: hashPrompt('ok prompt'),
    },
  );
});
