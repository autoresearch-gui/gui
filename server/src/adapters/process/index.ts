import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  runtimeToolDelivery: "environment",
  execute,
  testEnvironment,
  models: [],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- injectApiKey (boolean, optional, default true): when false, the child receives
  neither PAPERCLIP_API_KEY (the run-scoped agent JWT) nor any
  PAPERCLIP_RUNTIME_TOOLS_* key (the runtime connection tools bearer token and
  its endpoints). Set it to false whenever the command runs code an AI agent
  wrote, because both credentials are company-scoped write access and the code
  could use them to rewrite its own run history. The flag covers both
  credentials; there is no way to inject one without the other.

  This adapter has no getConfigSchema, and the adapter config-schema endpoint
  answers 404 without one, so the field cannot be set from the agent
  configuration form. Seed adapterConfig.injectApiKey programmatically instead,
  from the CLI or the server. A value that is absent, or any value other than
  the boolean false, leaves credential injection enabled.
`,
};
