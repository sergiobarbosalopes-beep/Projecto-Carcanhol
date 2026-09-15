# Arquitetura — Projecto Carcanhol

Versão: 3.2
Estado: Fase 3B implementada

## 1. Objetivo e âmbito atual

O Projecto Carcanhol é uma aplicação de apoio à análise temática e sectorial
de investimentos. A arquitetura futura combinará dados financeiros reais,
contexto macroeconómico e um agente LLM com tools. O LLM nunca será a fonte
primária de preços/fundamentais nem executará transações.

A Fase 3B acrescenta validação real à fundação de produto e administração:

- shell responsivo e navegação protegida;
- autenticação e membership server-side;
- alteração de palavra-passe;
- versão atual das premissas globais;
- gestão manual completa de Skills;
- gestão de várias contas de fornecedores LLM por utilizador;
- GitHub Copilot como provider canónico, validado através do SDK num worker;
- descoberta e sincronização do catálogo de modelos por conta;
- envelopes AES-256-GCM de credenciais numa tabela service-only;
- contrato server-only para carregar futuramente Skills ativas.

Pesquisa, Chat, Análises, geração LLM e dados financeiros não estão
implementados. Os modelos descobertos não são autorizados automaticamente.

## 2. Arquitetura de execução

```text
Browser
  │ HTML/React Server Components + fetch same-origin
  ▼
Next.js 16 App Router / Vercel
  ├─ Proxy: refresh de sessão + rejeição antecipada
  ├─ layouts/pages: requireAuthorizedUser()
  ├─ Route Handlers BFF: Zod + same-origin + auth/membership
  ├─ repositórios server-only: anon + sessão, sujeitos a RLS
  ├─ criação/rotação de segredo: autorização explícita + service role + RPC
  └─ client HMAC para o worker (URL server-only allowlisted)
         │ token plaintext apenas durante o pedido
         ▼
      Copilot validation worker / Node 24 container
        ├─ endpoint estrito validate/listModels
        ├─ @github/copilot-sdk 1.0.13, mode: empty
        ├─ sem prompts, sessões ou tools
        └─ timeout, concorrência e replay bounded
  │
  ▼
Supabase partilhado
  ├─ Auth: auth.users (gerido pelo Supabase)
  └─ schema carcanhol (objetos exclusivos desta aplicação)
```

O frontend não importa `@supabase/supabase-js`, não recebe a anon key, tokens,
chaves de cifragem ou service role e não faz acesso direto à Data API. A variável
`NEXT_PUBLIC_SUPABASE_URL` é publicável; `NEXT_SUPABASE_ANON_KEY` é usada
exclusivamente por módulos server-only.

## 3. Autenticação e autorização

O login e logout passam por `/api/auth/login` e `/api/auth/logout`. O cliente
SSR grava a sessão em cookies `HttpOnly`, `SameSite=Lax`, `Secure` em produção.

Autenticação não implica acesso à aplicação. Depois de validar a sessão,
`requireAuthorizedUser()` exige uma row do mesmo UUID em
`carcanhol.profiles`. A tabela é uma allowlist administrada fora da aplicação;
não existe trigger em `auth.users`, uma vez que o projeto Supabase é
partilhado.

O Proxy cobre `/dashboard`, `/pesquisa`, `/chat`, `/analises` e
`/administracao`, mas é apenas uma otimização. Cada layout/página protegida e
cada handler de administração repete o guard junto do acesso aos dados.

## 4. Fronteira BFF

| Método   | Endpoint                                 | Input                    | Efeito                      |
| -------- | ---------------------------------------- | ------------------------ | --------------------------- |
| `POST`   | `/api/auth/login`                        | email, password          | Cria sessão após membership |
| `POST`   | `/api/auth/logout`                       | —                        | Termina a sessão            |
| `POST`   | `/api/account/password`                  | atual, nova, confirmação | Reautentica e atualiza Auth |
| `PUT`    | `/api/admin/premises`                    | content                  | Upsert da versão atual      |
| `GET`    | `/api/admin/skills`                      | page, query, status      | Lista paginada              |
| `POST`   | `/api/admin/skills`                      | campos + status          | Cria Skill                  |
| `GET`    | `/api/admin/skills/:id`                  | UUID                     | Consulta Skill própria      |
| `PATCH`  | `/api/admin/skills/:id`                  | update/lifecycle         | Edita ou muda estado        |
| `DELETE` | `/api/admin/skills/:id`                  | confirmationName         | Elimina não ativa           |
| `POST`   | `/api/admin/skills/:id/duplicate`        | —                        | Duplica como rascunho       |
| `GET`    | `/api/admin/llm-accounts`                | —                        | Lista metadados próprios    |
| `POST`   | `/api/admin/llm-accounts`                | fornecedor/nome/segredo  | Cria conta + segredo        |
| `POST`   | `/api/admin/llm-accounts/:id/validate`   | —                        | Revalida e sincroniza       |
| `PATCH`  | `/api/admin/llm-accounts/:id`            | nome/endpoint            | Edita metadados próprios    |
| `PUT`    | `/api/admin/llm-accounts/:id/credential` | nova credencial          | Substitui envelope          |
| `DELETE` | `/api/admin/llm-accounts/:id`            | confirmationName         | Elimina conta + segredo     |

