# agent-warmup

NPX-friendly setup CLI for native Claude Code Routines and Codex Automations.

## What it does

- Shows installed `claude` and `codex` providers.
- Looks at local state file modification times and explicit timestamped usage-limit markers.
- Suggests a daily warmup time that targets reset shortly after the usual usage-limit hit.
- Creates a Claude Code Routine through the native `/schedule` flow.
- Creates a Codex Automation when the host environment exposes a native automation creator.
- Provides native Codex Automation instructions when direct creation is unavailable from a plain terminal.
- Records local metadata for created or manually confirmed warmup schedules so it can show routines/automations created by `agent-warmup`.

## What it does not do

- Does not run its own scheduler.
- Does not create cron, launchd, systemd, Windows Task Scheduler, GitHub Actions, or Cloudflare Workers jobs.
- Does not store provider credentials.
- Does not store prompt or response contents.
- Does not guarantee a reset window starts or improves; it creates or guides native scheduled warmup runs only.

## Usage

```bash
npx agent-warmup
npx agent-warmup setup --provider claude --dry-run
npx agent-warmup setup --provider codex --time 09:00 --dry-run
npx agent-warmup remove --provider claude
```

Run `npx agent-warmup` to see routines/automations recorded by this CLI. If none are recorded, it shows provider detection and setup suggestions.
Interactive terminals get color and a small scan spinner. Use `--plain` for deterministic output in scripts, snapshots, or terminals where styling is unwanted.

To create a Claude Code Routine:

```bash
npx agent-warmup setup --provider claude --time 09:00
```

Type `create` when prompted to continue.

Use `remove` to delete local agent-warmup metadata. It does not delete native Claude Code Routines or Codex Automations; it prints provider-specific instructions for removing or pausing those native schedules.

For Codex in plain-terminal mode, the CLI prints native Codex Automation instructions instead of directly creating the automation. `--yes` does not mark Codex configured in this fallback mode because the CLI cannot prove the automation was created; type `create` after manually creating it to record local metadata.

Claude Code Routines consume normal Claude plan usage. Codex Automations consume normal Codex usage and can affect weekly usage limits.

## Metadata paths

- macOS/Linux: `$XDG_CONFIG_HOME/agent-warmup/config.json` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/agent-warmup/config.json`
- Windows: `%APPDATA%\agent-warmup\config.json`
