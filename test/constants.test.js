import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONFIG_FILE_NAME,
  DEFAULT_LEAD_MINUTES,
  DEFAULT_PROMPT,
  PROVIDERS,
} from '../src/constants.js';

test('exports supported providers in deterministic order', () => {
  assert.deepEqual(PROVIDERS, ['claude', 'codex']);
});

test('exports the safe default prompt for low-cost warmup runs', () => {
  assert.match(DEFAULT_PROMPT, /Reply with exactly: ok/);
  assert.match(DEFAULT_PROMPT, /Do not inspect files/);
  assert.match(DEFAULT_PROMPT, /do not run commands/);
});

test('exports the default lead time in minutes', () => {
  assert.equal(DEFAULT_LEAD_MINUTES, 30);
});

test('exports the config file name used by the CLI', () => {
  assert.equal(CONFIG_FILE_NAME, 'config.json');
});