Todos os inputs são validados com Zod. Handlers mutantes exigem um header
`Origin` correspondente ao origin efetivo, considerando
`X-Forwarded-Host`/`X-Forwarded-Proto` da Vercel. Todas as respostas explícitas
usam `Cache-Control: no-store`.

O `user_id` nunca é aceite do cliente: é sempre obtido da sessão validada.
Operações normais usam anon + sessão. Criação, rotação, leitura server-side do
envelope e aplicação da validação usam service role apenas depois de
revalidar sessão, membership e ownership. O BFF desencripta a credencial,
envia apenas token + request-id ao worker e nunca lhe entrega a service role
ou chave AES. As RPCs executam cada alteração numa única transação.

## 5. Schema efetivo

As migrations são aplicadas por ordem e são reexecutáveis:

1. `0001_init_carcanhol_schema.sql`;
2. `0002_admin_settings_and_skills.sql`;
3. `0003_llm_accounts.sql`;
4. `0004_github_copilot_provider.sql`;
5. `0005_github_copilot_validation.sql`;
6. `0006_preserve_transient_validation_catalog.sql`.

Nenhuma migration cria objetos de aplicação em `public`.

### `carcanhol.profiles`

| Campo        | Tipo        | Regra                        |
| ------------ | ----------- | ---------------------------- |
| `id`         | uuid        | PK e FK para `auth.users.id` |
| `email`      | text        | Valor informativo            |
| `created_at` | timestamptz | Data de membership           |

Authenticated tem apenas `SELECT` da própria row. Escrita é administrativa.
As policies das restantes tabelas consultam esta allowlist; a policy de
`profiles` não consulta outras tabelas e, por isso, não existe recursão RLS.

### `carcanhol.global_assumptions`

| Campo        | Tipo        | Regra                         |
| ------------ | ----------- | ----------------------------- |
| `user_id`    | uuid        | PK/FK; uma row por utilizador |
| `content`    | text        | máximo 20 000 caracteres      |
| `created_at` | timestamptz | automático                    |
| `updated_at` | timestamptz | trigger local automático      |

Não há tabela de histórico. Authenticated recebe apenas `SELECT`, `INSERT`,
`UPDATE` das próprias rows e apenas enquanto existir membership explícita em
`carcanhol.profiles`.

### `carcanhol.skills`

| Campo              | Tipo        | Regra                                 |
| ------------------ | ----------- | ------------------------------------- |
| `id`               | uuid        | PK, `gen_random_uuid()`               |
| `user_id`          | uuid        | FK para `auth.users.id`               |
| `name`             | text        | obrigatório, não vazio, máximo 120    |
| `description`      | text        | máximo 500                            |
| `status`           | text        | check: draft/active/inactive/archived |
| `content_markdown` | text        | máximo 50 000                         |
| `created_at`       | timestamptz | automático                            |
| `updated_at`       | timestamptz | trigger local automático              |

Existem índices por proprietário/data e proprietário/estado/data. Authenticated
recebe CRUD apenas das próprias rows e apenas com membership em
`carcanhol.profiles`. `anon` não tem usage do schema nem privilégios nas
tabelas. Assim, uma conta autenticada pertencente a outra aplicação do projeto
Supabase partilhado não consegue criar sequer a sua primeira row pela Data API.

As funções de trigger pertencem a `carcanhol`, usam `security invoker` e
`search_path = ''`. A execução direta é revogada a `public`, `anon` e
`authenticated`.

### Contas e credenciais LLM

