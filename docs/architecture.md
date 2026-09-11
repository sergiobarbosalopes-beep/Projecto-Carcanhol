# Arquitetura — Projecto Carcanhol

Versão: 2.0
Estado: Fase 2 implementada

## 1. Objetivo e âmbito atual

O Projecto Carcanhol é uma aplicação de apoio à análise temática e sectorial
de investimentos. A arquitetura futura combinará dados financeiros reais,
contexto macroeconómico e um agente LLM com tools. O LLM nunca será a fonte
primária de preços/fundamentais nem executará transações.

A Fase 2 implementa apenas a fundação de produto e administração:

- shell responsivo e navegação protegida;
- autenticação e membership server-side;
- alteração de palavra-passe;
- versão atual das premissas globais;
- gestão manual completa de Skills;
- contrato server-only para carregar futuramente Skills ativas.

Pesquisa, Chat, Análises, integração GitHub Models e dados financeiros não
estão implementados.

## 2. Arquitetura de execução

```text
Browser
  │ HTML/React Server Components + fetch same-origin
  ▼
Next.js 16 App Router / Vercel
  ├─ Proxy: refresh de sessão + rejeição antecipada
  ├─ layouts/pages: requireAuthorizedUser()
  ├─ Route Handlers BFF: Zod + same-origin + auth/membership
  └─ repositórios server-only: anon + sessão, sujeitos a RLS
  │
  ▼
Supabase partilhado
  ├─ Auth: auth.users (gerido pelo Supabase)
  └─ schema carcanhol (objetos exclusivos desta aplicação)
```

O frontend não importa `@supabase/supabase-js`, não recebe a anon key, tokens
ou service role e não faz acesso direto à Data API. A variável
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

| Método   | Endpoint                          | Input                    | Efeito                      |
| -------- | --------------------------------- | ------------------------ | --------------------------- |
| `POST`   | `/api/auth/login`                 | email, password          | Cria sessão após membership |
| `POST`   | `/api/auth/logout`                | —                        | Termina a sessão            |
| `POST`   | `/api/account/password`           | atual, nova, confirmação | Reautentica e atualiza Auth |
| `PUT`    | `/api/admin/premises`             | content                  | Upsert da versão atual      |
| `GET`    | `/api/admin/skills`               | page, query, status      | Lista paginada              |
| `POST`   | `/api/admin/skills`               | campos + status          | Cria Skill                  |
| `GET`    | `/api/admin/skills/:id`           | UUID                     | Consulta Skill própria      |
| `PATCH`  | `/api/admin/skills/:id`           | update/lifecycle         | Edita ou muda estado        |
| `DELETE` | `/api/admin/skills/:id`           | confirmationName         | Elimina não ativa           |
| `POST`   | `/api/admin/skills/:id/duplicate` | —                        | Duplica como rascunho       |

Todos os inputs são validados com Zod. Handlers mutantes exigem um header
`Origin` correspondente ao origin efetivo, considerando
`X-Forwarded-Host`/`X-Forwarded-Proto` da Vercel. Todas as respostas explícitas
usam `Cache-Control: no-store`.

O `user_id` nunca é aceite do cliente: é sempre obtido da sessão validada. A
service role não é usada nestes endpoints.

## 5. Schema efetivo

As migrations são aplicadas por ordem e são reexecutáveis:

1. `0001_init_carcanhol_schema.sql`;
2. `0002_admin_settings_and_skills.sql`.

Nenhuma migration cria objetos de aplicação em `public`.

### `carcanhol.profiles`

| Campo        | Tipo        | Regra                        |
| ------------ | ----------- | ---------------------------- |
| `id`         | uuid        | PK e FK para `auth.users.id` |
| `email`      | text        | Valor informativo            |
| `created_at` | timestamptz | Data de membership           |

Authenticated tem apenas `SELECT` da própria row. Escrita é administrativa.

### `carcanhol.global_assumptions`

| Campo        | Tipo        | Regra                         |
| ------------ | ----------- | ----------------------------- |
| `user_id`    | uuid        | PK/FK; uma row por utilizador |
| `content`    | text        | máximo 20 000 caracteres      |
| `created_at` | timestamptz | automático                    |
| `updated_at` | timestamptz | trigger local automático      |

Não há tabela de histórico. Authenticated recebe apenas
`SELECT`, `INSERT`, `UPDATE` das próprias rows.

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
recebe CRUD apenas das próprias rows. `anon` não tem usage do schema nem
privilégios nas tabelas.

As funções de trigger pertencem a `carcanhol`, usam `security invoker` e
`search_path = ''`. A execução direta é revogada a `public`, `anon` e
`authenticated`.

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

Estes métodos são server-only, aplicam simultaneamente `user_id` e
`status = active` e continuam sujeitos a RLS. Serão a base das futuras tools
`list_skills` e `load_skill`; a Fase 2 não as expõe nem integra um LLM.

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

Listas de Skills têm paginação server-side de 20 rows. Textareas têm limites
equivalentes aos constraints Postgres e à validação Zod.

## 9. Evolução planeada

1. Integrar provider LLM e agent loop;
2. ligar premissas globais e as duas operações de Skills ativas;
3. adicionar registry de fontes financeiras/macro;
4. implementar Pesquisa, Chat e Análises end-to-end;
5. reforçar observabilidade, rate limiting e testes de integração.

Dados financeiros atuais terão sempre origem em tools/providers reais. O
agente poderá propor candidatos, mas terá de os verificar antes de os
apresentar.
