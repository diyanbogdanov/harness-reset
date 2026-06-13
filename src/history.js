import nodeFs from 'node:fs';
import path from 'node:path';

const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  'Cache',
  'cache',
  'plugins',
  'skills',
  'shell-snapshots',
  'shell_snapshots',
  'worktrees',
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const LIMIT_MARKERS = [
  /(?:usage|rate)\s+limit\s+(?:reached|exceeded)/i,
  /(?:reached|exceeded)\s+(?:your\s+)?(?:usage|rate)\s+limit/i,
  /too many requests/i,
  /rate_limit_exceeded/i,
  /429\s+(?:too many requests|rate limit)/i,
  /limit will reset/i,
];

function lineHasLimitMarker(line) {
  return LIMIT_MARKERS.some((marker) => marker.test(line));
}

function timestampFromLine(line) {
  try {
    const parsed = JSON.parse(line);
    const value = parsed.timestamp || parsed.created_at || parsed.createdAt || parsed.time;
    const date = value ? new Date(value) : null;

    if (date && !Number.isNaN(date.getTime())) {
      return date;
    }
  } catch {
    // Fall back to regex extraction for non-JSON logs.
  }

  const match = /(?:timestamp|created_at|createdAt|time)["']?\s*[:=]\s*["']([^"']+)["']/i.exec(line);

  if (!match) {
    return null;
  }

  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shouldIncludeSample(date, cutoff, now) {
  return date >= cutoff && date <= now;
}

export function collectActivitySamples(
  rootDir,
  {
    fs = nodeFs,
    now = new Date(),
    maxDays = 30,
    maxEntries = 2000,
    maxDepth = 5,
  } = {},
) {
  const samples = [];
  const cutoff = new Date(now.getTime() - maxDays * DAY_MS);

  try {
    if (!fs.existsSync(rootDir)) {
      return [];
    }
  } catch {
    return [];
  }

  function visit(directory, depth) {
    if (samples.length >= maxEntries || depth > maxDepth) {
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (samples.length >= maxEntries || IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const { mtime } = fs.statSync(entryPath);

        if (shouldIncludeSample(mtime, cutoff, now)) {
          samples.push(new Date(mtime.getTime()));
        }
      } catch {
        continue;
      }
    }
  }

  visit(rootDir, 0);
  return samples.sort((a, b) => a.getTime() - b.getTime());
}

export function collectLimitHitSamples(
  rootDir,
  {
    fs = nodeFs,
    now = new Date(),
    maxDays = 30,
    maxEntries = 2000,
    maxDepth = 5,
  } = {},
) {
  const samples = [];
  const cutoff = new Date(now.getTime() - maxDays * DAY_MS);

  try {
    if (!fs.existsSync(rootDir)) {
      return [];
    }
  } catch {
    return [];
  }

  function visit(directory, depth) {
    if (samples.length >= maxEntries || depth > maxDepth) {
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (samples.length >= maxEntries || IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        fs.statSync(entryPath);
      } catch {
        continue;
      }

      let contents;
      try {
        contents = fs.readFileSync(entryPath, 'utf8');
      } catch {
        continue;
      }

      for (const line of contents.split(/\r?\n/)) {
        if (!lineHasLimitMarker(line)) {
          continue;
        }

        const sample = timestampFromLine(line);

        if (sample && shouldIncludeSample(sample, cutoff, now)) {
          samples.push(new Date(sample.getTime()));
        }
      }
    }
  }

  visit(rootDir, 0);
  return samples.sort((a, b) => a.getTime() - b.getTime());
}