`carcanhol.llm_accounts` contém apenas metadados próprios: fornecedor, nome,
tipo de autenticação, estado (`pending_validation`, `active`, `invalid`,
`error` ou `inactive`), endpoint custom HTTPS, sufixo mascarável e resultado
sanitizado da última validação. O índice
`lower(btrim(display_name))` impede nomes duplicados por utilizador sem impedir
várias contas do mesmo fornecedor. Authenticated recebe apenas leitura,
eliminação e atualização das colunas `display_name`/`custom_endpoint`, sempre
sob RLS com ownership + membership.

`carcanhol.llm_account_secrets` guarda ciphertext, nonce, auth tag, algoritmo,
versão do envelope, versão da chave, versão da credencial e o provider
autenticado no AAD. Não tem grants nem policies para `anon` ou
`authenticated`; a service role é a única identidade com acesso. Uma
constraint trigger diferida exige um segredo 1:1 no commit. A criação e a
rotação usam RPCs service-only, pelo que conta, envelope, máscara e estado
mudam atomicamente.

O AES-256-GCM usa nonce aleatório de 96 bits e AAD com versão, `user_id`,
`account_id` e fornecedor. A chave vem exclusivamente de
`LLM_CREDENTIAL_ENCRYPTION_KEY`, base64 canónico de 32 bytes, e a sua versão de
`LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION`. Nunca é persistida. A API projeta
apenas metadados e `credential_hint`; não seleciona nem serializa a tabela de
segredos.

A migration `0004` altera o provider canónico de `github_models` para
`github_copilot`. Antes da alteração, copia para
`llm_account_secrets.aad_provider` o valor que participou no AAD de cada
envelope existente; assim, uma credencial antiga continua autenticável sem
decifração ou recifragem na migration. Uma rotação futura cifra com o provider
canónico e atualiza esse campo na mesma RPC. `validation_generation` e
`last_validation_request_id` impedem uma conclusão antiga de substituir um
resultado mais recente; `validating` nunca é persistido.

Para GitHub Copilot, a criação manual produz apenas
`credential_type = fine_grained_pat`. O schema reserva
`oauth_app_user` e `github_app_user` para integrações user-to-server futuras.
Os tipos genéricos `token` e `oauth` permanecem permitidos apenas para
compatibilidade não destrutiva com outros providers; `api_key` não é
compatível com GitHub Copilot.

### Catálogo e estruturas futuras

- `llm_account_models`: catálogo sincronizado por `provider_model_id`; cada
  modelo novo começa `enabled = false`, metadata é allowlisted/bounded e
  modelos ausentes ou invalidados por uma falha definitiva ficam
  `is_stale = true` e desativados. Timeout/indisponibilidade/erro desconhecido
  bloqueiam a conta com `status = error`, mas preservam catálogo e escolhas do
  último sucesso;
- `llm_routing_rules`: modelo geral ou por funcionalidade, onde ordem 0 é o
  principal e as restantes rows são fallbacks ordenados;
- `llm_usage_events`: tokens de entrada/saída, latência, estado e custo
  estimado, sem colunas para prompts ou respostas.

As três tabelas são metadata user-owned com RLS ownership + membership.
Authenticated tem apenas leitura. Descoberta é aplicada pelas RPCs
service-only; autorização, routing e telemetria ainda não têm handlers.
Qualquer runtime futuro terá de exigir simultaneamente conta `active`, modelo
`enabled` e `is_stale = false`; uma conta `error` nunca é elegível mesmo quando
o catálogo/seleção anterior foi preservado.

## 6. Lifecycle de Skills

```text
draft ───────► active ───────► inactive
  │              │               │  ▲
  └──────────────┴──► archived ◄─┘  │
                        │            │
                        └─ restore ──┘
```

- **draft:** rascunho, nunca disponível ao agente;
- **active:** única condição elegível para runtime LLM futuro;
- **inactive:** preservada, mas não carregável;
- **archived:** fora da gestão corrente, preservada.

Arquivar remove imediatamente uma Skill do conjunto ativo. Para eliminação
definitiva, uma Skill ativa tem primeiro de ser desativada. Esta regra é
imposta no serviço server-side e também por um trigger `BEFORE DELETE`. A UI
exige ainda que o utilizador escreva exatamente o nome antes da eliminação.

Duplicar cria sempre uma nova Skill `draft`. Restaurar uma arquivada resulta
em `inactive`; a ativação posterior é explícita.

