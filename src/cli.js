#!/usr/bin/env node

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  buildClaudeScheduleAction,
  buildCodexAutomationAction,
  usageWarning,
} from './actions.js';
import {
  buildProviderMetadata,
  readConfig,
  writeConfig,
} from './config.js';
import {
  DEFAULT_LEAD_MINUTES,
  DEFAULT_PROMPT,
  PROVIDERS,
} from './constants.js';
import { collectActivitySamples } from './history.js';
import { configFilePath } from './platform.js';
import { detectProvider, detectProviders } from './providers.js';
import { inferWarmupTime } from './schedule.js';

const USAGE = 'Usage: harness-reset <detect|plan|setup|status> [--provider claude|codex] [--time HH:MM] [--dry-run] [--yes]';
const MIN_ACTIVE_DAYS = 5;

function defaultIo() {
  return {
    stdin: {
      async read() {
        const readline = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          return await readline.question('');
        } finally {
          readline.close();
        }
      },
    },
    writeStdout(text) {
      process.stdout.write(text);
    },
    writeStderr(text) {
      process.stderr.write(text);
    },
  };
}

function writeStdout(io, text) {
  if (typeof io.writeStdout === 'function') {
    io.writeStdout(text);
    return;
  }

  io.stdout.write(text);
}

function writeStderr(io, text) {
  if (typeof io.writeStderr === 'function') {
    io.writeStderr(text);
    return;
  }

  io.stderr.write(text);
}

function parseArgs(argv) {
  const parsed = {
    command: argv[0] || 'help',
    provider: null,
    dryRun: false,
    yes: false,
    time: null,
    leadMinutes: DEFAULT_LEAD_MINUTES,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--provider') {
      parsed.provider = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (arg === '--yes') {
      parsed.yes = true;
      continue;
    }

    if (arg === '--time') {
      parsed.time = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--lead-minutes') {
      parsed.leadMinutes = Number.parseInt(argv[index + 1] || '', 10);
      index += 1;
      continue;
    }

    parsed.unknown = arg;
  }

  return parsed;
}

function selectedProviders(provider) {
  return provider === null ? [...PROVIDERS] : [provider];
}

function validateProvider(provider, io) {
  if (provider === null || PROVIDERS.includes(provider)) {
    return true;
  }

  writeStderr(io, `Unsupported provider: ${provider}. Valid providers: ${PROVIDERS.join(', ')}\n`);
  return false;
}

function validTime(time) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function printUsage(io) {
  writeStdout(io, `${USAGE}\n`);
}

function printDetection(io, result) {
  const installText = result.installed
    ? `installed${result.version ? ` (${result.version})` : ''}`
    : 'missing';
  const stateText = result.stateDirExists ? 'local state found' : 'local state missing';

  writeStdout(io, `${result.provider}: ${installText}; ${stateText}\n`);

  for (const warning of result.warnings) {
    writeStdout(io, `  warning: ${warning}\n`);
  }
}

