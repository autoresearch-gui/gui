# Upstream Provenance

This repository started life as a working tree of the **Paperclip** control plane and was
then repurposed into an autonomous ML research framework for
[`jsegov/autoresearch-win-rtx`](https://github.com/jsegov/autoresearch-win-rtx).

The original `.git` directory was deleted and history was restarted on 2026-09-30. This file
is the surviving record of where the code came from. The Paperclip commit history is not lost
upstream — it remains available at the remotes listed below.

## Original remotes

| Role | URL |
| --- | --- |
| Working fork (this tree's parent) | `https://github.com/dustinwloring1988/paperclip` |
| Upstream project | `https://github.com/paperclipai/paperclip` |

## Tree state at the moment history was restarted

| Field | Value |
| --- | --- |
| Branch | `master` |
| Tip commit | `41da9bb256e4e9b99ffd51463328edb738893d81` |
| Tip date | 2026-09-30 06:58:50 -0400 |
| Tip subject | `Merge branch 'paperclipai:master' into master` |
| Total commits reachable in the old history | 4664 |
| Tracked files | 8016 |
| License at handoff | MIT, `Copyright (c) 2025 Paperclip AI` (retained, see `LICENSE`) |

That tip is a merge of `paperclipai:master` into a local `master`, so it carries both the
upstream Paperclip lineage and a small number of local commits layered on top of it.

## How to recover the full original history

```sh
git clone https://github.com/dustinwloring1988/paperclip.git /tmp/paperclip-orig
cd /tmp/paperclip-orig
git show 41da9bb256e4e9b99ffd51463328edb738893d81   # the exact tree this repo started from
```

To compare the current tree against that handoff point:

```sh
git --git-dir=/tmp/paperclip-orig/.git diff --stat 41da9bb2 -- /path/to/gui
```

## Last local (non-merge) commits before the restart

These were commits layered on top of upstream Paperclip, and are the closest thing to a record
of local intent at handoff. Newest first.

```
675b1630e chore: pin LF line endings in .gitattributes
a027f76a7 fix(test): wait for the completion reporting turn before asserting chat status (#14644)
eb31b926a fix(runner): keep the OpenCode session event stream open across turns (#14582)
f38b5693f fix: always enable keyboard shortcuts (#14643)
29ea21d85 feat(ui): add the V2 dashboard behind an experimental flag, on by default
91ff4e8f1 feat(instance): default Decisions, Status Cards, Summaries, and Simplified English Interactions to enabled
279dfd7c7 feat(ui): default the Tasks page to board view; Projects page to a card grid
37a85e4c3 fix(opencode-local): mount Paperclip-assigned connections as OpenCode MCP servers
741efcf14 fix(composer): keep the assignee name readable in the run-settings trigger
bddb21305 refactor(apps): drop the Developer Choices shelf from the Connectors page
c0d0d8494 feat(apps): carry a curated developerChoice flag in the app catalog
0b12ca953 fix(server): retain context for unconfirmed adapter stops (#14639)
```

## Third-party code and data

### `jsegov/autoresearch-win-rtx` (MIT)

The research target. This project does not vendor it. It clones or references the repository
and drives `train.py` as an external process. See `doc/AUTORESEARCH.md` once written, and the
`prepare.py` / `train.py` / `program.md` contract described there.

It is itself a fork of [`karpathy/autoresearch`](https://github.com/karpathy/autoresearch),
also MIT.

### Paperclip (MIT)

Substantial portions of this codebase — the control plane, adapters, database schema, server
services, and UI design system — originate in Paperclip and remain under its MIT license. See
`NOTICE` and `LICENSE`.