## 7. Contrato com o worker Copilot

### GitHub Copilot

O GitHub Models foi retirado em 30 de julho de 2026. A integração usa
`@github/copilot-sdk@1.0.13`, cujo runtime requer Node
`^20.19.0 || >=22.12.0`; o container fixa Node 24. `listModels()` é uma
operação do cliente, por isso a validação não cria sessão nem envia prompt.

O onboarding manual aceita exclusivamente um fine-grained PAT `github_pat_`
da conta pessoal, com a conta pessoal como Resource owner e a Account
permission `Copilot Requests`. Deve ter um prazo curto e ser guardado quando é
criado, pois só é mostrado uma vez. PATs classic `ghp_` são incompatíveis;
tokens OAuth `gho_` e GitHub App user `ghu_` são suportados pelo SDK, mas ficam
reservados para uma futura integração user-to-server e não entram pelo
formulário de PAT.

O SDK Node inicia o runtime incluído como child process. Ele não é dependência
da app Next.js nem é importado por qualquer Route Handler. Para cada pedido, o
worker cria um diretório temporário `0700`, inicia um cliente com
`mode: "empty"`, `useLoggedInUser: false`, `logLevel: "none"` e ambiente
allowlisted, chama `listModels()`, faz `stop()`/`forceStop()` e remove o
diretório. O token é passado pela opção oficial `gitHubToken`, nunca por URL ou
ficheiro. Como não há sessão, não há permission requests; qualquer sessão
futura terá `availableTools: []` e `denyAllPermissions`.

```text
Browser
  │ sessão Carcanhol
  ▼
Next.js BFF
  ├─ ownership + membership
  ├─ desencripta envelope com aad_provider
  └─ HMAC(method, path, timestamp, request-id, sha256(body))
  │ HTTPS ou service binding privado
  ▼
Worker/container Copilot
  ├─ body/schema estritos: request-id + token
  ├─ comparação HMAC constant-time + janela + replay store
  ├─ concorrência/fila/payload/timeout bounded
  ├─ start → listModels → stop
  └─ resposta allowlisted: model id/name/capabilities/policy/billing
```

Falhas são reduzidas a `invalid_token`, `no_subscription`,
`org_policy_blocked`, `timeout`, `unavailable`, `no_models` ou `unknown`.
Estados específicos só são inferidos de evidência estruturada; um `403`
genérico fica `unknown`. Mensagens remotas em bruto nunca são
persistidas/devolvidas.

Para `unknown`, o worker cria um diagnóstico efémero com shape fechado
(`event`, `requestId`, `error.constructor/name/stringCodes/numericCodes/statuses/message`).
Antes do fallback textual, privilegia `ResponseError.data.code` e statuses
estruturados. A mensagem é redigida e limitada; stack, erro raw, token, body e
environment nunca são lidos. O BFF devolve esse objeto apenas no POST de
revalidação autenticado do proprietário. Não entra nas RPCs/BD, na listagem de
contas ou na renderização normal da UI.

O worker expõe apenas `GET /health` e `POST /v1/copilot/validate`, rejeita
`Origin` e não envia headers CORS. `/health` é readiness: faz `PING` e um
`SET NX PX` efémero e bounded, devolvendo `503` sem detalhes quando Redis não
está operacional ou não permite a escrita exigida. O cliente Redis partilha
tentativas concorrentes, usa reconexão exponencial limitada
(cinco tentativas, teto de dois segundos e jitter) e continua fail-closed.
Local/teste podem usar replay store em memória; produção exige Redis
partilhado e reclama cada request-id atomicamente com `SET NX PX` até terminar
a validade da assinatura.

OAuth ou GitHub App user-to-server é o desenho recomendado para a futura
versão web multiutilizador, evitando a recolha manual permanente de PATs. Um
refresh token futuro, caso exista, continuará cifrado na tabela service-only;
não será guardado em metadados públicos.

