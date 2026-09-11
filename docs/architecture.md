# Arquitetura — Projecto Carcanhol

Versão: 3.0
Estado: Fase 3A implementada

## 1. Objetivo e âmbito atual

O Projecto Carcanhol é uma aplicação de apoio à análise temática e sectorial
de investimentos. A arquitetura futura combinará dados financeiros reais,
contexto macroeconómico e um agente LLM com tools. O LLM nunca será a fonte
primária de preços/fundamentais nem executará transações.

A Fase 3A implementa a fundação de produto e administração:

- shell responsivo e navegação protegida;
- autenticação e membership server-side;
- alteração de palavra-passe;
- versão atual das premissas globais;
- gestão manual completa de Skills;
- gestão de várias contas de fornecedores LLM por utilizador;
- envelopes AES-256-GCM de credenciais numa tabela service-only;
- contrato server-only para carregar futuramente Skills ativas.

Pesquisa, Chat, Análises, chamadas a fornecedores, validação/descoberta de
modelos, geração LLM e dados financeiros não estão implementados.

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
  └─ criação/rotação de segredo: autorização explícita + service role + RPC
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
| `PATCH`  | `/api/admin/llm-accounts/:id`            | nome/endpoint            | Edita metadados próprios    |
| `PUT`    | `/api/admin/llm-accounts/:id/credential` | nova credencial          | Substitui envelope          |
| `DELETE` | `/api/admin/llm-accounts/:id`            | confirmationName         | Elimina conta + segredo     |

Todos os inputs são validados com Zod. Handlers mutantes exigem um header
`Origin` correspondente ao origin efetivo, considerando
`X-Forwarded-Host`/`X-Forwarded-Proto` da Vercel. Todas as respostas explícitas
usam `Cache-Control: no-store`.

O `user_id` nunca é aceite do cliente: é sempre obtido da sessão validada.
Operações normais usam anon + sessão. Apenas criação e rotação de segredos
usam service role, instanciada internamente por código server-only depois de
revalidar sessão, membership e ownership. As RPCs executam cada alteração numa
única transação.

## 5. Schema efetivo

As migrations são aplicadas por ordem e são reexecutáveis:

1. `0001_init_carcanhol_schema.sql`;
2. `0002_admin_settings_and_skills.sql`;
3. `0003_llm_accounts.sql`.

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
tipo de autenticação, estado (`pending_validation` ou `inactive`), endpoint
custom HTTPS, sufixo mascarável e metadados de validação futura. O índice
`lower(btrim(display_name))` impede nomes duplicados por utilizador sem impedir
várias contas do mesmo fornecedor. Authenticated recebe apenas leitura,
eliminação e atualização das colunas `display_name`/`custom_endpoint`, sempre
sob RLS com ownership + membership.

`carcanhol.llm_account_secrets` guarda ciphertext, nonce, auth tag, algoritmo,
versão do envelope, versão da chave e versão da credencial. Não tem grants nem
policies para `anon` ou `authenticated`; a service role é a única identidade
com acesso. Uma constraint trigger diferida exige um segredo 1:1 no commit. A
criação e a rotação usam RPCs service-only, pelo que conta, envelope, máscara e
estado mudam atomicamente.

O AES-256-GCM usa nonce aleatório de 96 bits e AAD com versão, `user_id`,
`account_id` e fornecedor. A chave vem exclusivamente de
`LLM_CREDENTIAL_ENCRYPTION_KEY`, base64 canónico de 32 bytes, e a sua versão de
`LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION`. Nunca é persistida. A API projeta
apenas metadados e `credential_hint`; não seleciona nem serializa a tabela de
segredos.

### Estruturas para integração futura

- `llm_account_models`: catálogo automaticamente descoberto por conta; cada
  modelo começa `enabled = false` e exigirá autorização manual;
- `llm_routing_rules`: modelo geral ou por funcionalidade, onde ordem 0 é o
  principal e as restantes rows são fallbacks ordenados;
- `llm_usage_events`: tokens de entrada/saída, latência, estado e custo
  estimado, sem colunas para prompts ou respostas.

As três tabelas são metadata user-owned com RLS ownership + membership. Nesta
fase authenticated tem apenas leitura; descoberta, autorização, routing e
telemetria ainda não têm handlers.

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

## 7. Contrato futuro com o LLM

`src/admin/skills.ts` exporta:

- `listActiveSkills(userId)`, com limite de 100 resumos;
- `getActiveSkill(userId, id)`, que exige `status = active`.

Estes métodos são server-only, criam sempre um cliente anon + sessão, repetem
`requireAuthorizedUser()`, rejeitam um `userId` diferente do utilizador da
sessão e aplicam simultaneamente `user_id` e `status = active`. A RLS volta a
exigir ownership + membership, pelo que falham fechados e não aceitam a injeção
de um cliente service role. Serão a base das futuras tools `list_skills` e
`load_skill`; a Fase 3A não as expõe nem integra um LLM.

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
estado, autenticação, máscara, endpoint e timestamps. Criar, editar, substituir
credencial e eliminar têm labels explícitas e confirmação reforçada. Não
existe ação de ativação: todas as contas permanecem “Por validar”. As secções
de modelos/routing e utilização são informativas e não inventam modelos.

Listas de Skills têm paginação server-side de 20 rows. Textareas têm limites
equivalentes aos constraints Postgres e à validação Zod.

## 9. Evolução planeada

1. Implementar validação de credenciais e descoberta automática de modelos;
2. aplicar proteção SSRF/DNS, redirects, timeouts e limites antes de chamar
   endpoints custom;
3. autorizar modelos e configurar routing/fallbacks;
4. integrar provider LLM e agent loop;
5. ligar premissas globais e as duas operações de Skills ativas;
6. adicionar registry de fontes financeiras/macro;
7. implementar Pesquisa, Chat e Análises end-to-end;
8. reforçar observabilidade, rate limiting e testes de integração.

Dados financeiros atuais terão sempre origem em tools/providers reais. O
agente poderá propor candidatos, mas terá de os verificar antes de os
apresentar.
