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
  codexAutomationIdForIndex,
  codexAutomationExists,
  dailySchedulesToRrule,
  removeCodexAutomation,
  writeCodexAutomation,
} from './codex-automation.js';
import {
  DEFAULT_LIMIT_WINDOW_MINUTES,
  DEFAULT_PROMPT,
  DEFAULT_RESET_PADDING_MINUTES,
  PROVIDERS,
} from './constants.js';
import { collectLimitHitSamples } from './history.js';
import { configFilePath } from './platform.js';
import { detectProvider, detectProviders } from './providers.js';
import { inferWarmupTime } from './schedule.js';
import { createUi } from './ui.js';

const USAGE = 'Usage: agent-warmup [setup|remove] [--provider claude|codex] [--time HH:MM] [--window-minutes N] [--reset-padding-minutes N] [--dry-run] [--plain]';
const MIN_LIMIT_HIT_DAYS = 5;
const WARMUP_NAME = 'Agent Warmup';
const CLAUDE_PRINT_MODE_ARGS = ['-p', '--model', 'fable', '--effort', 'low', '--output-format', 'json'];

function defaultIo() {
  return {
    isTty: Boolean(process.stdout.isTTY),
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
    command: 'dashboard',
    provider: null,
    dryRun: false,
    yes: false,
    plain: false,
    time: null,
    resetPaddingMinutes: DEFAULT_RESET_PADDING_MINUTES,
    windowMinutes: DEFAULT_LIMIT_WINDOW_MINUTES,
  };

  let startIndex = 0;

  if (argv[0] === '--help' || argv[0] === '-h') {
    parsed.command = argv[0];
    startIndex = 1;
  } else if (argv[0] && !argv[0].startsWith('--')) {
    parsed.command = argv[0];
    startIndex = 1;
  }

  for (let index = startIndex; index < argv.length; index += 1) {
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

    if (arg === '--plain') {
      parsed.plain = true;
      continue;
    }

    if (arg === '--time') {
      parsed.time = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--reset-padding-minutes') {
      parsed.resetPaddingMinutesRaw = argv[index + 1] || '';
      parsed.resetPaddingMinutes = Number.parseInt(parsed.resetPaddingMinutesRaw, 10);
      index += 1;
      continue;
    }

    if (arg === '--window-minutes') {
      parsed.windowMinutesRaw = argv[index + 1] || '';
      parsed.windowMinutes = Number.parseInt(parsed.windowMinutesRaw, 10);
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

function selectedSetupProviders(provider) {
  return provider === null ? ['codex', 'claude'] : [provider];
}

function providerHasExistingSetup(provider, config, { env, fs, platform }) {
  if (config.providers[provider]) {
    return true;
  }

  return provider === 'codex' && codexAutomationExists({ env, fs, platform });
}

function checkExistingSetups(providers, { config, env, fs, io, platform }) {
  const existingProviders = providers.filter((provider) =>
    providerHasExistingSetup(provider, config, { env, fs, platform }),
  );

  for (const provider of existingProviders) {
    writeStderr(
      io,
      `${provider}: existing agent-warmup setup found. Run: agent-warmup remove --provider ${provider} before setup.\n`,
    );
  }

  return existingProviders.length === 0;
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

function providerLabel(provider) {
  return provider === 'claude' ? 'Claude Code' : 'Codex';
}

function printDetection(io, result, ui = createUi({ io, plain: true })) {
  const installText = result.installed
    ? ui.green(`installed${result.version ? ` (${result.version})` : ''}`)
    : ui.yellow('missing');
  const stateText = result.stateDirExists ? 'local state found' : 'local state missing';

  const provider = ui.interactive ? providerLabel(result.provider) : result.provider;

  writeStdout(io, `${provider}: ${installText}; ${ui.dim(stateText)}\n`);

  for (const warning of result.warnings) {
    writeStdout(io, `  warning: ${warning}\n`);
  }
}

function nativeStatusText(provider, { env, fs, platform }) {
  if (provider === 'codex') {
    return codexAutomationExists({ env, fs, platform })
      ? 'native file found'
      : 'native file missing';
  }

  return 'native status not verified';
}

function printConfiguredProviders(
  io,
  config,
  { env, fs, platform, ui = createUi({ io, plain: true }) } = {},
) {
  const configured = PROVIDERS.filter((provider) => config.providers[provider]);

  if (configured.length === 0) {
    writeStdout(io, `${ui.dim('No agent-warmup routines are recorded yet.')}\n`);
    return 0;
  }

  writeStdout(io, `${ui.bold('Configured routines/automations')}${ui.interactive ? '' : ':'}\n`);

  for (const provider of configured) {
    const metadata = config.providers[provider];
    const name = provider === 'claude' ? metadata.routineName : metadata.automationName;
    const nativeStatus = nativeStatusText(provider, { env, fs, platform });

    if (!ui.interactive) {
      writeStdout(
        io,
        `  ${provider}: ${name || WARMUP_NAME}, ${metadata.schedule} (recorded by agent-warmup; ${nativeStatus})\n`,
      );
      continue;
    }

    writeStdout(
      io,
      `  ${ui.symbol('ready')} ${providerLabel(provider)} ${ui.cyan(metadata.schedule)} ${ui.dim(`${name || WARMUP_NAME}; ${nativeStatus}`)}\n`,
    );
  }

  return configured.length;
}

function printSetupSuggestions(
  io,
  results,
  config,
  { fs, resetPaddingMinutes, ui, windowMinutes },
) {
  const providersWithoutConfig = results.filter((result) => !config.providers[result.provider]);

  if (providersWithoutConfig.length === 0) {
    return;
  }

  const spinner = ui.startSpinner('Building warmup suggestions...');
  const suggestions = providersWithoutConfig.map((result) => {
    if (!result.installed) {
      return { result, scheduleResult: null };
    }

    return {
      result,
      scheduleResult: inferScheduleResult(result, {
        fs,
        resetPaddingMinutes,
        windowMinutes,
      }),
    };
  });
  spinner.stop();

  writeStdout(io, `${ui.bold('Suggestions')}${ui.interactive ? '' : ':'}\n`);

  for (const { result, scheduleResult } of suggestions) {
    if (!result.installed) {
      if (!ui.interactive) {
        writeStdout(io, `  ${result.provider}: missing. Install ${result.provider} before setup.\n`);
        continue;
      }

      writeStdout(
        io,
        `  ${ui.symbol('missing')} ${providerLabel(result.provider)} ${ui.yellow('missing')} ${ui.dim(`install ${result.provider} before setup`)}\n`,
      );
      continue;
    }

    if (scheduleResult.kind === 'insufficient-limit-history') {
      if (!ui.interactive) {
        writeStdout(
          io,
          `  ${result.provider}: insufficient usage-limit hit history (${scheduleResult.limitHitDays}/${scheduleResult.requiredDays} days). Run: agent-warmup setup --provider ${result.provider} --time HH:MM\n`,
        );
        continue;
      }

      writeStdout(
        io,
        `  ${ui.symbol('missing')} ${providerLabel(result.provider)} insufficient usage-limit hit history (${scheduleResult.limitHitDays}/${scheduleResult.requiredDays} days). ${ui.cyan(`Run: agent-warmup setup --provider ${result.provider} --time HH:MM`)}\n`,
      );
      continue;
    }

    if (ui.interactive) {
      writeStdout(io, `  ${ui.symbol('warm')} ${providerLabel(result.provider)}\n`);
      writeStdout(io, `    Warmup       ${ui.cyan(scheduleResult.schedule)}\n`);
      writeStdout(io, `    Limit hit    ${scheduleResult.limitHit}\n`);
      writeStdout(io, `    Target reset ${scheduleResult.targetReset}\n`);
      writeStdout(io, `    Evidence     ${scheduleResult.limitHitDays} limit-hit days\n`);
      writeStdout(
        io,
        `    Run          ${ui.cyan(`agent-warmup setup --provider ${result.provider}`)}\n`,
      );
      continue;
    }

    if (!ui.interactive) {
      writeStdout(
        io,
        `  ${result.provider}: ${scheduleResult.schedule} based on ${scheduleResult.limitHitDays} limit-hit days; usual limit hit ${scheduleResult.limitHit}, target reset ${scheduleResult.targetReset}. Run: agent-warmup setup --provider ${result.provider}\n`,
      );
      continue;
    }
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

function buildClaudePrintArgs(actionArgs) {
  return [...CLAUDE_PRINT_MODE_ARGS, ...actionArgs];
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
    schedules: [`daily at ${time}`],
    warmupTime: time,
  };
}

function inferSchedule(providerInfo, { fs, resetPaddingMinutes, windowMinutes, io }) {
  const limitHitSamples = collectLimitHitSamples(providerInfo.stateDir, { fs });
  const result = inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: MIN_LIMIT_HIT_DAYS,
    resetPaddingMinutes,
    windowMinutes,
  });

  if (result.kind === 'insufficient-limit-history') {
    writeStdout(
      io,
      `${providerInfo.provider}: insufficient usage-limit hit history (${result.limitHitDays}/${result.requiredDays} days). Re-run with --time HH:MM.\n`,
    );
    return null;
  }

  return result;
}

function inferScheduleResult(providerInfo, { fs, resetPaddingMinutes, windowMinutes }) {
  const limitHitSamples = collectLimitHitSamples(providerInfo.stateDir, { fs });
  return inferWarmupTime([], {
    limitHitSamples,
    minLimitHitDays: MIN_LIMIT_HIT_DAYS,
    resetPaddingMinutes,
    windowMinutes,
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

function writeProviderConfig(provider, { env, platform, fs, schedule, schedules, prompt }) {
  const filePath = configFilePath({ env, platform });
  const currentConfig = readConfig(filePath, { fs });
  const nextConfig = {
    ...currentConfig,
    providers: {
      ...currentConfig.providers,
      [provider]: buildProviderMetadata(provider, { schedule, schedules, prompt }),
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

function parseClaudePrintResult(stdout) {
  if (!stdout.trim()) {
    return { created: false, message: '' };
  }

  try {
    const parsed = JSON.parse(stdout);
    const message = String(parsed.result || '');

    return {
      created:
        parsed.is_error !== true &&
        (/https:\/\/claude\.ai\/code\/routines\/trig_[A-Za-z0-9]+/.test(message) ||
          /\btrig_[A-Za-z0-9]+\b/.test(message)),
      message,
    };
  } catch {
    return {
      created:
        /https:\/\/claude\.ai\/code\/routines\/trig_[A-Za-z0-9]+/.test(stdout) ||
        /\btrig_[A-Za-z0-9]+\b/.test(stdout),
      message: stdout.trim(),
    };
  }
}

async function setupClaude({
  io,
  env,
  platform,
  fs,
  spawnSync,
  executable,
  schedule,
  schedules,
  prompt,
  dryRun,
}) {
  const scheduleList = schedules || [schedule];
  const printArgsBySchedule = scheduleList.map((currentSchedule) => {
    const action = buildClaudeScheduleAction({ schedule: currentSchedule, prompt });
    return {
      action,
      printArgs: buildClaudePrintArgs(action.args),
    };
  });

  for (const { action, printArgs } of printArgsBySchedule) {
    writeStdout(io, `Native action: ${action.command} ${printArgs.map(shellQuote).join(' ')}\n`);
  }

  if (dryRun) {
    return 0;
  }

  for (const { printArgs } of printArgsBySchedule) {
    const invocation = buildClaudeSetupInvocation({
      executable,
      platform,
      args: printArgs,
    });
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      env,
    });

    if (result.status !== 0) {
      printClaudeScheduleFailure(io, result.status);
      return 1;
    }

    const printResult = parseClaudePrintResult(result.stdout || '');
    if (!printResult.created) {
      writeStderr(
        io,
        'Claude schedule command exited but did not confirm routine creation. Native output was:\n',
      );
      writeStderr(io, `${printResult.message || result.stdout || result.stderr || '(empty output)'}\n`);
      return 1;
    }

    writeStdout(io, 'Created Claude Code Routine.\n');
    if (printResult.message) {
      writeStdout(io, `${printResult.message}\n`);
    }
  }

  writeProviderConfig('claude', { env, platform, fs, schedule, schedules: scheduleList, prompt });
  return 0;
}

async function setupCodex({
  io,
  env,
  platform,
  fs,
  cwd,
  now,
  schedule,
  schedules,
  prompt,
  dryRun,
  codexAutomationCreate,
}) {
  const action = buildCodexAutomationAction({ schedule, prompt });
  const scheduleList = schedules || [schedule];

  if (dryRun) {
    writeStdout(io, `${action.description}\n`);
    return 0;
  }

  if (typeof codexAutomationCreate === 'function') {
    for (const [index, currentSchedule] of scheduleList.entries()) {
      await codexAutomationCreate({
        name: index === 0 ? WARMUP_NAME : `${WARMUP_NAME} ${index + 1}`,
        schedule: currentSchedule,
        prompt,
      });
    }
    writeProviderConfig('codex', { env, platform, fs, schedule, schedules: scheduleList, prompt });
    return 0;
  }

  const combinedRrule = scheduleList.length > 1 ? dailySchedulesToRrule(scheduleList) : null;
  const codexSchedules = combinedRrule
    ? [{ index: 0, rrule: combinedRrule, schedule: scheduleList[0] }]
    : scheduleList.map((currentSchedule, index) => ({ index, schedule: currentSchedule }));

  for (const { index, rrule, schedule: currentSchedule } of codexSchedules) {
    const id = codexAutomationIdForIndex(index);
    const automation = writeCodexAutomation({
      cwd,
      env,
      fs,
      id,
      name: index === 0 ? WARMUP_NAME : `${WARMUP_NAME} ${index + 1}`,
      now,
      platform,
      prompt,
      rrule,
      schedule: currentSchedule,
    });
    writeStdout(io, `Created Codex Automation: ${automation.id}\n`);
    writeStdout(io, `Native file: ${automation.filePath}\n`);
  }
  writeStdout(io, `Workspace: ${cwd}\n`);
  writeProviderConfig('codex', { env, platform, fs, schedule, schedules: scheduleList, prompt });
  return 0;
}

async function runSetup(parsed, deps) {
  const { env, platform, fs: depFs, spawnSync, io, codexAutomationCreate, cwd, now } = deps;
  let exitCode = 0;
  const providers = selectedSetupProviders(parsed.provider);

  if (!parsed.dryRun) {
    const config = readConfig(configFilePath({ env, platform }), { fs: depFs });

    if (!checkExistingSetups(providers, { config, env, fs: depFs, io, platform })) {
      return 1;
    }
  }

  for (const provider of providers) {
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
        ? inferSchedule(providerInfo, {
            fs: depFs,
            resetPaddingMinutes: parsed.resetPaddingMinutes,
            windowMinutes: parsed.windowMinutes,
            io,
          })
        : scheduleFromTime(parsed.time, io);

    if (scheduleResult === null) {
      return 1;
    }

    const schedule = scheduleResult.schedule;
    const schedules = scheduleResult.schedules || [schedule];
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
            schedules,
            prompt,
            dryRun: parsed.dryRun,
          })
        : await setupCodex({
            io,
            env,
            platform,
            fs: depFs,
            cwd,
            now,
            schedule,
            schedules,
            prompt,
            dryRun: parsed.dryRun,
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

    if (provider === 'codex') {
      if (removeCodexAutomation({ env, platform, fs: depFs })) {
        writeStdout(io, 'Removed native Codex Automation.\n');
      } else {
        printNativeRemovalInstructions(io, provider);
      }

      continue;
    }

    printNativeRemovalInstructions(io, provider);
  }

  return 0;
}

function runDashboard(parsed, deps) {
  const { env, platform, fs: depFs, spawnSync, io } = deps;
  const filePath = configFilePath({ env, platform });
  const config = readConfig(filePath, { fs: depFs });
  const ui = createUi({ env, io, plain: parsed.plain });

  writeStdout(io, `${ui.bold(ui.cyan('Agent Warmup'))}\n`);

  const configuredCount = printConfiguredProviders(io, config, {
    env,
    fs: depFs,
    platform,
    ui,
  });

  if (configuredCount > 0) {
    return 0;
  }

  const spinner = ui.startSpinner('Scanning local harness history...');
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
  spinner.stop();

  writeStdout(io, `${ui.bold('Detected providers')}${ui.interactive ? '' : ':'}\n`);

  for (const result of detectionResults) {
    writeStdout(io, '  ');
    printDetection(io, result, ui);
  }

  printSetupSuggestions(io, detectionResults, config, {
    fs: depFs,
    resetPaddingMinutes: parsed.resetPaddingMinutes,
    ui,
    windowMinutes: parsed.windowMinutes,
  });

  return 0;
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io || defaultIo();
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const depFs = deps.fs || fs;
  const spawnSync = deps.spawnSync || nodeSpawnSync;
  const codexAutomationCreate = deps.codexAutomationCreate;
  const cwd = deps.cwd || process.cwd();
  const now = deps.now || Date.now;
  const parsed = parseArgs(argv);
  const normalizedDeps = {
    env,
    platform,
    fs: depFs,
    spawnSync,
    io,
    codexAutomationCreate,
    cwd,
    now,
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
    parsed.resetPaddingMinutesRaw !== undefined &&
    (!/^\d+$/.test(parsed.resetPaddingMinutesRaw) || parsed.resetPaddingMinutes > 1440)
  ) {
    writeStderr(
      io,
      'Invalid --reset-padding-minutes value. Expected an integer in range 0..1440.\n',
    );
    return 1;
  }

  if (
    parsed.windowMinutesRaw !== undefined &&
    (!/^\d+$/.test(parsed.windowMinutesRaw) || parsed.windowMinutes > 1440)
  ) {
    writeStderr(io, 'Invalid --window-minutes value. Expected an integer in range 0..1440.\n');
    return 1;
  }

  if (parsed.command === 'dashboard') {
    return runDashboard(parsed, normalizedDeps);
  }

  if (parsed.command === 'setup') {
    return runSetup(parsed, normalizedDeps);
  }

  if (parsed.command === 'remove') {
    return runRemove(parsed, normalizedDeps);
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
