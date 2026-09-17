# Projecto Carcanhol

Aplicação Next.js de apoio à decisão de investimento, preparada para combinar
dados financeiros reais com análise assistida por IA. A arquitetura completa
está em [`docs/architecture.md`](docs/architecture.md).

**Estado atual: Fase 4 — Chat base.** A aplicação inclui
autenticação server-side, navegação protegida, gestão de conta, premissas
globais, Skills manuais e configuração segura de várias contas LLM por
utilizador. Contas GitHub Copilot são autenticadas num worker isolado antes de
serem persistidas, o catálogo de modelos é sincronizado, uma combinação
conta+modelo pode ser escolhida como predefinição global e a utilização
account-wide disponibilizada pelo GitHub Copilot é atualizada através do SDK.
Inclui criação assistida de Skills através do canal de inferência one-shot e
Chat textual persistente por utilizador, com streaming progressivo real,
cancelamento, retry idempotente, seleção de conta/modelo por conversa e Skills
do Carcanhol manuais ou sugeridas com confirmação. Tools e Agentes do
Carcanhol aparecem apenas como estados vazios e não têm opções nem execução.
Capacidades disponibilizadas pelo runtime GitHub Copilot são geridas
automaticamente, sem seleção manual na UI; esta fase não ativa nem promete
novas capacidades built-in. Pesquisa, Análises e dados financeiros continuam
fora do âmbito.

## Stack

- Next.js 16, App Router e TypeScript;
- Tailwind CSS v4, com configuração CSS-first;
- Supabase Auth/Postgres/RLS através de `@supabase/ssr`;
- Zod para validação de ambiente e de todos os inputs BFF.

O projeto Supabase é partilhado. Todos os objetos desta aplicação vivem no
schema `carcanhol`; as migrations não criam tabelas em `public`, não instalam
triggers globais em `auth.users` e não concedem membership automaticamente.

## Funcionalidades da Fase 3A

- Shell responsivo com sidebar recolhível em desktop e drawer acessível em
  ecrãs de telemóvel/tablet;
- navegação para Início, Pesquisa, Chat, Análises e Administração;
- administração numa página com tabs responsivas:
  - **LLM:** validação real, revalidação manual/automática, catálogo identificado
    por fornecedor+conta, predefinição global e utilização account-wide do
    GitHub Copilot; os restantes adapters continuam preparados mas não podem
    ser ativados sem validação real;
  - **Skills:** pesquisa paginada, criação manual, consulta, edição,
    duplicação, ativação, desativação, arquivo, restauro e eliminação
    definitiva reforçada; a criação com IA gera apenas uma proposta editável,
    nunca uma gravação ou ativação automática;
  - **Premissas:** uma versão atual de texto livre das premissas globais, até
    20 000 caracteres;
  - **Conta:** email atual e alteração de palavra-passe via Supabase Auth;
- resolução server-only de Skills `active` para contexto textual delimitado;
- Chat responsivo com conversas RLS, rename/delete cascade, respostas
  progressivas canceláveis e estados completos/cancelados/falhados explícitos;
- seletor de Skills do Carcanhol por conversa, manual ou automático confirmado,
  e auditoria por resposta com ID, nome, `updated_at` usado como versão e
  SHA-256 do conteúdo; Tools/Agentes do Carcanhol não são executáveis;
- resumo read-only das capacidades GitHub Copilot: o runtime gere
  automaticamente apenas as que estejam disponíveis e sejam compatíveis, sem
  expor internals, permissões ou seleção manual;
- credenciais LLM cifradas no backend com AES-256-GCM e persistidas numa tabela
  separada, acessível apenas à service role.

O browser nunca instancia Supabase. Todas as mutações passam por Route
Handlers BFF same-origin, usam a sessão em cookies `HttpOnly` e derivam o
`user_id` da sessão. Operações normais usam a anon key e ficam sujeitas a RLS;
a service role participa apenas na criação/rotação atómica dos envelopes LLM,
sempre depois de autorização server-side explícita.

## Estrutura

