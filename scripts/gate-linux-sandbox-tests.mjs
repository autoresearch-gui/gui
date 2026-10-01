import { readFileSync, writeFileSync } from "node:fs";

/**
 * Gates the local-sandbox test suites to Linux.
 *
 * One-off codemod, run from the repo root. Kept in the repo so the gate is
 * auditable and re-runnable rather than a pile of hand edits nobody can verify.
 *
 * Usage: node scripts/gate-linux-sandbox-tests.mjs [--check]
 */
const CHECK_ONLY = process.argv.includes("--check");

const ROOT = "packages/adapter-utils/src";

/** file -> describe-name prefixes to gate. Derived from the Windows failure log. */
const GATE = {
  "execution-target-sandbox.test.ts": ["sandbox adapter execution targets"],
  "acpx-engine/execute.test.ts": [
    "ACPX engine Claude skill bundle staging",
    "ACPX engine per-step startup timing",
    "ACPX engine remote managed-home seam",
    "ACPX engine remote sandbox staging seam",
    "ACPX engine remote session-lifecycle re-staging",
    "ACPX engine run lifecycle corrections (F1",
    "ACPX engine run lifecycle corrections (F3",
    "ACPX engine sandbox bridge run-disposition seam",
    "ACPX engine sandbox-start spans",
    "ACPX startup handshake guard",
    "gemini ACP flag selection",
    "shared ACPX engine runtime behavior",
  ],
  "sandbox-managed-runtime.test.ts": [
    "sandbox git-bundle export transport",
    "sandbox managed runtime inbound coordinator",
    "sandbox managed runtime outbound coordinator",
    // Also matches the two coordinators above by prefix, which is harmless: they
    // are gated either way.
    "sandbox managed runtime",
  ],
  "execution-target-stdin-race.test.ts": [
    "deterministic remote process-session wrapper shutdown",
    "stdin file race",
  ],
  "github-launcher-environment.test.ts": ["managed GitHub launcher environment"],
  "command-managed-runtime.test.ts": ["command managed runtime"],
  "sandbox-callback-bridge.test.ts": ["sandbox callback bridge"],
  "acpx-engine/run-fault-matrix.test.ts": ["composed ACPX run fault matrix"],
  "acpx-engine/startup-characterization.test.ts": ["ACPX engine startup characterization"],
  "sandbox-file-sync.test.ts": ["sandbox native file sync"],
  "acpx-engine/settlement-characterization.test.ts": [
    // Em dash, not hyphen: these titles use U+2014.
    "ACP settlement — Layer A",
    "ACP settlement — Layer B",
    "ACP settlement — Layer C",
  ],
  "github-launcher.test.ts": ["managed GitHub launchers"],
  "git-workspace-sync.test.ts": ["git workspace sync"],
  "remote-managed-runtime.test.ts": ["remote managed runtime"],
  "workspace-restore-merge.test.ts": [
    "conflict-preserving directory restore",
    "workspace restore merge",
  ],
  "acpx-engine/composed-run-characterization.test.ts": [
    "composed ACPX run: engine-boundary result form",
    "composed ACPX run: finalization set fires exactly",
  ],
  "local-process-sandbox.test.ts": ["local process sandbox"],
  "ssh-fixture.test.ts": ["ssh env-lab fixture"],
};

const IMPORT_FROM_SAME_DIR = './test-support/linux-sandbox-gate.js';
const IMPORT_FROM_ACPX = '../test-support/linux-sandbox-gate.js';
const IMPORT_FROM_ADAPTER = '@paperclipai/adapter-utils/test-support/linux-sandbox-gate';

/**
 * Adapter suites that drive the Linux-only sandbox/ACP lane.
 *
 * Same cause as the `adapter-utils` gate: these stage assets "into the sandbox"
 * and shell out through the local transport, so they die at
 * `Failed to start command "sh"`. Grouped by adapter because the import path for
 * the gate differs from the in-package relative one.
 */
