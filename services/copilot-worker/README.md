# GitHub Copilot validation worker

Serviço Node.js isolado que expõe apenas duas operações HTTP:

- `GET /health` faz `PING` e um `SET NX PX` efémero no replay store, devolvendo
  `200 {"status":"ok"}` ou `503 {"status":"unavailable"}` sem versão ou
  detalhes internos;
- `POST /v1/copilot/validate` autentica um pedido HMAC e usa
  `@github/copilot-sdk@1.0.14` (Copilot CLI 1.0.85) para `start()` + sessão
  efémera + `session.rpc.model.list({})` +
  `client.rpc.account.getQuota({ gitHubToken })` + cleanup + `stop()`.

Não aceita prompts, tools ou pedidos de browser. O runtime usa
`mode: "empty"`, `useLoggedInUser: false`, log level `none` e um diretório
temporário `0700` removido no fim. Cada validação cria uma sessão request-bound
sem modelo, prompt, tools, MCP, agents, skills, memory, telemetry ou session
store; `denyAllPermissions` rejeita qualquer permission request inesperada.

`auth.getStatus` não é usado como precondição: pode continuar `false` antes de
o runtime consumir o token. Depois de `client.start()`, o adapter passa
`gitHubToken` apenas às duas operações oficiais que o necessitam:
`createSession` para `session.rpc.model.list({})` e `account.getQuota` para a
quota da mesma conta. A primeira RPC usa o auth/integration context da sessão e
é a validação autoritativa da identidade, entitlement, política e modelos. Em
`finally`, o worker executa
`session.disconnect()` + `client.deleteSession(sessionId)`; `client.stop()` e a
remoção do diretório temporário permanecem como cleanup final. O SDK 1.0.14 não tipa uma
categoria de erro específica para `models.list`; quando `ResponseError.data`
traz `code`/status estruturados, estes têm prioridade. Um `ResponseError` sem
categoria só é classificado como `invalid_token` quando contém a combinação
conhecida `code=-32603` + `Not authenticated`, ou a falha explícita de
autenticação da sessão com `401 Unauthorized`; mensagens remotas em bruto não
são devolvidas nem registadas.

`account.getQuota` é uma API oficial mas experimental do SDK pinned. O worker
consome apenas `quotaSnapshots.premium_interactions`, valida todos os campos e
devolve uma allowlist local denominada `premium_requests`. Entitlements
ilimitados não incluem total/restante/percentagem finitos; quotas ausentes,
malformadas ou indisponíveis devolvem apenas um código categórico fixo. Esta
falha nunca transforma um catálogo válido numa falha de credencial. O BFF pode
preservar o último snapshot como stale, sem persistir raw errors, bodies,
headers ou token.

Existe um único probe de diagnóstico para a combinação exata
`code=-32603` + `SDK session authentication failed: network fetch failed:
request failed: builder error`. O worker faz `GET https://api.github.com/user`
com URL, `Accept` e `User-Agent` fixos, `redirect: "error"` e o mesmo
`AbortSignal` do prazo global. Só consulta o status: nunca lê body ou headers.
`200` mantém `unknown` e acrescenta ao diagnóstico seguro
`GITHUB_CREDENTIAL_PROBE_SUCCEEDED`; `401` produz `invalid_token`; `403`
mantém `unknown` com `GITHUB_CREDENTIAL_PROBE_FORBIDDEN`; qualquer outro
status inconclusivo usa `GITHUB_CREDENTIAL_PROBE_UNEXPECTED_STATUS`. Os
diagnósticos usam mensagens fixas e não incluem status, body ou headers.
Timeout, rate limit, erro de rede e `5xx` permanecem falhas transitórias.
Nenhum outro erro ativa este probe.

Os outcomes `200`, `403` e status inconclusivo usam o shape literal
`copilot_validation_probe_unknown` com apenas `requestId`, `code` e `message`.
Não são inseridos em `error.stringCodes`: essa lista mantém a deteção
anti-segredo para códigos remotos não confiáveis.

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

Quando o probe exato falha de forma transitória, `code` continua
`unavailable`, mas pode transportar apenas um diagnóstico estrito com
`event = copilot_validation_probe_unavailable` e um destes códigos/mensagens
fixos:

