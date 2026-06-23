import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { collectActivitySamples, collectLimitHitSamples } from '../src/history.js';
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
    readFileSync(filePath, encoding) {
      const node = nodes.get(filePath);

      if (typeof node?.contents === 'string') {
        assert.equal(encoding, 'utf8');
        readFileSyncCalls += 1;
        return node.contents;
      }

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

test('collectLimitHitSamples extracts timestamped usage-limit events without returning contents', () => {
  const rootDir = '/tmp/agent-warmup';
  const sessionsDir = path.join(rootDir, 'sessions');
  const now = new Date(2026, 5, 12, 12, 0);
  const fs = createMemoryFs([
    [rootDir, [{ name: 'sessions', type: 'dir' }, { name: 'skills', type: 'dir' }]],
    [
      sessionsDir,
      [
        { name: 'limit.jsonl', type: 'file' },
        { name: 'no-time.jsonl', type: 'file' },
        { name: 'discussion.jsonl', type: 'file' },
        { name: 'normal.jsonl', type: 'file' },
      ],
    ],
    [path.join(rootDir, 'skills'), [{ name: 'ignored.md', type: 'file' }]],
    [
      path.join(sessionsDir, 'limit.jsonl'),
      {
        contents:
          '{"timestamp":"2026-06-10T11:00:00.000Z","message":"Usage limit reached. Please try again later."}\n',
        mtime: new Date(2026, 5, 10, 11, 5),
      },
    ],
    [
      path.join(sessionsDir, 'no-time.jsonl'),
      {
        contents: '{"message":"Usage limit reached without timestamp should be ignored."}\n',
        mtime: new Date(2026, 5, 10, 12, 0),
      },
    ],
    [
      path.join(sessionsDir, 'discussion.jsonl'),
      {
        contents:
          '{"timestamp":"2026-06-10T13:00:00.000Z","message":"We discussed whether a message limit reached phrase should count."}\n',
        mtime: new Date(2026, 5, 10, 13, 0),
      },
    ],
    [
      path.join(sessionsDir, 'normal.jsonl'),
      {
        contents: '{"timestamp":"2026-06-10T09:00:00.000Z","message":"ordinary work"}\n',
        mtime: new Date(2026, 5, 10, 9, 0),
      },
    ],
    [
      path.join(rootDir, 'skills', 'ignored.md'),
      {
        contents: 'Usage limit reached in docs should not count.',
        mtime: new Date(2026, 5, 10, 8, 0),
      },
    ],
  ]);

  const samples = collectLimitHitSamples(rootDir, { fs, now, maxDays: 7 });

  assert.deepEqual(
    samples.map((sample) => [sample.getUTCFullYear(), sample.getUTCMonth(), sample.getUTCDate(), sample.getUTCHours(), sample.getUTCMinutes()]),
    [[2026, 5, 10, 11, 0]],
  );
  assert.equal(fs.readFileSyncCalls, 4);
});

test('inferWarmupTime recommends a warmup that makes the reset land after the usual limit hit', () => {
  const limitHitSamples = [
    new Date(2026, 5, 8, 11, 0),
    new Date(2026, 5, 9, 10, 45),
    new Date(2026, 5, 10, 11, 15),
    new Date(2026, 5, 11, 11, 0),
    new Date(2026, 5, 12, 11, 5),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 5,
    limitHit: '11:00',
    targetReset: '11:10',
    warmupTime: '06:10',
    schedule: 'daily at 06:10',
    schedules: ['daily at 06:10'],
    windows: [
      {
        evidenceDays: 5,
        limitHit: '11:00',
        targetReset: '11:10',
        warmupTime: '06:10',
        schedule: 'daily at 06:10',
      },
    ],
  });
});

test('inferWarmupTime recommends independent warmups for separate daily limit hits', () => {
  const limitHitSamples = [
    new Date(2026, 5, 8, 11, 0),
    new Date(2026, 5, 8, 19, 0),
    new Date(2026, 5, 9, 10, 45),
    new Date(2026, 5, 9, 18, 45),
    new Date(2026, 5, 10, 11, 15),
    new Date(2026, 5, 10, 19, 15),
    new Date(2026, 5, 11, 11, 0),
    new Date(2026, 5, 11, 19, 0),
    new Date(2026, 5, 12, 11, 5),
    new Date(2026, 5, 12, 19, 5),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 5,
    limitHit: '11:00',
    targetReset: '11:10',
    warmupTime: '06:10',
    schedule: 'daily at 06:10, daily at 14:10',
    schedules: ['daily at 06:10', 'daily at 14:10'],
    windows: [
      {
        evidenceDays: 5,
        limitHit: '11:00',
        targetReset: '11:10',
        warmupTime: '06:10',
        schedule: 'daily at 06:10',
      },
      {
        evidenceDays: 5,
        limitHit: '19:00',
        targetReset: '19:10',
        warmupTime: '14:10',
        schedule: 'daily at 14:10',
      },
    ],
  });
});

test('inferWarmupTime chains overlapping warmups one minute after the previous target reset', () => {
  const limitHitSamples = [
    new Date(2026, 5, 8, 11, 0),
    new Date(2026, 5, 8, 15, 0),
    new Date(2026, 5, 9, 10, 45),
    new Date(2026, 5, 9, 14, 45),
    new Date(2026, 5, 10, 11, 15),
    new Date(2026, 5, 10, 15, 15),
    new Date(2026, 5, 11, 11, 0),
    new Date(2026, 5, 11, 15, 0),
    new Date(2026, 5, 12, 11, 5),
    new Date(2026, 5, 12, 15, 5),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 5,
    limitHit: '11:00',
    targetReset: '11:10',
    warmupTime: '06:10',
    schedule: 'daily at 06:10, daily at 11:11',
    schedules: ['daily at 06:10', 'daily at 11:11'],
    windows: [
      {
        evidenceDays: 5,
        limitHit: '11:00',
        targetReset: '11:10',
        warmupTime: '06:10',
        schedule: 'daily at 06:10',
      },
      {
        evidenceDays: 5,
        limitHit: '15:00',
        targetReset: '16:11',
        warmupTime: '11:11',
        schedule: 'daily at 11:11',
      },
    ],
  });
});

