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

const USAGE = 'Usage: agent-warmup <detect|plan|setup|update|remove|status> [--provider claude|codex] [--time HH:MM] [--lead-minutes N] [--dry-run] [--yes]';
const MIN_ACTIVE_DAYS = 5;
const WARMUP_NAME = 'Agent Warmup';

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
      parsed.leadMinutesRaw = argv[index + 1] || '';
      parsed.leadMinutes = Number.parseInt(parsed.leadMinutesRaw, 10);
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
  return `"${value.replaceAll('"', '\\"')}"`;
}

function executableExtension(executable) {
  const extensionMatch = /(\.[^./\\]+)$/.exec(executable);

  return extensionMatch?.[1].toLowerCase() || '';
}

function buildClaudeSetupInvocation({ executable, platform, args }) {
  if (platform === 'win32' && ['.bat', '.cmd'].includes(executableExtension(executable))) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', [executable, ...args].map(shellQuote).join(' ')],
    };
  }

  return {
    command: executable,
    args,
  };
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

function removeProviderConfig(provider, { env, platform, fs }) {
  const filePath = configFilePath({ env, platform });
  const currentConfig = readConfig(filePath, { fs });
  const nextProviders = { ...currentConfig.providers };
  const existed = Object.hasOwn(nextProviders, provider);

  delete nextProviders[provider];
  writeConfig(
    filePath,
    {
      ...currentConfig,
      providers: nextProviders,
    },
    { fs },
  );

  return existed;
}

function printNativeRemovalInstructions(io, provider) {
  if (provider === 'claude') {
    writeStdout(
      io,
      'Native Claude routine was not deleted. Manage it with /schedule list and /schedule update, or from the Claude Code routines page.\n',
    );
    return;
  }

  if (provider === 'codex') {
    writeStdout(
      io,
      'Native Codex Automation was not deleted. Remove or pause the "Agent Warmup" automation in Codex Automations.\n',
    );
  }
}

function printClaudeScheduleFailure(io, status) {
  writeStderr(
    io,
    [
      `Claude schedule command failed with exit code ${status}.`,
      'Likely causes: API-key/cloud-provider auth instead of claude.ai subscription auth; disabled feature traffic; older Claude Code CLI; org policy disabling routines.',
    ].join('\n'),
  );
  writeStderr(io, '\n');
}

async function setupClaude({
  io,
  env,
  platform,
  fs,
  spawnSync,
  executable,
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

  const invocation = buildClaudeSetupInvocation({
    executable,
    platform,
    args: action.args,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    printClaudeScheduleFailure(io, result.status);
    return 1;
  }

  writeProviderConfig('claude', { env, platform, fs, schedule, prompt });
  return 0;
}

async function setupCodex({
  io,
  env,
  platform,
  fs,
  schedule,
  prompt,
  dryRun,
  yes,
  codexAutomationCreate,
}) {
  const action = buildCodexAutomationAction({ schedule, prompt });

  if (dryRun) {
    writeStdout(io, `${action.fallback}\n`);
    return 0;
  }

  if (typeof codexAutomationCreate === 'function') {
    if (!yes) {
      writeStdout(io, 'Type "create" to continue: ');
      const confirmation = await readConfirmation(io);

      if (confirmation !== 'create') {
        writeStdout(io, 'Aborted\n');
        return 1;
      }
    }

    await codexAutomationCreate({
      name: WARMUP_NAME,
      schedule,
      prompt,
    });
    writeProviderConfig('codex', { env, platform, fs, schedule, prompt });
    return 0;
  }

  writeStdout(io, `${action.fallback}\n`);

  if (yes) {
    writeStdout(
      io,
      'Codex automation was not created by this CLI. Create it in Codex, then type "create" to record local metadata.\n',
    );
    return 1;
  }

  writeStdout(
    io,
    'Codex automation was not created by this CLI. Create it in Codex, then type "create" to record local metadata: ',
  );
  const confirmation = await readConfirmation(io);

  if (confirmation !== 'create') {
    writeStdout(io, 'Aborted\n');
    return 1;
  }

  writeProviderConfig('codex', { env, platform, fs, schedule, prompt });
  return 0;
}

async function runSetup(parsed, deps) {
  const { env, platform, fs: depFs, spawnSync, io, codexAutomationCreate } = deps;
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
            executable: providerInfo.executable,
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
            codexAutomationCreate,
          });

    if (providerExitCode !== 0) {
      exitCode = providerExitCode;
    }
  }

  return exitCode;
}

function runRemove(parsed, deps) {
  const { env, platform, fs: depFs, io } = deps;

  for (const provider of selectedProviders(parsed.provider)) {
    const removed = removeProviderConfig(provider, { env, platform, fs: depFs });

    if (removed) {
      writeStdout(io, `Removed local metadata for ${provider}.\n`);
    } else {
      writeStdout(io, `No local metadata found for ${provider}.\n`);
    }

    printNativeRemovalInstructions(io, provider);
  }

  return 0;
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
  const codexAutomationCreate = deps.codexAutomationCreate;
  const parsed = parseArgs(argv);
  const normalizedDeps = {
    env,
    platform,
    fs: depFs,
    spawnSync,
    io,
    codexAutomationCreate,
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

  if (
    parsed.leadMinutesRaw !== undefined &&
    (!/^\d+$/.test(parsed.leadMinutesRaw) || parsed.leadMinutes > 1440)
  ) {
    writeStderr(io, 'Invalid --lead-minutes value. Expected an integer in range 0..1440.\n');
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

  if (parsed.command === 'setup' || parsed.command === 'update') {
    return runSetup(parsed, normalizedDeps);
  }

  if (parsed.command === 'remove') {
    return runRemove(parsed, normalizedDeps);
  }

  if (parsed.command === 'status') {
    const filePath = configFilePath({ env, platform });

    for (const result of detectProviders({ env, platform, fs: depFs, spawnSync })) {
      printDetection(io, result);
    }

    writeStdout(io, `Metadata:\n${JSON.stringify(readConfig(filePath, { fs: depFs }), null, 2)}\n`);
    return 0;
  }

  writeStderr(io, `Unknown command: ${parsed.command}\n`);
  printUsage(io);
  return 1;
}

function isEntrypoint(metaUrl, argvPath) {
  if (!argvPath) return false;

  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli();
}
