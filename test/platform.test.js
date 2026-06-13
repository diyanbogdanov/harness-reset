import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  configFilePath,
  findExecutable,
  providerStateDir,
} from '../src/platform.js';

test('findExecutable locates a Unix executable on PATH', () => {
  const fakeFs = {
    existsSync(candidate) {
      return candidate === path.posix.normalize('/usr/local/bin/claude');
    },
  };

  const result = findExecutable('claude', {
    env: { PATH: '/usr/bin:/usr/local/bin' },
    fs: fakeFs,
    platform: 'linux',
  });

  assert.equal(result, path.posix.normalize('/usr/local/bin/claude'));
});

test('findExecutable locates a Windows executable through PATHEXT', () => {
  const expectedPath = path.win32.normalize('C:\\Tools\\codex.CMD');
  const fakeFs = {
    existsSync(candidate) {
      return candidate === expectedPath;
    },
  };

  const result = findExecutable('codex', {
    env: {
      PATH: 'C:\\Windows;C:\\Tools',
      PATHEXT: '.EXE;.CMD',
    },
    fs: fakeFs,
    platform: 'win32',
  });

  assert.equal(result, expectedPath);
});

test('findExecutable reads Windows Path case-insensitively', () => {
  const expectedPath = path.win32.normalize('C:\\Tools\\codex.CMD');
  const fakeFs = {
    existsSync(candidate) {
      return candidate === expectedPath;
    },
  };

  const result = findExecutable('codex', {
    env: {
      Path: 'C:\\Tools',
      PATHEXT: '.CMD',
    },
    fs: fakeFs,
    platform: 'win32',
  });

  assert.equal(result, expectedPath);
});

test('findExecutable treats empty Windows PATHEXT as missing', () => {
  const expectedPath = path.win32.normalize('C:\\Tools\\codex.CMD');
  const fakeFs = {
    existsSync(candidate) {
      return candidate === expectedPath;
    },
  };

  const result = findExecutable('codex', {
    env: {
      PATH: 'C:\\Tools',
      PATHEXT: '',
    },
    fs: fakeFs,
    platform: 'win32',
  });

  assert.equal(result, expectedPath);
});

test('providerStateDir returns provider-specific state directories', () => {
  assert.equal(
    providerStateDir('claude', {
      env: { HOME: '/Users/alex' },
      platform: 'darwin',
    }),
    path.posix.normalize('/Users/alex/.claude'),
  );

  assert.equal(
    providerStateDir('codex', {
      env: { USERPROFILE: 'C:\\Users\\Alex' },
      platform: 'win32',
    }),
    path.win32.normalize('C:\\Users\\Alex\\.codex'),
  );
});

test('providerStateDir treats empty HOME as missing', () => {
  const result = providerStateDir('claude', {
    env: { HOME: '' },
    platform: 'linux',
  });

  assert.equal(path.posix.isAbsolute(result), true);
  assert.equal(result.endsWith('/.claude'), true);
});

test('configFilePath returns the platform-specific config path', () => {
  assert.equal(
    configFilePath({
      env: { XDG_CONFIG_HOME: '/tmp/config' },
      platform: 'linux',
    }),
    path.posix.normalize('/tmp/config/agent-warmup/config.json'),
  );

  assert.equal(
    configFilePath({
      env: { APPDATA: 'C:\\Users\\Alex\\AppData\\Roaming' },
      platform: 'win32',
    }),
    path.win32.normalize('C:\\Users\\Alex\\AppData\\Roaming\\agent-warmup\\config.json'),
  );
});

test('configFilePath treats empty XDG_CONFIG_HOME as missing', () => {
  assert.equal(
    configFilePath({
      env: {
        HOME: '/Users/alex',
        XDG_CONFIG_HOME: '',
      },
      platform: 'linux',
    }),
    path.posix.normalize('/Users/alex/.config/agent-warmup/config.json'),
  );
});