function shellQuote(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function readConfirmation(io) {
  if (!io.stdin || typeof io.stdin.read !== 'function') {
    return '';
  }

  const value = await io.stdin.read();
  return String(value || '').trim();
}

function scheduleFromTime(time, io) {
  if (!validTime(time)) {
    writeStderr(io, `Invalid time: ${time}. Expected HH:MM.\n`);
    return null;
  }

  return {
    kind: 'explicit',
    activeDays: null,
    schedule: `daily at ${time}`,
    warmupTime: time,
  };
}

function inferSchedule(providerInfo, { fs, leadMinutes, io }) {
  const samples = collectActivitySamples(providerInfo.stateDir, { fs });
  const result = inferWarmupTime(samples, {
    leadMinutes,
    minActiveDays: MIN_ACTIVE_DAYS,
  });

  if (result.kind === 'insufficient-history') {
    writeStdout(
      io,
      `${providerInfo.provider}: insufficient history (${result.activeDays}/${result.requiredDays} active days). Re-run with --time HH:MM.\n`,
    );
    return null;
  }

  return result;
}

function inferScheduleResult(providerInfo, { fs, leadMinutes }) {
  const samples = collectActivitySamples(providerInfo.stateDir, { fs });
  return inferWarmupTime(samples, {
    leadMinutes,
    minActiveDays: MIN_ACTIVE_DAYS,
  });
}

function printSetupSummary(io, { provider, schedule, prompt, dryRun }) {
  if (dryRun) {
    writeStdout(io, 'DRY RUN\n');
  }

  writeStdout(io, `${provider} warmup\n`);
  writeStdout(io, `Schedule: ${schedule}\n`);
  writeStdout(io, `Prompt:\n${prompt}\n`);
  writeStdout(io, `Warning: ${usageWarning(provider)}\n`);
}

function writeProviderConfig(provider, { env, platform, fs, schedule, prompt }) {
  const filePath = configFilePath({ env, platform });
  const currentConfig = readConfig(filePath, { fs });
  const nextConfig = {
    ...currentConfig,
    providers: {
      ...currentConfig.providers,
      [provider]: buildProviderMetadata(provider, { schedule, prompt }),
    },
  };

  writeConfig(filePath, nextConfig, { fs });
}

async function setupClaude({
  io,
  env,
  platform,
  fs,
  spawnSync,
  schedule,
  prompt,
  dryRun,
  yes,
}) {
  const action = buildClaudeScheduleAction({ schedule, prompt });

  writeStdout(io, `Native action: ${action.command} ${action.args.map(shellQuote).join(' ')}\n`);

  if (dryRun) {
    return 0;
  }

  if (!yes) {
    writeStdout(io, 'Type "create" to continue: ');
    const confirmation = await readConfirmation(io);

    if (confirmation !== 'create') {
      writeStdout(io, 'Aborted\n');
      return 1;
    }
  }

  const result = spawnSync(action.command, action.args, {
    encoding: 'utf8',
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    writeStderr(io, `Claude schedule command failed with exit code ${result.status}.\n`);
    return 1;
  }

  writeProviderConfig('claude', { env, platform, fs, schedule, prompt });
  return 0;
}

async function setupCodex({ io, env, platform, fs, schedule, prompt, dryRun, yes }) {
  const action = buildCodexAutomationAction({ schedule, prompt });

  writeStdout(io, `${action.fallback}\n`);

  if (dryRun) {
    return 0;
  }

  if (!yes) {
    writeStdout(io, 'After creating the automation manually, type "create" to write metadata: ');
    const confirmation = await readConfirmation(io);

    if (confirmation !== 'create') {
      writeStdout(io, 'Aborted\n');
      return 1;
    }
  }

  writeProviderConfig('codex', { env, platform, fs, schedule, prompt });
  return 0;
}

async function runSetup(parsed, deps) {
  const { env, platform, fs: depFs, spawnSync, io } = deps;
  let exitCode = 0;

  for (const provider of selectedProviders(parsed.provider)) {
    const providerInfo = detectProvider(provider, {
      env,
      platform,
      fs: depFs,
      spawnSync,
    });

    if (!providerInfo.installed) {
      writeStderr(io, `${provider}: missing. Install ${provider} before setup.\n`);
      exitCode = 1;
      continue;
    }

    const scheduleResult =
      parsed.time === null
        ? inferSchedule(providerInfo, { fs: depFs, leadMinutes: parsed.leadMinutes, io })
        : scheduleFromTime(parsed.time, io);

    if (scheduleResult === null) {
      return 1;
    }

    const schedule = scheduleResult.schedule;
    const prompt = DEFAULT_PROMPT;

    printSetupSummary(io, {
      provider,
      schedule,
      prompt,
      dryRun: parsed.dryRun,
    });

    const providerExitCode =
      provider === 'claude'
        ? await setupClaude({
            io,
            env,
            platform,
            fs: depFs,
            spawnSync,
            schedule,
            prompt,
            dryRun: parsed.dryRun,
            yes: parsed.yes,
          })
        : await setupCodex({
            io,
            env,
            platform,
            fs: depFs,
            schedule,
            prompt,
            dryRun: parsed.dryRun,
            yes: parsed.yes,
          });

    if (providerExitCode !== 0) {
      exitCode = providerExitCode;
    }
  }

  return exitCode;
}

function runPlan(parsed, deps) {
  const { env, platform, fs: depFs, spawnSync, io } = deps;
  const results = [];

  for (const provider of selectedProviders(parsed.provider)) {
    const providerInfo = detectProvider(provider, {
      env,
      platform,
      fs: depFs,
      spawnSync,
    });

    if (!providerInfo.installed) {
      results.push({ provider, kind: 'missing' });
      continue;
    }

    const scheduleResult =
      parsed.time === null
        ? inferScheduleResult(providerInfo, { fs: depFs, leadMinutes: parsed.leadMinutes })
        : scheduleFromTime(parsed.time, io);

    results.push({
      provider,
      ...(scheduleResult || { kind: 'unavailable' }),
    });
  }

  writeStdout(io, `${JSON.stringify(results, null, 2)}\n`);
  return results.some((result) => result.kind === 'missing' || result.kind === 'unavailable') ? 1 : 0;
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io || defaultIo();
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const depFs = deps.fs || fs;
  const spawnSync = deps.spawnSync || nodeSpawnSync;
  const parsed = parseArgs(argv);
  const normalizedDeps = {
    env,
    platform,
    fs: depFs,
    spawnSync,
    io,
  };

  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
    printUsage(io);
    return 0;
  }

  if (parsed.unknown) {
    writeStderr(io, `Unknown argument: ${parsed.unknown}\n`);
    printUsage(io);
    return 1;
  }

  if (!validateProvider(parsed.provider, io)) {
    return 1;
  }

  if (Number.isNaN(parsed.leadMinutes)) {
    writeStderr(io, 'Invalid --lead-minutes value.\n');
    return 1;
  }

  if (parsed.command === 'detect') {
    const detectionResults =
      parsed.provider === null
        ? detectProviders({ env, platform, fs: depFs, spawnSync })
        : [
            detectProvider(parsed.provider, {
              env,
              platform,
              fs: depFs,
              spawnSync,
            }),
          ];

    for (const result of detectionResults) {
      printDetection(io, result);
    }

    return 0;
  }

  if (parsed.command === 'plan') {
    return runPlan(parsed, normalizedDeps);
  }

  if (parsed.command === 'setup') {
    return runSetup(parsed, normalizedDeps);
  }

  if (parsed.command === 'status') {
    const filePath = configFilePath({ env, platform });
    writeStdout(io, `${JSON.stringify(readConfig(filePath, { fs: depFs }), null, 2)}\n`);
    return 0;
  }

  writeStderr(io, `Unknown command: ${parsed.command}\n`);
  printUsage(io);
  return 1;
}

function isEntrypoint(metaUrl, argvPath) {
  if (!argvPath) return false;
  return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argvPath);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli();
}