const ADAPTER_GATE = {
  "claude-local/src/server/acp.test.ts": ["claude_local ACP lane"],
  "claude-local/src/server/acp.auth.test.ts": [
    "Claude ACP hello probe on local and SSH targets",
  ],
  "claude-local/src/server/acp.quota.test.ts": [
    "recognizes the Claude bridge quota fallback",
    "retains redacted service diagnostics beyond 4 KiB",
    "waits for a typed Claude quota reset",
  ],
  "codex-local/src/server/acp.test.ts": ["codex_local ACP lane"],
  "codex-local/src/server/acp.quota.test.ts": ["waits for a typed Codex quota reset"],
  "codex-local/src/server/codex-auth-merge.test.ts": [
    "codex home auth merge on sandbox asset extract",
  ],
  "codex-local/src/server/codex-home.test.ts": ["stageCodexHomeForSync"],
  "codex-local/src/server/codex-auth-copyback.test.ts": [
    "copyBackCodexAuth",
    "copyBackCodexAuth identity-keyed cache write",
  ],
  "codex-local/src/server/execute.test.ts": [
    // Em dash, not hyphen: the title uses U+2014.
    "codex execute — outbound auth copy-back restore contribution",
  ],
  "gemini-local/src/server/acp.test.ts": ["gemini_local ACP lane"],
  "cursor-local/src/server/execute.test.ts": ["cursor execute"],
  "cursor-local/src/server/remote-command.test.ts": ["prepareCursorSandboxCommand"],
  "cursor-local/src/server/test.test.ts": ["cursor testEnvironment"],
};

const ADAPTER_ROOT = "packages/adapters";

/**
 * Top-level `it.each` blocks that drive the sandbox lane.
 *
 * These are not inside a `describe`, so the describe-level gate cannot reach them.
 * Entries are 1-based indices of the `it.each(` occurrence within the file, taken
 * from the failure log. Index rather than title because the title is passed as a
 * `title` variable inside each block, so there is no literal to match on.
 */
const IT_EACH_GATE = {
  "claude-local/src/server/acp.quota.test.ts": [1, 2, 3],
  "codex-local/src/server/acp.quota.test.ts": [1],
};

let changedFiles = 0;
const problems = [];

/**
 * Adds the gate import and the local `describeLinuxSandbox` const, once.
 *
 * The const is anchored immediately before the first top-level `describe`, not
 * after the import block: some files interleave imports with code, and a `const`
 * used above its declaration is a temporal-dead-zone error that a text search
 * will not catch and only fails at run time.
 */
const insert = (src, rel, importLine) => {
  if (src.includes("isLinuxSandboxHost")) return src;

  const lines = src.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^import .*;$/.test(lines[i].trim()) || /^} from ".*";$/.test(lines[i].trim())) lastImport = i;
    if (lines[i].trim() === "") break;
  }
  lines.splice(lastImport + 1, 0, importLine, "");
  src = lines.join("\n");

  const decl = [
    "// The local sandbox transport is Linux-only: it hands POSIX shell scripts to `sh`",
    "// (`rm -rf`, `xargs`, `tar`, `chmod`), so these suites cannot run on Windows or macOS.",
    "// See adapter-utils/src/test-support/linux-sandbox-gate.ts. CI runs them on Linux.",
    "const describeLinuxSandbox = isLinuxSandboxHost ? describe : describe.skip;",
    "",
    "",
  ].join("\n");
  const firstGate = src.search(/^describe(LinuxSandbox)?\(/m);
  if (firstGate === -1) {
    problems.push(`${rel}: no top-level describe to anchor the gate declaration`);
    return src;
  }
  return src.slice(0, firstGate) + decl + src.slice(firstGate);
};

