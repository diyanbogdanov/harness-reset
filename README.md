# agent-warmup

NPX-friendly setup CLI for native Claude Code Routines and Codex Automations.

## What it does

- Shows installed `claude` and `codex` providers.
- Looks at explicit timestamped usage-limit markers in local harness state.
- Suggests daily warmup times that target resets shortly after usual usage-limit hits.
- Creates Claude Code Routines through the native `/schedule` flow.
- Creates Codex Automations by writing native Codex automation records under `$CODEX_HOME/automations`, or `~/.codex/automations` when `CODEX_HOME` is unset.
- Records local metadata for warmup schedules created by `agent-warmup`.

## What it does not do

- Does not run its own scheduler.
- Does not create cron, launchd, systemd, Windows Task Scheduler, GitHub Actions, or Cloudflare Workers jobs.
- Does not store provider credentials.
- Does not store prompt or response contents.
- Does not guarantee reset windows start or improve; it creates native scheduled warmup runs only.

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

Claude setup runs Claude Code in non-interactive print mode, so it should return to your shell after creating the routine instead of leaving you inside a Claude Code session.

To create a Codex Automation:

```bash
npx agent-warmup setup --provider codex --time 09:00
```

Codex Automations are attached to the directory where you run `agent-warmup setup`. The setup output prints both the native automation file and the workspace path so you can verify where Codex will run it.

Use `--dry-run` to preview the native action without creating anything.

`setup` does not overwrite existing agent-warmup routines or automations. Run `agent-warmup remove --provider claude` or `agent-warmup remove --provider codex` first, then run setup again.

Use `remove` to delete local agent-warmup metadata. For Codex, it also removes the native `agent-warmup` automation file. For Claude Code, it prints provider-specific instructions because Claude Code does not expose a routine deletion command through the CLI.

When local history shows multiple daily usage-limit hits, setup may create multiple native routines or automations. Overlapping inferred windows are pushed to start at least one minute after the previous target reset.

Claude Code Routines consume normal Claude plan usage. Codex Automations consume normal Codex usage and can affect weekly usage limits.

## Metadata paths

- macOS/Linux: `$XDG_CONFIG_HOME/agent-warmup/config.json` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/agent-warmup/config.json`
- Windows: `%APPDATA%\agent-warmup\config.json`
