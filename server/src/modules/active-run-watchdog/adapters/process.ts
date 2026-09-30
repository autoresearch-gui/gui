import { runningProcesses } from "../../../adapters/utils.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../../../services/local-service-supervisor.js";
import type { RunProcessController } from "../application/ports.js";
import type { RunProcessCleanupOutcome, RunProcessMetadata } from "../application/types.js";

// Membership answers one question only: is this run's provider a local child
// process that Paperclip owns and must terminate? The eight sessioned CLI
// adapters qualify because they spawn their provider locally, and so does
// `process`, whose child is registered in `runningProcesses` by
// runChildProcess and whose pid/group reach the run row through `onSpawn`.
// Session resumability is irrelevant here and `process` has none, so the set is
// named for the property it actually gates. Adapters that are sessioned but
// not local (`cursor_cloud`) stay out, and remote gateways stay out because
// there is no local pid to signal.
const LOCAL_CHILD_PROCESS_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
  "process",
]);

function isValidPositivePid(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function createProcessAdapter(): RunProcessController {
  return {
    async cleanupRunProcess(input: RunProcessMetadata): Promise<RunProcessCleanupOutcome> {
      if (!LOCAL_CHILD_PROCESS_ADAPTERS.has(input.adapterType)) {
        return { attempted: false, outcome: "skipped_non_local_adapter", adapterType: input.adapterType };
      }

      const running = runningProcesses.get(input.runId);
      const registeredPid = running?.child.pid ?? null;
      const registeredProcessGroupId = running?.processGroupId ?? null;
      const pid = isValidPositivePid(registeredPid)
        ? registeredPid
        : isValidPositivePid(input.fallbackPid)
          ? input.fallbackPid
          : null;
      const processGroupId = isValidPositivePid(registeredProcessGroupId)
        ? registeredProcessGroupId
        : isValidPositivePid(input.fallbackProcessGroupId)
          ? input.fallbackProcessGroupId
          : null;
      const terminationPid = pid ?? processGroupId;
      if (terminationPid === null) {
        return { attempted: false, outcome: "no_process_metadata", adapterType: input.adapterType };
      }

      const wasAlive =
        (pid !== null && isPidAlive(pid)) ||
        (processGroupId !== null && isProcessGroupAlive(processGroupId));
      if (!wasAlive) {
        runningProcesses.delete(input.runId);
        return { attempted: false, outcome: "not_running", adapterType: input.adapterType, pid, processGroupId };
      }

      try {
        await terminateLocalService(
          {
            pid: terminationPid,
            processGroupId,
          },
          running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
        );
        runningProcesses.delete(input.runId);
        const stillAlive =
          (pid !== null && isPidAlive(pid)) ||
          (processGroupId !== null && isProcessGroupAlive(processGroupId));
        return {
          attempted: true,
          outcome: stillAlive ? "termination_sent_still_running" : "terminated",
          adapterType: input.adapterType,
          pid,
          processGroupId,
        };
      } catch (error) {
        return {
          attempted: true,
          outcome: "failed",
          adapterType: input.adapterType,
          pid,
          processGroupId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
