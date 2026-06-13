import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { collectActivitySamples } from '../src/history.js';
import { inferWarmupTime } from '../src/schedule.js';

function createDirent(name, directory) {
  return {
    name,
    isDirectory: () => directory,
    isFile: () => !directory,
  };
}

function createMemoryFs(entries) {
  const nodes = new Map(entries);
  let readFileSyncCalls = 0;

  return {
    get readFileSyncCalls() {
      return readFileSyncCalls;
    },
    existsSync(filePath) {
      return nodes.has(filePath);
    },
    readdirSync(dirPath, options) {
      assert.deepEqual(options, { withFileTypes: true });
      const children = nodes.get(dirPath);

      if (!Array.isArray(children)) {
        throw new Error(`Not a directory: ${dirPath}`);
      }

      return children.map((child) => createDirent(child.name, child.type === 'dir'));
    },
    statSync(filePath) {
      const node = nodes.get(filePath);

      if (!node || !node.mtime) {
        throw new Error(`No stat: ${filePath}`);
      }

      return { mtime: node.mtime };
    },
    readFileSync() {
      readFileSyncCalls += 1;
      throw new Error('collectActivitySamples must not read file contents');
    },
  };
}

test('collectActivitySamples returns an empty list when the root directory is missing', () => {
  const fs = createMemoryFs([]);

  assert.deepEqual(collectActivitySamples('/missing', { fs }), []);
});

test('collectActivitySamples collects bounded file mtimes without reading file contents', () => {
  const rootDir = '/tmp/agent-warmup';
  const sessionsDir = path.join(rootDir, 'state', 'sessions');
  const now = new Date(2026, 5, 12, 12, 0);
  const fs = createMemoryFs([
    [rootDir, [{ name: 'state', type: 'dir' }]],
    [path.join(rootDir, 'state'), [{ name: 'sessions', type: 'dir' }]],
    [
      sessionsDir,
      [
        { name: 'a.jsonl', type: 'file' },
        { name: 'b.jsonl', type: 'file' },
        { name: 'old.jsonl', type: 'file' },
        { name: 'future.jsonl', type: 'file' },
        { name: 'Cache', type: 'dir' },
      ],
    ],
    [path.join(sessionsDir, 'Cache'), [{ name: 'ignored.jsonl', type: 'file' }]],
    [path.join(sessionsDir, 'a.jsonl'), { mtime: new Date(2026, 5, 10, 9, 15) }],
    [path.join(sessionsDir, 'b.jsonl'), { mtime: new Date(2026, 5, 11, 9, 45) }],
    [path.join(sessionsDir, 'old.jsonl'), { mtime: new Date(2026, 4, 1, 8, 0) }],
    [path.join(sessionsDir, 'future.jsonl'), { mtime: new Date(2026, 5, 13, 8, 0) }],
    [path.join(sessionsDir, 'Cache', 'ignored.jsonl'), { mtime: new Date(2026, 5, 10, 7, 0) }],
  ]);

  const samples = collectActivitySamples(rootDir, { fs, now, maxDays: 7 });

  assert.deepEqual(
    samples.map((sample) => [sample.getHours(), sample.getMinutes()]),
    [
      [9, 15],
      [9, 45],
    ],
  );
  assert.equal(fs.readFileSyncCalls, 0);
});

test('inferWarmupTime recommends lead time before median first activity', () => {
  const samples = [
    new Date(2026, 5, 8, 10, 0),
    new Date(2026, 5, 9, 9, 15),
    new Date(2026, 5, 10, 9, 30),
    new Date(2026, 5, 11, 8, 45),
    new Date(2026, 5, 12, 9, 45),
    new Date(2026, 5, 12, 11, 0),
  ];

  assert.deepEqual(inferWarmupTime(samples, { leadMinutes: 30, minActiveDays: 5 }), {
    kind: 'suggested',
    activeDays: 5,
    firstActivity: '09:30',
    warmupTime: '09:00',
    schedule: 'daily at 09:00',
  });
});

test('inferWarmupTime clamps warmup time to the last minute of the day', () => {
  const samples = [
    new Date(2026, 5, 8, 23, 50),
    new Date(2026, 5, 9, 23, 45),
    new Date(2026, 5, 10, 23, 40),
    new Date(2026, 5, 11, 23, 55),
    new Date(2026, 5, 12, 23, 50),
  ];

  assert.deepEqual(inferWarmupTime(samples, { leadMinutes: -40, minActiveDays: 5 }), {
    kind: 'suggested',
    activeDays: 5,
    firstActivity: '23:50',
    warmupTime: '23:59',
    schedule: 'daily at 23:59',
  });
});

test('inferWarmupTime reports insufficient history before the minimum active days', () => {
  const samples = [new Date(2026, 5, 10, 9, 30), new Date(2026, 5, 11, 10, 0)];

  assert.deepEqual(inferWarmupTime(samples, { leadMinutes: 30, minActiveDays: 5 }), {
    kind: 'insufficient-history',
    activeDays: 2,
    requiredDays: 5,
  });
});