test('inferWarmupTime ignores duplicate same-window limit markers before inferring extra warmups', () => {
  const limitHitSamples = [
    new Date(2026, 5, 8, 11, 0),
    new Date(2026, 5, 8, 11, 20),
    new Date(2026, 5, 9, 10, 45),
    new Date(2026, 5, 9, 11, 5),
    new Date(2026, 5, 10, 11, 15),
    new Date(2026, 5, 10, 11, 35),
    new Date(2026, 5, 11, 11, 0),
    new Date(2026, 5, 11, 11, 20),
    new Date(2026, 5, 12, 11, 5),
    new Date(2026, 5, 12, 11, 25),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 5,
    limitHit: '11:00',
    targetReset: '11:10',
    warmupTime: '06:10',
    schedule: 'daily at 06:10',
    schedules: ['daily at 06:10'],
    windows: [
      {
        evidenceDays: 5,
        limitHit: '11:00',
        targetReset: '11:10',
        warmupTime: '06:10',
        schedule: 'daily at 06:10',
      },
    ],
  });
});

test('inferWarmupTime ignores sparse secondary hits that overlap the primary daily window', () => {
  const limitHitSamples = [
    new Date(2026, 4, 29, 19, 10),
    new Date(2026, 5, 1, 0, 37),
    new Date(2026, 5, 2, 22, 32),
    new Date(2026, 5, 4, 1, 5),
    new Date(2026, 5, 4, 23, 6),
    new Date(2026, 5, 5, 0, 55),
    new Date(2026, 5, 6, 16, 18),
    new Date(2026, 5, 7, 4, 13),
    new Date(2026, 5, 13, 15, 17),
    new Date(2026, 5, 13, 22, 0),
    new Date(2026, 5, 13, 22, 28),
    new Date(2026, 5, 23, 13, 49),
    new Date(2026, 5, 23, 21, 44),
    new Date(2026, 5, 23, 22, 10),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 9,
    limitHit: '22:32',
    targetReset: '22:42',
    warmupTime: '17:42',
    schedule: 'daily at 17:42',
    schedules: ['daily at 17:42'],
    windows: [
      {
        evidenceDays: 9,
        limitHit: '22:32',
        targetReset: '22:42',
        warmupTime: '17:42',
        schedule: 'daily at 17:42',
      },
    ],
  });
});

test('inferWarmupTime wraps early-morning limit hits to the previous evening warmup', () => {
  const limitHitSamples = [
    new Date(2026, 5, 8, 1, 0),
    new Date(2026, 5, 9, 1, 0),
    new Date(2026, 5, 10, 1, 0),
    new Date(2026, 5, 11, 1, 0),
    new Date(2026, 5, 12, 1, 0),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 5,
    limitHit: '01:00',
    targetReset: '01:10',
    warmupTime: '20:10',
    schedule: 'daily at 20:10',
    schedules: ['daily at 20:10'],
    windows: [
      {
        evidenceDays: 5,
        limitHit: '01:00',
        targetReset: '01:10',
        warmupTime: '20:10',
        schedule: 'daily at 20:10',
      },
    ],
  });
});

test('inferWarmupTime wraps late-night target reset into the next day', () => {
  const limitHitSamples = [
    new Date(2026, 5, 8, 23, 50),
    new Date(2026, 5, 9, 23, 45),
    new Date(2026, 5, 10, 23, 40),
    new Date(2026, 5, 11, 23, 55),
    new Date(2026, 5, 12, 23, 50),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 5,
    limitHit: '23:50',
    targetReset: '00:00',
    warmupTime: '19:00',
    schedule: 'daily at 19:00',
    schedules: ['daily at 19:00'],
    windows: [
      {
        evidenceDays: 5,
        limitHit: '23:50',
        targetReset: '00:00',
        warmupTime: '19:00',
        schedule: 'daily at 19:00',
      },
    ],
  });
});

test('inferWarmupTime treats limit-hit clusters across midnight as one cluster', () => {
  const limitHitSamples = [
    new Date(2026, 5, 8, 23, 50),
    new Date(2026, 5, 9, 23, 55),
    new Date(2026, 5, 11, 0, 5),
    new Date(2026, 5, 12, 0, 10),
  ];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 4,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: 4,
    limitHit: '00:00',
    targetReset: '00:10',
    warmupTime: '19:10',
    schedule: 'daily at 19:10',
    schedules: ['daily at 19:10'],
    windows: [
      {
        evidenceDays: 4,
        limitHit: '00:00',
        targetReset: '00:10',
        warmupTime: '19:10',
        schedule: 'daily at 19:10',
      },
    ],
  });
});

test('inferWarmupTime refuses to invent a schedule without enough limit-hit evidence', () => {
  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples: [],
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'insufficient-limit-history',
    limitHitDays: 0,
    requiredDays: 5,
  });
});

test('inferWarmupTime reports insufficient limit-hit history before the minimum days', () => {
  const limitHitSamples = [new Date(2026, 5, 10, 9, 30), new Date(2026, 5, 11, 10, 0)];

  assert.deepEqual(inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: 5,
    resetPaddingMinutes: 10,
    windowMinutes: 300,
  }), {
    kind: 'insufficient-limit-history',
    limitHitDays: 2,
    requiredDays: 5,
  });
});
