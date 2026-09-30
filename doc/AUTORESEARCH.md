# Autoresearch

This product drives [`jsegov/autoresearch-win-rtx`](https://github.com/jsegov/autoresearch-win-rtx):
an AI agent edits `train.py`, the framework runs it, and the framework decides
whether the result was an improvement. Nothing from that repository is vendored
here. It is cloned or referenced and driven as an external child process.

## The split

The organizing idea is **the LLM proposes, the framework executes and
adjudicates**.

The upstream `program.md` asks the agent to do eleven mechanical things per
iteration: read the files, edit `train.py`, commit, launch, grep the log, detect a
crash, decide keep or discard, `git reset`, append a `results.tsv` row, and loop
forever. Each step is a place an agent can silently skip, and every skip corrupts
the research record. So all of that moved server-side. The agent now does the one
thing a language model is actually good at: choosing a hypothesis and writing the
change.

| Loop step | Owner |
| --- | --- |
| Propose a hypothesis, write the `train.py` change | LLM (idea-proposer agents) |
| Shortlist ideas, pick the GPU winner | framework, deterministic scoring |
| Materialize the patch, commit, launch training | framework |
| Enforce the wall-clock kill, detect a crash | framework |
| Parse and validate `val_bpb` | framework |
| Advance or reset the branch | framework |
| Append the `results.tsv` row | framework |
| Decide the next hypothesis | LLM |

A **Study** is one autoresearch run: one `autoresearch/<tag>` branch, a set of
**Experiments** (one training run each), and a pool of **Experiment Ideas**.

## The metric

`val_bpb` (validation bits per byte, lower is better) is the ground truth.
`prepare.py` holds `evaluate_bpb` and is read-only. The metric is vocab-size
independent, so architecture changes compare fairly.

`train.py` ends every run with a delimited block:

```
---
val_bpb:          1.024859
training_seconds: 311.5
total_seconds:    672.0
peak_vram_mb:     2985.3
mfu_percent:      10.01
total_tokens_M:   16.8
num_steps:        32
num_params_M:     50.3
depth:            8
dataset:          tinystories
train_batch_size: 8
eval_batch_size:  8
activation_checkpointing: enabled
```

`server/src/services/studies/metrics.ts` parses and gates this.

### What the gate rejects, and why

- **A `smoke_test: true` run.** Under `--smoke-test` the evaluation uses
  ~1/40th of the normal token count, so the `val_bpb` is not comparable to any
  other run. A cheap metric for free is a metric that poisons the ledger.
- **A missing `Time budget: 300s` line.** `train.py` prints it from
  `prepare.py`'s read-only constant, so its presence proves `prepare.py` was not
  edited.
- **`total_tokens_M` disagreeing with `num_steps * 2**19`.** `train.py` computes
  that product exactly, so this is a free internal-consistency check. A
  hand-written metrics block drifts and is rejected. This is the single most
  useful anti-forgery signal.
- **`activation_checkpointing: disabled` parsed as truthy.** The executor prints
  the *string* `disabled`. `Boolean("disabled")` is `true`.
- **`mfu_percent` treated as a number.** It prints literal `n/a` when the GPU is
  not in the peak-flops table or the run completed ten or fewer steps.
- **A modified `prepare.py`, `pyproject.toml`, or `uv.lock`.** Hashed at study
  creation and verified before and after every experiment.
- **`valBpb = 0.000000` in the database.** `0.000000` sorts as the *best possible*
  `val_bpb`, so a crash sentinel in a numeric column lets a crash be crowned
  champion by any `min()`. The database column stays NULL and the sentinel exists
  only in the rendered `results.tsv`.

## Measured behaviour on this hardware

Gate 0 measurements, taken on the target machine. These are why several constants
look generous.

| | |
| --- | --- |
| GPU | NVIDIA GeForce RTX 4060 Ti, 16380 MiB, driver 617.14 |
| Architecture | Ada, which the fork's matrix supports at >= 10 GB |
| Autotune cache | `%LOCALAPPDATA%\autoresearch\gpu-profile-v2.json` |
| Throughput | ~36,000 tok/s |
| Baseline run | `val_bpb 1.024859`, 32 steps, 311.5s training |
| Evaluation | ~360s |
| **Total wall clock per experiment** | **~677s (11.3 min)** |
| Peak VRAM | 2985 MiB, which is 18% of the card |

Three consequences worth internalising:

1. **Evaluation costs more than training.** `EVAL_TOKENS = 40 * 2**19` forward
   tokens over a batch the autotuner left small. So an experiment is ~11 minutes,
   not ~5.5.
2. **The upstream "kill past 10 minutes" rule would discard every run here.** It
   assumes a much faster GPU. `killAfterSec` defaults to 900s.
3. **Throughput is ~5.3 experiments/hour, not the ~12/hour the upstream README
   quotes**, which likewise assumes a faster GPU. The arena is pipelined so idea
   proposal overlaps training, but the GPU is the floor.

The GPU is also 82% idle, because the autotuner picked `train_batch_size: 8` and
`activation_checkpointing: true` on a card with 16 GB. Raising the batch is
exactly the kind of change the agent is supposed to discover.

## The Windows cache path

`prepare.py:_default_cache_dir()` prefers `AUTORESEARCH_CACHE_DIR`, then
`~/.cache/autoresearch`, and only on Windows falls back to
`%LOCALAPPDATA%\autoresearch`. On this machine `~/.cache/autoresearch` does not
exist and the data lives under `%LOCALAPPDATA%`. Probing the POSIX path would
report missing data that is already present, so the framework pins
`AUTORESEARCH_CACHE_DIR` explicitly and probes that path for three concrete
artifacts:

```
datasets/tinystories/data/tinystories_gpt4_clean.parquet
datasets/tinystories/tokenizer/tokenizer.pkl
datasets/tinystories/tokenizer/token_bytes.pt
```

## Running experiments without a shared worktree

A fresh `git worktree` has no `.venv`, and bare `uv run` would re-resolve and
install, which both costs time and would silently install anything an agent added
to `pyproject.toml`. So the framework provisions **one** venv outside the
worktrees and pins `UV_PROJECT_ENVIRONMENT` to it:

```sh
# once, at study creation
UV_PROJECT_ENVIRONMENT=<study data dir>/venv uv sync --frozen

# every experiment, in any worktree
UV_PROJECT_ENVIRONMENT=<study data dir>/venv uv run --frozen --no-sync train.py
```

`--frozen --no-sync` is what enforces the upstream CANNOT-list rule that no new
packages may be installed. Measured: 21s to provision once, then ~22s per run
from a fresh worktree with no re-resolve.

## Killing the trainer

On Windows there is no process group. `runChildProcess` spawns non-detached and
`child.kill()` reaches only the direct child, which for this adapter is `node`
running the executor, not the trainer.

Two facts from Gate 0:

- `uv run` places its child in a Windows **Job Object with kill-on-close**, so
  killing the `uv` process does reap the Python trainer. Measured: VRAM fell from
  4927 MiB to baseline when only the `uv` parent was killed.
- `taskkill /PID <pid> /T /F` reliably reaps the whole tree, including
  grandchildren.

The executor therefore does both: it owns the kill with an explicit timeout, and
retains `taskkill /T /F` as the fallback, because relying on `uv`'s Job Object is
depending on another tool's internals. Before starting a run it also sweeps for
a surviving trainer and takes a GPU exclusivity lock, so a leaked process cannot
silently put two trainers on one card and corrupt every metric after it.

## Results ledger

`results.tsv` is the upstream contract and is honoured exactly: five tab-separated
columns, `commit`, `val_bpb`, `memory_gb`, `status`, `description`, a header row,
crash rows using `0.000000` and `0.0`. It is regenerated atomically from the
database on every change rather than appended, which self-heals a crash between
"metrics written" and "row appended" and never leaves a partial row. The database
is authoritative; the file is a derived export.

Upstream does not list `results.tsv` in its `.gitignore` (only the `results/`
directory), so it is meant to be committed, and committing it makes tampering
visible as a diff. The framework keeps `run.log` and `checkpoint_pre_eval.pt` out
of `git status` with a framework-owned `core.excludesFile` rather than by editing
the tracked `.gitignore`, which the agent can rewrite.

## Deliberate deviations from upstream

- **VRAM is not a gate.** Upstream calls it a soft constraint, and `train.py`
  already self-regulates three times over (autotune rejects candidates above 90%
  of VRAM, the training loop falls back on OOM, the eval loop halves the batch). A
  framework-side VRAM rule would discard experiments the executor is designed to
  rescue. The framework records peak VRAM, badges it above 90%, and feeds the
  headroom into idea generation.
- **The baseline runs three times**, not once, so the run-to-run noise floor is
  measured rather than assumed. Without a floor, "0.003 better" and "noise" are
  indistinguishable and the branch advances on nothing.
- **Simplification wins are preserved.** Upstream says an improvement of about
  zero paired with much simpler code should be kept. A pure-`val_bpb` rule would
  reset the branch and erase it, compounding over a hundred experiments. Hence
  `gitAction: adopt_simplification`, which advances the branch without moving
  `bestValBpb`.
- **Prediction never gates idea selection.** Predicted gain orders the shortlist;
  it does not filter it, and a fixed fraction of experiments draws from radical
  `explore` ideas regardless. A scoring rule that filters on predicted gain
  turns explore-and-judge-by-result into exploit-the-proposer's-own-prior.

## Verification

The server suite is ~870 files that each boot an embedded Postgres with
`maxWorkers: 1`, so `pnpm test:run` is left to CI. While iterating, run the
targeted suites:

```sh
pnpm exec vitest run server/src/services/studies/
```

Then `pnpm -r typecheck` and, for UI work, `pnpm check:token-gates`.
