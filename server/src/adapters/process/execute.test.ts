import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    })),
  };
});

const { runChildProcess } = await import("../utils.js");
const { execute } = await import("./execute.js");

const mockedRunChildProcess = vi.mocked(runChildProcess);

const RUNTIME_TOOLS = {
  version: 1 as const,
  guidance: "ask a human before connecting",
  mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
  rest: {
    connectionsSearch: "https://paperclip.test/runtime-tools/connections/search",
    connectionRequest: "https://paperclip.test/runtime-tools/connection/request",
  },
  bearerToken: "runtime-tools-token",
  expiresAt: "2026-08-26T15:00:00.000Z",
  tools: ["connections_search", "connection_request"],
};

function childEnv(): Record<string, string> {
  const call = mockedRunChildProcess.mock.calls.at(-1);
  if (!call) throw new Error("runChildProcess was not called");
  return call[3].env;
}

function makeCtx(
  overrides: Partial<AdapterExecutionContext> & { config?: Record<string, unknown> } = {},
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Trainer",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    context: {},
    authToken: "run-scoped-agent-jwt",
    runtimeTools: RUNTIME_TOOLS,
    onLog: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("process adapter execute", () => {
  beforeEach(() => {
    mockedRunChildProcess.mockClear();
  });

  describe("injectApiKey", () => {
    it("suppresses both live credentials when the flag is false", async () => {
      await execute(
        makeCtx({ config: { command: "train.py", injectApiKey: false } }),
      );

      const env = childEnv();
      expect(env.PAPERCLIP_API_KEY).toBeUndefined();
      expect(
        Object.keys(env).filter((key) => key.startsWith("PAPERCLIP_RUNTIME_TOOLS_")),
      ).toEqual([]);
      // The non-secret identity context must survive, or the executor cannot
      // attribute the experiment.
      expect(env.PAPERCLIP_AGENT_ID).toBe("agent-1");
      expect(env.PAPERCLIP_COMPANY_ID).toBe("company-1");
      expect(env.PAPERCLIP_RUN_ID).toBe("run-1");
    });

    it("injects both credentials when the flag is absent", async () => {
      await execute(makeCtx({ config: { command: "train.py" } }));

      const env = childEnv();
      expect(env.PAPERCLIP_API_KEY).toBe("run-scoped-agent-jwt");
      expect(env.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBe("runtime-tools-token");
      expect(env.PAPERCLIP_RUNTIME_TOOLS_MCP_URL).toBe(RUNTIME_TOOLS.mcpEndpoint);
    });

    it("injects both credentials when the flag is explicitly true", async () => {
      await execute(
        makeCtx({ config: { command: "train.py", injectApiKey: true } }),
      );

      const env = childEnv();
      expect(env.PAPERCLIP_API_KEY).toBe("run-scoped-agent-jwt");
      expect(env.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBe("runtime-tools-token");
    });

    it("never lets config env reintroduce a suppressed credential", async () => {
      await execute(
        makeCtx({
          config: {
            command: "train.py",
            injectApiKey: false,
            env: { PAPERCLIP_API_KEY: "smuggled" },
          },
        }),
      );

      expect(childEnv().PAPERCLIP_API_KEY).toBeUndefined();
    });
  });

  it("forwards the run-scoped cancellation signal to the child", async () => {
    const controller = new AbortController();

    await execute(makeCtx({ signal: controller.signal }));

    expect(mockedRunChildProcess.mock.calls.at(-1)?.[3].signal).toBe(
      controller.signal,
    );
  });

  it("settles a cancellation as a reported abort instead of throwing", async () => {
    mockedRunChildProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      stdout: "epoch 1",
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    });

    const result: AdapterExecutionResult = await execute(
      makeCtx({ signal: AbortSignal.abort() }),
    );

    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBe("Run cancelled before the process finished");
    expect(result.resultJson).toMatchObject({ stdout: "epoch 1", aborted: true });
  });

  it("keeps the timeout and exit-code outcomes unchanged", async () => {
    mockedRunChildProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    await expect(
      execute(makeCtx({ config: { command: "train.py", timeoutSec: 660 } })),
    ).resolves.toMatchObject({ timedOut: true, errorMessage: "Timed out after 660s" });

    mockedRunChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Traceback",
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    await expect(
      execute(makeCtx({ config: { command: "train.py" } })),
    ).resolves.toMatchObject({
      timedOut: false,
      errorMessage: "Process exited with code 1",
    });
  });
});
