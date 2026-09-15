# GitHub Copilot validation worker

Serviço Node.js isolado que executa apenas duas operações:

- `GET /health` faz `PING` e um `SET NX PX` efémero no replay store, devolvendo
  `200 {"status":"ok"}` ou `503 {"status":"unavailable"}` sem versão ou
  detalhes internos;
- `POST /v1/copilot/validate` autentica um pedido HMAC e usa
  `@github/copilot-sdk@1.0.13` para `start()` + sessão efémera +
  `session.rpc.model.list({})` + cleanup + `stop()`.

Não aceita prompts, tools ou pedidos de browser. O runtime usa
`mode: "empty"`, `useLoggedInUser: false`, log level `none` e um diretório
temporário `0700` removido no fim. Cada validação cria uma sessão request-bound
sem modelo, prompt, tools, MCP, agents, skills, memory, telemetry ou session
store; `denyAllPermissions` rejeita qualquer permission request inesperada.

`auth.getStatus` não é usado como precondição: pode continuar `false` antes de
o runtime consumir o token. Depois de `client.start()`, o adapter passa
`gitHubToken` exclusivamente a `createSession`, omite `model`, chama a API
pública tipada `session.rpc.model.list({})` e devolve `result.list`. Esta RPC
usa o auth/integration context da sessão e é a validação autoritativa da
identidade, entitlement, política e modelos. Em `finally`, o worker executa
`session.disconnect()` + `client.deleteSession(sessionId)`; `client.stop()` e a
remoção do diretório temporário permanecem como cleanup final. O SDK 1.0.13 não tipa uma
categoria de erro específica para `models.list`; quando `ResponseError.data`
traz `code`/status estruturados, estes têm prioridade. Um `ResponseError` sem
categoria só é classificado como `invalid_token` quando contém a combinação
conhecida `code=-32603` + `Not authenticated`; mensagens remotas em bruto não
são devolvidas nem registadas.

Se a classificação final continuar `unknown`, o worker emite uma única linha
JSON interna e inclui o mesmo objeto já sanitizado no campo opcional
`diagnostic` da resposta de validação:

```json
{
  "event": "copilot_validation_unknown_error",
  "requestId": "<uuid>",
  "error": {
    "constructor": "ResponseError",
    "name": "ResponseError",
    "stringCodes": [],
    "numericCodes": [-32603],
    "statuses": [],
    "message": "<redacted, max 240 chars>"
  }
}
```

Cada lista tem no máximo oito itens e nomes/códigos têm no máximo 64
caracteres allowlisted. A mensagem remove tokens GitHub, URLs, auth headers,
valores secretos, conteúdo quoted/payloads e sequências de alta entropia. O
diagnóstico nunca lê ou inclui stack, erro raw, request body, token ou
environment.

O BFF preserva este campo exclusivamente na resposta autenticada
`POST /api/admin/llm-accounts/:id/validate` do proprietário. O campo não é
persistido, não aparece em `GET /api/admin/llm-accounts` e não é renderizado
por omissão na UI. Respostas com qualquer outro `code` rejeitam
contratualmente um campo `diagnostic`.

O token chega apenas no body HTTPS assinado e é entregue ao SDK em memória
como `SessionConfig.gitHubToken`; nunca é usado em URL, log, erro, ficheiro ou
telemetria da aplicação. O ambiente do child process é uma allowlist que
exclui o token, o segredo HMAC e quaisquer chaves Supabase/cifragem.

## Executar

```bash
npm ci
npm test
npm start
```

Variáveis:

| Variável                          | Obrigatória | Regra                                             |
| --------------------------------- | ----------- | ------------------------------------------------- |
| `COPILOT_WORKER_HMAC_SECRET`      | sim         | base64 canónico de 32–64 bytes; igual no BFF      |
| `PORT`                            | não         | `3000` por omissão; Vercel injeta `$PORT`         |
| `COPILOT_VALIDATION_TIMEOUT_MS`   | não         | 1–15 s, omissão 15 s                              |
| `COPILOT_WORKER_CLOCK_SKEW_MS`    | não         | 5–120 s, omissão 30 s                             |
| `COPILOT_WORKER_MAX_CONCURRENCY`  | não         | 1–8, omissão 2                                    |
| `COPILOT_WORKER_MAX_QUEUE`        | não         | 0–100, omissão 8                                  |
| `COPILOT_REPLAY_REDIS_URL`        | produção    | URL `redis://`/`rediss://` de um store partilhado |
| `COPILOT_REPLAY_REDIS_PREFIX`     | não         | prefixo isolado das nonces                        |
| `COPILOT_REPLAY_STORE_TIMEOUT_MS` | não         | timeout Redis, omissão 1 s                        |

O BFF aceita 25–60 s (`COPILOT_WORKER_TIMEOUT_MS`, 30 s por omissão) e o worker
aceita no máximo 15 s. A margem mínima de dez segundos cobre cleanup e
latência da resposta.

Teste real, sempre opt-in:

```bash
COPILOT_REAL_TEST_TOKEN=github_pat_... npm run test:real
```

O comando só apresenta o código sanitizado ou o número de modelos. CI usa um
adapter mock e nunca consome Copilot real.

## Deploy

Construir a partir desta pasta:

```bash
docker build -f Dockerfile.vercel .
```

Não configurar `SUPABASE_SERVICE_ROLE_KEY`,
`LLM_CREDENTIAL_ENCRYPTION_KEY` ou credenciais de utilizador no serviço. Para
Vercel Services, consultar `deploy/vercel.services.example.json` e a secção de
deploy no README raiz antes de ativar o preset. O processo falha fechado no
arranque se detetar a service role, a chave AES ou a anon key do Supabase, ou
se produção não tiver Redis partilhado. Local/teste usam replay store em
memória; produção usa `SET NX PX`, com TTL igual ao restante período de
validade da assinatura. O cliente Redis partilha uma única tentativa de
reconexão entre pedidos concorrentes e usa backoff exponencial limitado a cinco
tentativas, com teto de dois segundos e jitter; qualquer falha continua
fail-closed. Configure `/health` como readiness do orchestrator. O
`Dockerfile.vercel` inclui um `HEALTHCHECK` equivalente.
