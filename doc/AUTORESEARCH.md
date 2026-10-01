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
| Throughput | ~36,800 tok/s |
| Baseline run | `val_bpb 1.007766` mean, 33 steps, ~312s training |
| Evaluation | ~325s |
| **Total wall clock per experiment** | **~642s (10.7 min)** |
| **Experiments per hour** | **~5.6** |
| Peak VRAM | 2985 MiB, which is 18% of the card |

Three consequences worth internalising:

1. **Evaluation costs about as much as training.** `EVAL_TOKENS = 40 * 2**19`
   forward tokens over a batch the autotuner left small. So an experiment is
   ~10.7 minutes, not the ~5.5 the upstream README assumes.
2. **The upstream "kill past 10 minutes" rule would discard every run here.** It
   assumes a much faster GPU. `killAfterSec` defaults to 900s.
3. **Throughput is ~5.6 experiments/hour, not the ~12/hour the upstream README
   quotes**, which likewise assumes a faster GPU. Expect roughly 45 experiments
   across an eight-hour night.

The GPU is also 82% idle, because the autotuner picked `train_batch_size: 8` and
`activation_checkpointing: true` on a card with 16 GB. Raising the batch is
exactly the kind of change the agent is supposed to discover, and given that
evaluation dominates the wall clock, a larger evaluation batch is probably the
single highest-value experiment available.

## The noise floor

Five identical runs at the same commit, with `train.py`'s fixed seeds:

```
val_bpb  1.002385  1.006632  1.008197  1.010353  1.011264
mean     1.007766
range    0.008879      <- the noise floor a study records
stdev    0.003513
```

The framework needs this number, because without it "0.003 better" and "noise"
are indistinguishable. Two consequences that are easy to miss:

- **The seeds do not make a run reproducible.** They do, in the sense that the
  data order and initialisation are fixed, but cuDNN kernel selection and
  reduction ordering in backward passes are not deterministic, and on a consumer
  card that is worth about 0.004 of `val_bpb` run to run.
- **`program.md`'s own example of a worthwhile improvement is below the noise
  floor on this machine.** It uses "a 0.001 val_bpb improvement" and "0.003
  better" as the scale of a decision worth making. Here, 0.003 is about a third of
  the run-to-run spread, so treating it as a real improvement would mean
  advancing the branch on noise. Any research protocol tuned for this card needs
  its thresholds re-calibrated against a measured floor, not carried over from
  the upstream prose.

A study therefore runs its baseline three times at setup, records the range as
`noiseFloorBpb`, and the verdict logic treats anything inside that band as
"within noise" rather than better or worse.

## Run stability

Two of seven baseline invocations died with `exitCode 0xFFFFFFFF`, no Python
traceback, and in one case an empty log. One died cleanly at step 28 of 33 with
no error output at all.

**That is the NVIDIA driver resetting, not the trainer crashing.** The correlation
is exact:

| Time | Event |
| --- | --- |
| 17:51:03 | Run 3 dies at step 28/33, no traceback |
| 17:51:15 | `nvlddmkm` event 153 (Error) — and run 4 starts, dies in 10s, 0-byte log |
| 17:51:26 | Second `nvlddmkm` event 153 |
| 18:02:04 | Run 5 succeeds — the driver has recovered |

The machine is bare metal (Gigabyte B650 AORUS, `PCI\VEN_10DE&DEV_2805`), so this
is not a hypervisor artefact. Sleep is disabled on AC and hibernate is off, so it
is not sleep. The driver is dated 2026-09-16, two weeks old, which makes a driver
regression the most likely cause.

### What the framework does about it

An external kill and a genuine experiment failure are different facts, and
conflating them is expensive in both directions:

- A **Python traceback**, a `CUDA out of memory`, or a `FAIL:` line from
  `train.py` is a finding about the idea under test. It is recorded as a crash,
  the branch resets, and the crash counter advances.
- **Anything else** — an empty log, steps printed then silence, a startup that died
  before reaching training — is infrastructure. The idea is put back in `queued`
  and re-dispatched, up to `maxTransientRetries` (default 3), and it does **not**
  touch the crash circuit breaker. That breaker exists to catch a genuinely broken
  setup, and spending its strikes on driver resets would stop a healthy study.

The retry reuses the same row. A requeued experiment keeps its sequence number,
its idea, and its commit, so `redispatchExperiment` puts it back in `running`
rather than creating a fresh experiment - otherwise the retry budget would be
consumed by new rows and the queued idea would be stranded forever.

Transient failures are counted separately as `studies.transientFailures`, so an
operator can see machine health without it being confused with research quality.

**What is not solved:** a machine resetting the GPU this often will still not
survive a night unattended, because a driver reset can also leave the card in a
bad state for the following run, as run 4 shows. The framework makes each reset
cost a retry instead of a wasted idea, but if the rate holds the study will spend
most of its budget retrying. Worth trying before relying on it:

- Update or roll back the NVIDIA driver. It is two weeks old and this is the most
  likely cause.
- Check for other GPU workloads. This box runs another project's Python jobs,
  and any of them touching the card would contend with a training run.
- Cap the GPU power limit. A reset under sustained load is frequently a power or
  thermal excursion, and `nvidia-smi --query-gpu=power.draw,power.limit` is the
  first thing to look at.
- Raise `maxTransientRetries` if the resets are rare, or lower it if they are
  constant, so the study gives up rather than retrying forever.

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

- **A crash is detected by the absence of a usable metrics file**, not by a
  language model reading a stack trace.
- **An external kill is not a failed idea.** A GPU driver reset leaves no Python
  traceback; that run is re-dispatched rather than adjudicated.
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
