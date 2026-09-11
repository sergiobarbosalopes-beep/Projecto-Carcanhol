import "server-only";

import {
  encryptLlmCredential,
  type LlmCredentialContext,
} from "@/src/security/llm-credential-crypto";
import { getServerEnv } from "@/src/utils/env";

export function encryptCredentialForStorage(
  credential: string,
  context: LlmCredentialContext
) {
  const {
    LLM_CREDENTIAL_ENCRYPTION_KEY,
    LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION,
  } = getServerEnv();

  return encryptLlmCredential(
    credential,
    LLM_CREDENTIAL_ENCRYPTION_KEY,
    LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION,
    context
  );
}
