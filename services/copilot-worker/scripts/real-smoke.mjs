import { randomUUID } from "node:crypto";
import { createCopilotSdkRuntime } from "../dist/copilot-adapter.js";
import { validateCopilotCredential } from "../dist/runtime.js";

const token = process.env.COPILOT_REAL_TEST_TOKEN;

if (!token) {
  console.error("COPILOT_REAL_TEST_TOKEN is required for this opt-in test.");
  process.exitCode = 2;
} else {
  const result = await validateCopilotCredential({
    token,
    requestId: randomUUID(),
    timeoutMs: 30_000,
    createRuntime: createCopilotSdkRuntime,
  });

  if (!result.ok) {
    console.error(
      `Copilot validation failed with sanitized code: ${result.code}`
    );
    process.exitCode = 1;
  } else {
    console.info(
      `Copilot validation returned ${result.models.length} model(s).`
    );
  }
}