- `GITHUB_CREDENTIAL_PROBE_NETWORK_ERROR` /
  `github credential probe could not reach GitHub`;
- `GITHUB_CREDENTIAL_PROBE_RATE_LIMITED` /
  `github credential probe was rate limited`;
- `GITHUB_CREDENTIAL_PROBE_GITHUB_UNAVAILABLE` /
  `github credential probe found GitHub unavailable`.

Só o primeiro pode incluir `causeCode`, limitado a `ENOTFOUND`, `EAI_AGAIN`,
`ECONNRESET`, `ETIMEDOUT`, `CERT_HAS_EXPIRED`,
`SELF_SIGNED_CERT_IN_CHAIN` ou `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. O
diagnóstico não contém status, body, headers ou detalhe remoto.

O cliente BFF distingue separadamente falhas no transporte até ao worker. O
contrato efémero aceita apenas `WORKER_AUTH_REJECTED`, `WORKER_RATE_LIMITED`,
`WORKER_HTTP_UNAVAILABLE`, `WORKER_HTTP_ERROR`, `WORKER_NETWORK_ERROR`,
`WORKER_INVALID_RESPONSE` ou `WORKER_TIMEOUT`, sempre com mensagens literais.
Só `WORKER_NETWORK_ERROR` pode incluir um `causeCode` da mesma allowlist curta
acima. Nenhum diagnóstico BFF contém status numérico, URL, body, headers ou
erro raw; uma indisponibilidade genérica fora deste cliente continua sem
diagnóstico.

O servidor acompanha internamente as fases `receiving_body`, `authenticating`,
`parsing_request`, `validating`, `validating_response` e `writing_response`.
Só depois de autenticação HMAC e payload válidos uma exceção interna pode
originar HTTP 200 com `code = unavailable` e o diagnóstico literal
`copilot_worker_internal_error` / `WORKER_INTERNAL_FAILURE` /
`copilot worker failed internally`, acrescido apenas da fase. Antes disso,
mantém respostas HTTP genéricas sem diagnóstico para não criar um oracle. Uma
falha ao escrever a resposta fecha a ligação e apenas regista o objeto fixo.

Cada lista tem no máximo oito itens e nomes/códigos têm no máximo 64
caracteres allowlisted. A mensagem remove tokens GitHub, URLs, auth headers,
valores secretos, conteúdo quoted/payloads e sequências de alta entropia. O
diagnóstico nunca lê ou inclui stack, erro raw, request body, token ou
environment.

O BFF preserva este campo exclusivamente na resposta autenticada
`POST /api/admin/llm-accounts/:id/validate` do proprietário. O campo não é
persistido, não aparece em `GET /api/admin/llm-accounts` e não é renderizado
por omissão na UI. `unknown` aceita apenas o diagnóstico genérico redigido ou
o diagnóstico literal do probe; `unavailable` aceita apenas o diagnóstico
transitório do probe ou o erro interno por fase. Os restantes códigos rejeitam
contratualmente o campo no protocolo worker. No BFF, `unknown`, `unavailable`
e `timeout` aceitam apenas a variante de transporte compatível com o respetivo
código.

O token chega apenas no body HTTPS assinado e é entregue ao SDK em memória
como `SessionConfig.gitHubToken` e `AccountGetQuotaRequest.gitHubToken`; nunca
é usado em URL, log, erro, ficheiro ou telemetria da aplicação. O ambiente do
child process é uma allowlist que
contém apenas os diretórios `HOME`/`TMP*` isolados, `PATH` quando definido e
`SystemRoot` apenas em Windows. Variáveis `HTTP_PROXY`, `HTTPS_PROXY`,
`NO_PROXY`, `NODE_EXTRA_CA_CERTS` e `SSL_CERT_*` não são herdadas pelo runtime
nativo, nem são criadas chaves com valor `undefined`.

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

O stage runtime instala explicitamente `ca-certificates` antes de mudar para
`USER node`. O CI constrói a imagem e exige que
`/etc/ssl/certs/ca-certificates.crt` exista e não esteja vazio; o runtime
nativo Rust necessita deste trust store mesmo quando o `fetch` do processo
Node funciona.

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