Fontes oficiais:
[autenticação](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate),
[backend services](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/backend-services),
[multi-tenancy](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy),
[runtime incluído](https://github.com/github/copilot-sdk/blob/main/docs/setup/bundled-cli.md)
e
[persistência de sessões](https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md),
[Vercel Services](https://vercel.com/kb/guide/vercel-services),
[service bindings](https://vercel.com/docs/services/bindings) e
[container images](https://vercel.com/docs/functions/container-images).

### Skills e premissas

`src/admin/skills.ts` exporta:

- `listActiveSkills(userId)`, com limite de 100 resumos;
- `getActiveSkill(userId, id)`, que exige `status = active`.

Estes métodos são server-only, criam sempre um cliente anon + sessão, repetem
`requireAuthorizedUser()`, rejeitam um `userId` diferente do utilizador da
sessão e aplicam simultaneamente `user_id` e `status = active`. A RLS volta a
exigir ownership + membership, pelo que falham fechados e não aceitam a injeção
de um cliente service role. Serão a base das futuras tools `list_skills` e
`load_skill`; a Fase 3B ainda não as expõe nem executa geração LLM.

As premissas globais serão futuramente injetadas como contexto superior à
mensagem do utilizador. Nesta fase são apenas persistidas, nunca enviadas a um
modelo.

## 8. UI e acessibilidade

O route group `(protected)` fornece o layout partilhado. Em desktop largo há
sidebar recolhível; em telemóvel/tablet há drawer com foco inicial, ciclo de
foco, Escape, backdrop e bloqueio de scroll. A navegação não depende de hover.

A Administração usa tabs com semântica ARIA e teclado. Controlos interativos
têm área mínima de 44 px, focus visível e transições curtas com
`motion-reduce`. Markdown é mostrado como plaintext num `<pre>` com wrapping;
não existe parser HTML nem `dangerouslySetInnerHTML`.

A tab LLM começa por um resumo e apresenta cartões responsivos com fornecedor,
estado, autenticação, máscara, endpoint, último teste e número de modelos.
Entrar na tab inicia uma revalidação bounded de cada conta GitHub Copilot,
mostrando primeiro o último estado conhecido e depois “A validar…”. Cada card
tem ainda `Validar novamente`; `aria-live`, `aria-busy` e disabled impedem
duplo clique e anunciam o progresso. O catálogo pode ser consultado, mas não
ativado nesta entrega.

Listas de Skills têm paginação server-side de 20 rows. Textareas têm limites
equivalentes aos constraints Postgres e à validação Zod.

## 9. Evolução planeada

1. Ativar a infraestrutura do worker (Vercel Services exige configuração
   externa) ou publicar o container num runtime isolado equivalente;
2. operar e monitorizar o Redis de replay partilhado;
3. implementar OAuth/GitHub App user-to-server;
4. aplicar proteção SSRF/DNS, redirects, timeouts e limites antes de chamar
   endpoints custom;
5. autorizar modelos e configurar routing/fallbacks;
6. integrar provider LLM e agent loop;
7. ligar premissas globais e as duas operações de Skills ativas;
8. adicionar registry de fontes financeiras/macro;
9. implementar Pesquisa, Chat e Análises end-to-end;
10. reforçar observabilidade, rate limiting e testes de integração.

Dados financeiros atuais terão sempre origem em tools/providers reais. O
agente poderá propor candidatos, mas terá de os verificar antes de os
apresentar.

## 10. Deploy e bloqueio de infraestrutura

Vercel Services e container images estão em beta. A topologia privada pode ser
declarada com `deploy/vercel.services.example.json`, deixando apenas `web` no
rewrite público e injetando `COPILOT_WORKER_URL` através de um service binding.
O binding concede reachability, não autenticação; o HMAC continua obrigatório.

O template não está ativo como `vercel.json` porque o deploy seguro exige
ações fora do repositório:

1. mudar o Framework Preset do projeto Vercel para **Services**;
2. garantir isolamento de environment variables, de modo que
   `copilot_worker` não receba `SUPABASE_SERVICE_ROLE_KEY` nem
   `LLM_CREDENTIAL_ENCRYPTION_KEY`;
3. provisionar o segredo HMAC independente nos dois serviços;
4. provisionar Redis dedicado para nonces, sem dados de utilizador;
5. configurar `GET /health` como readiness para remover instâncias sem Redis
   do tráfego; o `Dockerfile.vercel` inclui também um `HEALTHCHECK`;
6. aceitar explicitamente o risco operacional de uma funcionalidade beta.

Se não houver isolamento de secrets por serviço, o worker deve ser publicado
num projeto/container separado, com apenas as variáveis do respetivo
`.env.example`; o BFF usa a origem HTTPS exata como allowlist. Não são
necessárias alterações ao deploy Next.js atual para construir ou testar o
worker.
