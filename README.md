# simple-status-line

A Claude Code mod that draws a quiet three-pane band above the prompt.

```
 task + agents          │   model · effort          │  session cost · cache hit · warm
 (status, file/command) │   path · git · worktree   │  5h limit · 7d limit
                        │   turn pulse · last error │  context · legend
```

- **Left**: current task, one `⧗` row per background shell or monitor (refreshed at turn end), agents with status and their latest file or command.
- **Center**, untitled rows: model and effort (effort from the first request on), path, `⎇` branch · ahead/behind · changes with `⊂` linked worktree (repo name only when the path does not already end with it), `▶`/`✓` turn pulse (elapsed · tools · files · tokens out · failures), last failure.
- **Right**, untitled rows: session cost, cache hit rate and time until cold with a one-shot `Warm` button (no automatic warming), 5h and 7d limits side by side on one line with pace marks, context bar by category with the auto-compact mark and its legend.

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
