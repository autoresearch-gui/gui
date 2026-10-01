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

let changedFiles = 0;
const problems = [];

for (const [rel, prefixes] of Object.entries(GATE)) {
  const file = `${ROOT}/${rel}`;
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

  if (!src.includes("isLinuxSandboxHost")) {
    // Insert the import after the final top-level import statement.
    const importLine = rel.startsWith("acpx-engine/")
      ? `import { isLinuxSandboxHost } from "${IMPORT_FROM_ACPX}";`
      : `import { isLinuxSandboxHost } from "${IMPORT_FROM_SAME_DIR}";`;
    const lines = src.split("\n");
    let lastImport = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^import .*;$/.test(lines[i].trim()) || /^} from ".*";$/.test(lines[i].trim())) lastImport = i;
      if (lines[i].trim() === "") break;
    }
    lines.splice(lastImport + 1, 0, importLine, "");
    src = lines.join("\n");

    // Declare the local const immediately before the first gated (or top-level)
    // describe. Placing it after the import block is not enough: some files have
    // imports interleaved with code, and a `const` used above its declaration is a
    // temporal-dead-zone error that only shows up at run time.
    const decl = [
      "// The local sandbox transport is Linux-only: it hands POSIX shell scripts to `sh`",
      "// (`rm -rf`, `xargs`, `tar`, `chmod`), so these suites cannot run on Windows or macOS.",
      "// See ./test-support/linux-sandbox-gate.ts. CI runs them on Linux.",
      "const describeLinuxSandbox = isLinuxSandboxHost ? describe : describe.skip;",
      "",
      "",
    ].join("\n");
    const firstGate = src.search(/^describe(LinuxSandbox)?\(/m);
    if (firstGate === -1) {
      problems.push(`${rel}: no top-level describe to anchor the gate declaration`);
    } else {
      src = src.slice(0, firstGate) + decl + src.slice(firstGate);
    }
  }

  if (!CHECK_ONLY) writeFileSync(file, src, "utf8");
  changedFiles += 1;
  console.log(`${CHECK_ONLY ? "would gate" : "gated"} ${rel}: ${hits.length}/${prefixes.length} describe(s)`);
  for (const h of hits) console.log(`    - ${h}`);
}

console.log(`\n${changedFiles} file(s) ${CHECK_ONLY ? "would change" : "changed"}.`);
if (problems.length > 0) {
  console.log("\nUnmatched prefixes (investigate):");
  for (const p of problems) console.log(`  ! ${p}`);
  process.exitCode = 1;
}
