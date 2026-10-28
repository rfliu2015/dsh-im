# Installing this fork, and what happens to existing configuration

> For a machine that already has `@xmanrui/dsh-im` installed and configured.
> Repo: `https://github.com/rfliu2015/dsh-im` (fork of `xmanrui/dsh-im`)

## Configuration is inherited automatically — do not uninstall first

Configuration does **not** live inside the plugin package. It lives under
`DSH_HOME` (default `~/.dsh`) at a path derived from the **channel name**, not
the package name or version:

```js
// plugin-src/host/channels/shared/production.mjs:35 and siblings
const root = resolve(config.dataDir ?? join(dshHome, 'integrations', `dsh-${channel}`));
```

| What | Path relative to `DSH_HOME` |
|---|---|
| Telegram bot credentials | `integrations/dsh-telegram/config.json` |
| That bot's workspace/session bindings | `integrations/dsh-telegram/workspaces.json` |
| Any other channel | `integrations/dsh-<channel>/config.json` |
| General settings, group history, language, sidebar | `integrations/dsh-im/*` |

Both packages are named `@xmanrui/dsh-im`, so pnpm treats them as the same
dependency: installing the fork **replaces** the official build in place.
`cordis.patch.yml` needs no edit and every bot keeps working.

`dsh-im uninstall` only runs `dsh plugin remove` (`bin/dsh-im.mjs:91`) and
deletes nothing under `integrations/`, so uninstalling does not reset
configuration either.

## Back up first

```powershell
$ts = Get-Date -Format yyyyMMdd-HHmmss
Copy-Item "$env:USERPROFILE\.dsh\integrations" "$env:USERPROFILE\.dsh\integrations.bak-$ts" -Recurse
```

## Check the profile name

Configuration follows the **profile**, not the machine:

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object -ExpandProperty Name
```

Use `--profile desktop` for DSH Desktop, `--profile web` for `dsh web`.
Installing into the wrong profile is the usual reason a bot list looks empty.

## Install

```powershell
dsh plugin --profile desktop add -w github:rfliu2015/dsh-im#main
```

Then restart DSH: the plugin loads `lib/index.js` at Host startup.

## Verify

```powershell
# 1. configuration is still there and non-empty
Get-ChildItem "$env:USERPROFILE\.dsh\integrations\dsh-telegram\config.json" |
  Select-Object Length, LastWriteTime

# 2. the running bundle really is the fork
$t = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im\lib\index.js"
$c = [IO.File]::ReadAllText($t)
$d = [regex]::Replace($c, '\\u([0-9a-fA-F]{4})', { param($m) [char][Convert]::ToInt32($m.Groups[1].Value,16) })
"has /start branch : " + $d.Contains('当前对话工作区：{workspace}')
"has start catalog : " + $d.Contains('查看当前工作区与会话')
```

Both should print `True`. Chinese strings are `\uXXXX`-escaped by esbuild in
the bundle, so grepping the raw file for them gives a false negative.

3. In Settings → IM Bot the bot list should be intact; sending the bot a plain
   message should get a reply, which proves token, session and workspace
   bindings all carried over.

## Do not update through the plugin market afterwards

The market installs the official `@xmanrui/dsh-im`, which occupies the same
path and silently replaces the fork.

## Rolling back

```powershell
dsh plugin --profile desktop add -w @xmanrui/dsh-im@latest
```

## Other traps

- The repository has **no `prepare` hook**; the committed `lib/` artifacts are
  what runs. `git clone` + `npm install` alone produces nothing — run
  `npm run build` if you change the source.
- pnpm 10 may need `onlyBuiltDependencies: [esbuild]` in the profile's
  `pnpm-workspace.yaml` before it runs build scripts.
- The GitHub example in the upstream README points at `xmanrui/dsh-im`, which
  installs the official build rather than this fork.