```text
app/
  (protected)/                 Layout e páginas protegidas
    dashboard/
    pesquisa/
    chat/
    analises/
    administracao/
  api/
    auth/                      Login/logout BFF
    account/password/          Alteração de palavra-passe
    admin/premises/            Premissas globais
    admin/skills/              CRUD e lifecycle de Skills
    admin/llm-accounts/        Criação/revalidação e rotação de contas LLM
    llm/infer/                 Probe genérico de inferência one-shot
    chat/                      Conversas, sugestões e stream NDJSON
    admin/skills/generate/     Proposta estruturada de Skill com IA
services/
  copilot-worker/              Runtime SDK isolado, HTTP/HMAC e container
src/
  admin/                       Validação e repositórios server-only
  auth/                        Sessão e membership explícita
  components/                  Shell e componentes leves
  database/                    Clientes Supabase server-only
  http/                        Respostas no-store e proteção same-origin
  middleware/                  Refresh de sessão e redireção antecipada
  security/                    Envelope AES-256-GCM das credenciais LLM
  chat/                        Contratos, persistência e contexto seguro
  types/                       Tipos manuais do schema carcanhol
database/migrations/
  0001_init_carcanhol_schema.sql
  0002_admin_settings_and_skills.sql
  0003_llm_accounts.sql
  0004_github_copilot_provider.sql
  0005_github_copilot_validation.sql
  0006_preserve_transient_validation_catalog.sql
  0007_llm_defaults_and_provider_quota.sql
  0008_llm_inference_default.sql
  0009_chat_base.sql
docs/architecture.md
```

## Configuração local

### Pré-requisitos

- Node.js 22.12–24.x (o container usa Node 24);
- npm;
- projeto Supabase.

### Instalação

1. Instalar as dependências bloqueadas:

   ```bash
   npm ci
   npm ci --prefix services/copilot-worker
   ```

