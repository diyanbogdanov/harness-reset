import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONFIG_FILE_NAME,
  DEFAULT_LIMIT_WINDOW_MINUTES,
  DEFAULT_PROMPT,
  DEFAULT_RESET_PADDING_MINUTES,
  PROVIDERS,
} from '../src/constants.js';

test('exports supported providers in deterministic order', () => {
  assert.deepEqual(PROVIDERS, ['claude', 'codex']);
});

test('exports the safe default prompt for low-cost warmup runs', () => {
  assert.equal(
    DEFAULT_PROMPT,
    [
      'Reply with exactly: ok',
      'Do not inspect files, do not run commands, do not modify anything, and do not use connectors or tools.',
    ].join('\n'),
  );
});

test('exports the default limit window in minutes', () => {
  assert.equal(DEFAULT_LIMIT_WINDOW_MINUTES, 300);
});

test('exports the default reset padding in minutes', () => {
  assert.equal(DEFAULT_RESET_PADDING_MINUTES, 10);
});

test('exports the config file name used by the CLI', () => {
  assert.equal(CONFIG_FILE_NAME, 'config.json');
});
