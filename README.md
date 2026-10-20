# simple-status-line

A Claude Code mod that draws a quiet three-pane band above the prompt.

```
 task + agents          │   path · git · worktree   │  session cost · cache hit · warm
 (status, file/command) │   turn pulse · last error │  limit 5h / limit 7d · context
```

- **Left**: current task, agents with status and their latest file or command.
- **Center**: path, git repo · branch · ahead/behind · changes, linked worktree, turn pulse (elapsed · tools · files · tokens out · failures), last failure.
- **Right**: session cost, cache hit rate and time until cold with a one-shot `Warm` button (no automatic warming), 5h and 7d limits with pace marks, context bar by category with the auto-compact mark.

Below 100 columns only the right-pane gauges are shown.

## Install

At the prompt of a terminal session:

```
/plugin install simple-status-line --marketplace scolladon/simple-status-line
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install simple-status-line --marketplace scolladon/simple-status-line
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `scolladon/simple-status-line`, then Add plugin.

## Options

`cacheTtl`: `1h` (default, most subscriptions) or `5m` (API-key billing).

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```