2. Copiar `.env.example` para `.env` e preencher:

   ```dotenv
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   SUPABASE_SCHEMA=carcanhol
   LLM_CREDENTIAL_ENCRYPTION_KEY=base64-for-exactly-32-random-bytes
   LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION=1
   COPILOT_WORKER_URL=https://copilot-worker.internal.example
   COPILOT_WORKER_HMAC_SECRET=base64-for-32-to-64-random-bytes
   COPILOT_WORKER_TIMEOUT_MS=60000
   ```

   O valor normal é `carcanhol`; deployments de preview isolados podem usar
   temporariamente um schema allowlisted com prefixo `carcanhol_`.

   `NEXT_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `LLM_CREDENTIAL_ENCRYPTION_KEY` e `COPILOT_WORKER_HMAC_SECRET` são
   server-only e nunca devem receber o prefixo `NEXT_PUBLIC_`.

   Gere uma chave independente por ambiente e guarde-a apenas no secret
   manager do runtime:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Use este comando separadamente para a chave AES e para o segredo HMAC. Não
   reutilize a service role, uma password ou uma chave de outro ambiente.

3. No SQL Editor do Supabase, aplicar as migrations por ordem:

   1. `database/migrations/0001_init_carcanhol_schema.sql`;
   2. `database/migrations/0002_admin_settings_and_skills.sql`;
   3. `database/migrations/0003_llm_accounts.sql`;
   4. `database/migrations/0004_github_copilot_provider.sql`;
   5. `database/migrations/0005_github_copilot_validation.sql`;
   6. `database/migrations/0006_preserve_transient_validation_catalog.sql`.
   7. `database/migrations/0007_llm_defaults_and_provider_quota.sql`.
   8. `database/migrations/0008_llm_inference_default.sql`.
   9. `database/migrations/0009_chat_base.sql`.

   A segunda migration cria `carcanhol.global_assumptions`,
   `carcanhol.skills`, índices, triggers locais de `updated_at`, a proteção
   contra eliminação de Skills ativas, grants mínimos e policies RLS que
   exigem simultaneamente ownership e membership em `carcanhol.profiles`.
   A terceira cria os metadados de contas, a tabela service-only de envelopes
   cifrados e estruturas futuras para modelos descobertos, routing e eventos
   de utilização. A quarta substitui o fornecedor retirado GitHub Models por
   GitHub Copilot, migra as contas existentes e preserva o provider usado no
   AAD dos envelopes AES-256-GCM já cifrados. A quinta introduz os estados de
   validação real, geração anti-stale, catálogo stale e RPCs service-only
   atómicas para conta+segredo+modelos e para revalidação. A sexta preserva o
   último catálogo e escolhas manuais em falhas transitórias de infraestrutura,
   mantendo a conta bloqueada em `error`. A sétima redefine o antigo
   `enabled` como espelho deprecated, derivado por trigger exclusivamente de
   `is_stale` para compatibilidade, cria a preferência global transacional
   preparada para futuros scopes por funcionalidade e persiste snapshots
   account-wide de quota por provider, sem prompts, respostas ou eventos de
   sessão.
   A oitava adiciona a RPC service-only que volta a confirmar atomicamente a
   predefinição selecionada sob RLS pelo BFF, a conta ativa, a última validação
   bem-sucedida e o modelo não stale antes de devolver o envelope cifrado.
   A nona cria conversas e mensagens próprias com RLS e delete cascade, RPCs
   transacionais/idempotentes para iniciar, repetir e finalizar turnos e a
   resolução service-only do modelo efetivamente escolhido. Não deve ser
   aplicada em produção sem autorização explícita.

4. Em **Project Settings → API → Exposed schemas**, adicionar `carcanhol`.

5. Criar o utilizador em **Authentication → Users**, copiar o UUID e conceder
   membership explícita:

   ```sql
   insert into carcanhol.profiles (id, email)
   values ('UUID', 'EMAIL');
   ```

   Uma conta em `auth.users` sem esta row não pode entrar no Carcanhol.

6. Iniciar:

   ```bash
   npm run dev
   ```

### Credencial e validação do GitHub Copilot

O GitHub Models foi retirado em 30 de julho de 2026 e não é usado. O SDK
GitHub Copilot corre exclusivamente em `services/copilot-worker`, nunca numa
Route Handler Next.js. Criar uma conta executa `start()`, cria uma sessão
efémera com `SessionConfig.gitHubToken` e chama
`session.rpc.model.list({})` antes de gerar o `accountId`, cifrar ou persistir.

Para o onboarding manual:

1. Na conta pessoal do GitHub que tem acesso ao Copilot, criar um
   **fine-grained personal access token**;
2. escolher a conta pessoal como **Resource owner**;
3. conceder a Account permission **Copilot Requests**;
4. definir um prazo curto e guardar o token quando for apresentado, porque só
   fica visível uma vez;
5. introduzir em **Administração → LLM** o token com prefixo `github_pat_`;
6. aguardar por **Ativa**, que exige validação real e pelo menos um modelo.

O valor não é a password, um token Vercel, um token GitHub Models nem um PAT
classic `ghp_`. Falhas de autenticação, entitlement, política, timeout e
catálogo vazio são convertidas em códigos/mensagens locais; respostas remotas
cruas nunca são devolvidas nem persistidas.

Se o runtime devolver exclusivamente a falha conhecida de transporte durante
a autenticação da sessão, o worker faz um probe bounded à URL fixa
`https://api.github.com/user`. Apenas o status é usado: o body e os headers da
resposta não são lidos. Um `200` não afirma entitlement Copilot e mantém o
resultado `unknown`; `401` identifica credencial inválida; `403` permanece
inconclusivo. Outcomes inconclusivos usam apenas códigos e mensagens locais
fixos num shape próprio, sem transportar status, body ou headers e sem
afrouxar a deteção anti-segredo dos erros remotos.

Se o próprio probe falhar, a revalidação mantém `unavailable` e pode devolver
ao proprietário apenas uma categoria fixa de rede, rate limit ou
indisponibilidade GitHub. Só a categoria de rede admite um cause code de uma
allowlist curta; não são transportados status, body, headers ou texto remoto.

O BFF aplica a mesma regra à comunicação com o worker: falhas HTTP, de rede,
timeout ou resposta inválida recebem apenas códigos e mensagens locais fixos.
O diagnóstico é devolvido somente pelo endpoint autenticado de revalidação e
nunca é persistido ou mostrado pela UI.

Depois de autenticação HMAC e parsing válido, uma exceção interna do worker
também regressa como `unavailable` com apenas
`WORKER_INTERNAL_FAILURE`, uma mensagem fixa e a fase allowlisted. Antes da
autenticação não há diagnóstico correlacionado; se falhar a escrita da
resposta, a ligação é encerrada sem tentar emitir outra resposta.

