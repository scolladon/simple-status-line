# simple-status-line

A Claude Code mod that draws a quiet two-pane band above the prompt.

```
 turn pulse                     │  model · effort · session cost · cache hit · warm
 task + agents                  │  path · git · worktree
 (status, file/command)         │  last error
                                │  5h limit · 7d limit
                                │  context · legend
```

- **Left**, every column the right pane leaves: `▶`/`✓` turn pulse (elapsed · tools · files · tokens out · failures), current task, one `⧗` row per background shell or monitor (refreshed at turn end), agents with status and their latest file or command.
- **Right**, as wide as its longest line (at least 48 columns, at most 60% of the band), untitled rows: model and effort (effort from the first request on) then session cost, cache hit rate and time until cold with a one-shot `Warm` button (no automatic warming); path then `⎇` branch · ahead/behind · changes with `⊂` linked worktree (repo name only when the path does not already end with it); last failure; 5h and 7d limits side by side with pace marks; context bar by category with the auto-compact mark, usage as `used/auto-max` with the auto-compact threshold in the mark's colour, and the legend.

Below 100 columns only the right pane is shown, full width.

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