for (const [rel, prefixes] of Object.entries(GATE)) {
  const file = `${ROOT}/${rel}`;
  const importSpecifier = rel.startsWith("acpx-engine/")
    ? IMPORT_FROM_ACPX
    : IMPORT_FROM_SAME_DIR;
  let src = readFileSync(file, "utf8");
  const original = src;
  const hits = [];

  for (const prefix of prefixes) {
    // Match the describe() call by its literal title, not by a loose substring,
    // so an unrelated describe that happens to contain the words is untouched.
    const re = new RegExp(`(\\b)describe(\\(\\s*)(["'\`])(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g");
    const before = src;
    src = src.replace(re, (_m, word, args, q) => `${word}describeLinuxSandbox${args}${q}${prefix}`);
    if (src !== before) hits.push(prefix);
    else problems.push(`${rel}: no describe matched prefix "${prefix}"`);
  }

  if (src === original) continue;

  src = insert(src, rel, `import { isLinuxSandboxHost } from "${importSpecifier}";`);

  if (!CHECK_ONLY) writeFileSync(file, src, "utf8");
  changedFiles += 1;
  console.log(`${CHECK_ONLY ? "would gate" : "gated"} ${rel}: ${hits.length}/${prefixes.length} describe(s)`);
  for (const h of hits) console.log(`    - ${h}`);
}

for (const [rel, prefixes] of Object.entries(ADAPTER_GATE)) {
  const file = `${ADAPTER_ROOT}/${rel}`;
  let src = readFileSync(file, "utf8");
  const original = src;
  const hits = [];

  for (const prefix of prefixes) {
    const re = new RegExp(`(\\b)describe(\\(\\s*)(["'\`])(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g");
    const before = src;
    src = src.replace(re, (_m, word, args, q) => `${word}describeLinuxSandbox${args}${q}${prefix}`);
    if (src !== before) hits.push(prefix);
    else problems.push(`${rel}: no describe matched prefix "${prefix}"`);
  }

  if (src === original) continue;

  src = insert(src, rel, `import { isLinuxSandboxHost } from "${IMPORT_FROM_ADAPTER}";`);

  if (!CHECK_ONLY) writeFileSync(file, src, "utf8");
  changedFiles += 1;
  console.log(`${CHECK_ONLY ? "would gate" : "gated"} adapters/${rel}: ${hits.length}/${prefixes.length} describe(s)`);
  for (const h of hits) console.log(`    - ${h}`);
}

for (const [rel, indices] of Object.entries(IT_EACH_GATE)) {
  const file = `${ADAPTER_ROOT}/${rel}`;
  let src = readFileSync(file, "utf8");
  const original = src;
  const hits = [];

  // Walk the occurrences in REVERSE index order. Each rewrite lengthens the
  // source (`it.each(` -> `itLinuxSandbox.each(`), so replacing a low index first
  // would shift every later offset and corrupt the file. Going backwards keeps
  // the remaining offsets valid.
  const re = /(\b)it\.each\(/g;
  const matches = [...src.matchAll(re)];
  for (const index of [...indices].sort((a, b) => b - a)) {
    const m = matches[index - 1];
    if (!m) {
      problems.push(`${rel}: no it.each at index ${index} (found ${matches.length})`);
      continue;
    }
    const at = m.index;
    src =
      src.slice(0, at) +
      `${m[1]}itLinuxSandbox.each(` +
      src.slice(at + m[0].length);
    hits.push(index);
  }

  if (src === original) continue;

  src = insert(src, rel, `import { isLinuxSandboxHost } from "${IMPORT_FROM_ADAPTER}";`);

  // The insert() anchor looks for a top-level describe, which these files lack.
  if (!src.includes("const itLinuxSandbox =")) {
    const decl = [
      "// The local sandbox transport is Linux-only: it hands POSIX shell scripts to `sh`",
      "// (`rm -rf`, `xargs`, `tar`, `chmod`), so these suites cannot run on Windows or macOS.",
      "// See adapter-utils/src/test-support/linux-sandbox-gate.ts. CI runs them on Linux.",
      "const itLinuxSandbox = isLinuxSandboxHost ? it : it.skip;",
      "",
      "",
    ].join("\n");
    // These files have no top-level describe, so anchor on the first it.each.
    const firstGate = src.search(/^it(LinuxSandbox)?\.each\(/m);
    if (firstGate === -1) problems.push(`${rel}: no top-level it.each to anchor itLinuxSandbox`);
    else src = src.slice(0, firstGate) + decl + src.slice(firstGate);
  }

  if (!CHECK_ONLY) writeFileSync(file, src, "utf8");
  changedFiles += 1;
  console.log(`${CHECK_ONLY ? "would gate" : "gated"} adapters/${rel}: it.each #${hits.join(", #")}`);
}

console.log(`\n${changedFiles} file(s) ${CHECK_ONLY ? "would change" : "changed"}.`);
if (problems.length > 0) {
  console.log("\nUnmatched prefixes (investigate):");
  for (const p of problems) console.log(`  ! ${p}`);
  process.exitCode = 1;
}