O SDK também suporta tokens de utilizador OAuth `gho_` e GitHub App `ghu_`,
mas estes tipos estão apenas preparados no schema e são rejeitados pelo
formulário manual. OAuth/GitHub App user-to-server será a opção recomendada
para uma aplicação web multiutilizador. O acesso normal requer uma subscrição
GitHub Copilot; BYOK é a exceção documentada pelo SDK.

O catálogo sincronizado é apresentado integralmente na Administração. Cada
modelo mostra sempre fornecedor e conta, além dos limites de prompt/contexto
quando disponíveis. Modelos atuais de contas ativas podem ser escolhidos como
predefinição global; uma troca é atómica por utilizador e uma conta/modelo
eliminado, inativo ou stale limpa automaticamente a escolha. O schema reserva
`scope = feature` para overrides futuros, mas não os expõe nesta entrega.

Após descobrir os modelos, o worker chama também a operação oficial
experimental `client.rpc.account.getQuota({ gitHubToken })` do
`@github/copilot-sdk@1.0.14`/CLI 1.0.85 e usa apenas
`quotaSnapshots.premium_interactions`. A UI chama corretamente à métrica
**Utilização do GitHub Copilot**, nunca tokens. Como a operação tipada não expõe
a designação específica do plano, a UI apresenta exclusivamente **Unidades de
utilização**, sem conversão ou seleção manual. Para quotas finitas mostra o
rácio `utilizadas / incluídas`, a percentagem **disponível** e as unidades
restantes. A nota associada esclarece que esta é a unidade account-wide
reportada pelo provider e que Prompt/Contexto são capacidades técnicas por
pedido, não este saldo. Overage e apenas uma reposição futura inequívoca
aparecem nos detalhes; entitlement ilimitado e valores ausentes são
representados sem inventar totais. O restante é derivado apenas para
entitlement finito como `max(0, incluídos - utilizados)`. Uma falha de quota não
invalida credencial nem catálogo: conserva o último snapshot como stale, ou
mostra “Não disponível” quando nunca existiu um valor.
Não são pedidas permissões adicionais: a operação usa a mesma credencial já
validada para a conta.

### Probe one-shot de inferência

`POST /api/llm/infer` aceita exclusivamente JSON `{ "prompt": string }`, com
até 500 caracteres, e exige origin same-site, sessão/membership e rate limits
por utilizador e IP. O browser nunca escolhe conta, modelo ou token. O BFF lê
sob RLS a única preferência global do utilizador e uma RPC acessível apenas à
service role volta a confirmar, na mesma query, ownership, preferência,
provider GitHub Copilot, conta ativa, validação bem-sucedida e modelo não
stale. Só então o envelope é decifrado durante o pedido.

O worker recebe `token`, `model`, `prompt` e `requestId` num body HMAC assinado
para o path allowlisted `/v1/copilot/infer`. Rejeita `Origin`, replay, bodies
acima de 8 KiB e schemas com campos adicionais. A sessão efémera fixa o modelo
selecionado pelo servidor, desativa tools, MCP, agents, skills, memory, store,
file tracking, streaming e telemetria, e termina com `abort` em timeout,
`disconnect`, `deleteSession`, `client.stop`/`forceStop` e remoção do diretório
temporário. A resposta contém apenas texto até 4 096 caracteres, duração e,
quando válidos, contadores de input/output tokens. Prompt, resposta, sessão,
token, HMAC e erros raw do provider nunca são registados ou persistidos.

O prompt autorizado para um futuro smoke test é
`Qual é a capital de Portugal?`. Este repositório não o executa contra
produção; qualquer teste real continua a exigir autorização e credenciais de
preview explicitamente seguras.

A atualização automática de conta/modelos/quota usa TTL de 15 minutos para
evitar chamadas repetidas ao abrir a Administração; “Validar novamente” força
uma atualização. O snapshot persiste por conta e capability
`premium_interactions`, permitindo outros providers no futuro sem fingir que
Anthropic partilha a métrica do Copilot. Não são persistidos prompts, respostas
ou utilização de sessões.

Os valores são preservados como unidades decimais devolvidas pelo provider,
sem divisão por 1 000. O tipo público pinned chama “requests” aos campos, mas
não inclui o sinal `tokenBasedBilling` que determina a designação específica do
plano. A aplicação não usa casts para aceder a esse campo não tipado. Além
disso, `resetDate` só é propagado como próxima reposição quando é futuro, porque
o teste E2E pinned demonstra que o runtime o preenche a partir do
`timestamp_utc` do próprio snapshot, apesar de o payload raw também ter o campo
distinto `quota_reset_at`.

