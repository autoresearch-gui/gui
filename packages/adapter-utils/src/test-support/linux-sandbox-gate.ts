/**
 * Whether this host can run the Linux-only local sandbox.
 *
 * `buildLocalProcessSandboxSpawnTarget` refuses any non-Linux host outright:
 *
 *   Local process filesystem and network scopes are currently supported only on Linux.
 *
 * That transport is implemented by handing POSIX shell scripts to `sh` (`rm -rf`,
 * `xargs -0`, `chmod 700`, `tar`), so it is Linux-only by construction rather than
 * by oversight. Tests that exercise it through the local harness therefore cannot
 * pass on Windows or macOS: they die at `Failed to start command "sh"`, which says
 * nothing about the code under test.
 *
 * Those suites are gated to Linux instead of being left red there, for two reasons.
 * A permanently red suite on a supported dev platform trains people to ignore the
 * runner, which is how real regressions get missed. And CI runs Linux, so the
 * coverage is not lost - it is enforced where the subsystem actually runs.
 *
 * The trade this makes is explicit: on Windows these subsystems go uncovered, so a
 * Windows-specific defect in the code they share would not be caught by this gate.
 * That is the honest cost of a Linux-only transport, and it is why this module
 * warns once instead of skipping silently.
 *
 * Usage in a test file, following the existing `describeLinux` convention:
 *
 *   import { isLinuxSandboxHost } from "./test-support/linux-sandbox-gate.js";
 *   const describeLinuxSandbox = isLinuxSandboxHost ? describe : describe.skip;
 *
 * The const stays local to the test file on purpose: `describe.skip` carries a
 * chainable type that cannot be named, so exporting it directly fails
 * declaration emit with TS4023.
 */
export const isLinuxSandboxHost = process.platform === "linux";

export const LINUX_SANDBOX_GATE_REASON =
  "[adapter-utils] skipped off Linux: the local sandbox transport runs POSIX shell " +
  "scripts (`sh -c`, rm/xargs/tar/chmod) and is Linux-only by construction. " +
  "These suites are enforced in CI on Linux.";

if (!isLinuxSandboxHost) {
  console.warn(LINUX_SANDBOX_GATE_REASON);
}