Os generated typings incluem os tipos raw `CopilotUserResponse*`, mas nenhum
RPC público, tipado e request-bound devolve esses campos para a credencial
fornecida a `account.getQuota`. `session.gitHubAuth.getStatus` expõe apenas o
estado e plano; os métodos internos que devolveriam auth info detalhada não
fazem parte do contrato TypeScript público. Por isso não são usados.

Fontes oficiais do contrato pinned:

- [SDK v1.0.14](https://github.com/github/copilot-sdk/releases/tag/v1.0.14);
- [`account.getQuota` e tipos gerados](https://github.com/github/copilot-sdk/blob/v1.0.14/nodejs/src/generated/rpc.ts#L4975-L5040);
- [guia Usage and billing](https://github.com/github/copilot-sdk/blob/v1.0.14/docs/features/usage-and-billing.md#L1139-L1173);
- [teste E2E pinned: valores sem escala e `resetDate` vindo do timestamp do snapshot](https://github.com/github/copilot-sdk/blob/v1.0.14/nodejs/test/e2e/rpc_server.e2e.test.ts#L158-L182);
- [GitHub Desktop: representação do bucket de utilização](https://github.com/desktop/desktop/blob/e25aac9bbce8e4431d81e79c81cc61d5b83d7cf0/app/src/ui/preferences/snapshot-card.tsx);
- [GitHub Desktop: `tokenBasedBilling` ainda ausente do tipo público do SDK](https://github.com/desktop/desktop/blob/e25aac9bbce8e4431d81e79c81cc61d5b83d7cf0/app/src/lib/stores/copilot-store.ts).

## Scripts

| Script                 | Descrição                   |
| ---------------------- | --------------------------- |
| `npm run dev`          | Servidor de desenvolvimento |
| `npm run build`        | Build de produção           |
| `npm run start`        | Executa o build             |
| `npm test`             | Testes focados de segurança |
| `npm run lint`         | ESLint                      |
| `npm run type-check`   | TypeScript da app e worker  |
| `npm run worker:build` | Build do worker isolado     |
| `npm run worker:test`  | Testes mock do worker       |
| `npm run format`       | Formatação Prettier         |
| `npm run format:check` | Verificação de formatação   |

## Segurança operacional

- Não existe registo público nem alteração de email nesta fase.
- Cookies de sessão usam `HttpOnly`, `SameSite=Lax` e `Secure` em produção.
- Cada página protegida repete `requireAuthorizedUser()`; o Proxy é apenas uma
  rejeição antecipada.
- Cada handler protegido valida autenticação + membership e devolve respostas
  `Cache-Control: no-store`.
- As policies das tabelas de utilizador repetem a membership; uma conta
  autenticada de outra app não obtém acesso direto pela Data API.
- A password atual é verificada antes de uma alteração; passwords nunca são
  persistidas, registadas ou devolvidas.
- Markdown é apresentado como texto em `<pre>`; não é usado
  `dangerouslySetInnerHTML`.
- Uma Skill `active` tem primeiro de passar a `inactive` antes de ser
  eliminada, tanto no repositório BFF como num trigger Postgres.
- A service role só participa nas operações atómicas de criação/rotação do
  segredo LLM, depois de autorização e ownership explícitos no servidor. A
  tabela de segredos não tem grants nem policies para `anon`/`authenticated`.
- A API devolve apenas uma máscara com o sufixo da credencial; ciphertext,
  nonce, auth tag, chave e payloads sensíveis nunca são serializados.
- Mensagens de validação identificam formatos de token incompatíveis sem
  repetir o valor submetido.
- Quando a listagem de modelos termina com `unknown`, o probe exato termina em
  `unavailable`, ou a chamada BFF→worker falha, a revalidação pode devolver ao
  proprietário um diagnóstico efémero estritamente allowlisted/redigido e
  bounded. Não é persistido, listado nem mostrado por omissão na UI; para os
  restantes códigos o contrato proíbe esse campo.
- BFF e worker autenticam cada pedido com HMAC SHA-256 sobre método, path,
  timestamp, request-id e hash do body; o worker usa comparação constant-time,
  janela temporal e Redis partilhado com claim atómico contra replay.
- O worker recebe apenas token e request-id, limita body/concurrency/timeout,
  rejeita CORS e prompts/tools, usa `mode: "empty"` e remove o diretório
  temporário depois de cada validação. O child nativo herda apenas esse
  diretório, `PATH` e, em Windows, `SystemRoot`; proxy/CA do container não são
  propagados.
- Falhas definitivas de credencial/entitlement/política/modelos mudam a conta
  para `invalid` e marcam o catálogo anterior stale/desativado. Falhas
  transitórias de worker/Redis mudam a conta para `error`, bloqueiam execução,
  mas preservam explicitamente o último catálogo para recuperação. A
  elegibilidade de um modelo depende apenas de conta `active` e
  `is_stale = false`; `enabled` é um espelho deprecated mantido por trigger e
  não é consultado pelo domínio/API/UI. Uma resposta antiga não vence uma mais
  recente porque a RPC compara request-id + generation.

### Rotação da chave mestra LLM

`LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION` identifica a chave usada em cada
envelope. Alterar apenas a chave tornaria as credenciais existentes
irrecuperáveis. Antes de mudar de versão, prepare uma operação server-side
controlada que mantenha a chave anterior disponível pelo respetivo
`key_version`, decifre e volte a cifrar todos os envelopes com a nova chave,
verifique a contagem e só depois retire a chave antiga. Esta Fase 3A ainda não
executa credenciais e, por isso, não automatiza essa operação.

O endpoint custom aceita apenas URLs HTTPS sem credenciais, query string ou
fragmento. Antes de qualquer chamada externa futura será ainda obrigatório
resolver e validar DNS/IP em cada pedido, bloquear redes privadas/loopback,
controlar redirects e aplicar timeouts e limites de resposta contra SSRF.

## Deploy do worker

O worker está em `services/copilot-worker`, fixa
`@github/copilot-sdk@1.0.14` (Copilot CLI 1.0.85) e Node 24 no
`Dockerfile.vercel`. O stage runtime instala explicitamente
`ca-certificates`; o CI instala o lockfile separado, testa/builda o worker,
constrói a imagem e verifica que `/etc/ssl/certs/ca-certificates.crt` existe e
não está vazio. A aplicação Next.js não depende do pacote SDK nem o inclui nas
Functions.

Vercel Services e custom containers estão em **beta**. O ficheiro
`deploy/vercel.services.example.json` documenta a topologia recomendada:
`web` recebe todo o tráfego público e obtém `COPILOT_WORKER_URL` por service
binding; `copilot_worker` não tem rewrite público. Não foi ativado como
`vercel.json`, porque são necessários passos externos e uma decisão de
isolamento:

1. mudar o Framework Preset do projeto para **Services**;
2. confirmar que o worker recebe apenas o segredo HMAC e settings próprios,
   sem service role Supabase nem chave AES;
3. configurar o mesmo HMAC no BFF e worker via secret manager;
4. configurar `COPILOT_REPLAY_REDIS_URL` para proteção de replay atómica entre
   réplicas;
5. configurar o orchestrator/load balancer para usar `GET /health` como
   readiness (devolve `503` quando Redis não está operacional);
6. só então copiar o template para `vercel.json` e redeployar.

Se o ambiente/plano não permitir variáveis isoladas por serviço, deployar o
worker como projeto/container separado com apenas HTTPS, HMAC, Redis e as
variáveis de `services/copilot-worker/.env.example`; apontar o BFF para essa
origem exata. O worker recusa arrancar em produção sem o store partilhado.

### Fontes oficiais

- [Retirada do GitHub Models](https://docs.github.com/en/github-models);
- [Autenticação do GitHub Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate);
- [Criação do fine-grained PAT para Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli);
- [GitHub Copilot SDK v1.0.14](https://github.com/github/copilot-sdk/tree/v1.0.14);
- [Vercel Services](https://vercel.com/kb/guide/vercel-services);
- [Vercel service bindings](https://vercel.com/docs/services/bindings);
- [Vercel container images](https://vercel.com/docs/functions/container-images);
- [Backend services](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/backend-services)
  e
  [multi-tenancy](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy).
