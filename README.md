# Projecto Carcanhol

Aplicação Next.js de apoio à decisão de investimento, preparada para combinar
dados financeiros reais com análise assistida por IA. A arquitetura completa
está em [`docs/architecture.md`](docs/architecture.md).

**Estado atual: Fase 3B — validação real do GitHub Copilot.** A aplicação inclui
autenticação server-side, navegação protegida, gestão de conta, premissas
globais, Skills manuais e configuração segura de várias contas LLM por
utilizador. Contas GitHub Copilot são autenticadas num worker isolado antes de
serem persistidas e o respetivo catálogo de modelos é sincronizado. Pesquisa,
Chat e Análises continuam sem geração LLM nem dados financeiros.

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
  - **LLM:** validação real, revalidação manual/automática e descoberta de
    modelos para GitHub Copilot; os restantes adapters continuam preparados
    mas não podem ser ativados sem validação real;
  - **Skills:** pesquisa paginada, criação manual, consulta, edição,
    duplicação, ativação, desativação, arquivo, restauro e eliminação
    definitiva reforçada;
  - **Premissas:** uma versão atual de texto livre das premissas globais, até
    20 000 caracteres;
  - **Conta:** email atual e alteração de palavra-passe via Supabase Auth;
- repositório server-only para a futura integração LLM, limitado a Skills
  `active`;
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
  types/                       Tipos manuais do schema carcanhol
database/migrations/
  0001_init_carcanhol_schema.sql
  0002_admin_settings_and_skills.sql
  0003_llm_accounts.sql
  0004_github_copilot_provider.sql
  0005_github_copilot_validation.sql
  0006_preserve_transient_validation_catalog.sql
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
   COPILOT_WORKER_TIMEOUT_MS=30000
   ```

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
   mantendo a conta bloqueada em `error`.

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
Route Handler Next.js. Criar uma conta executa `start()` +
`rpc.models.list({ gitHubToken })` com a identidade submetida antes de gerar o
`accountId`, cifrar ou persistir.

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

O SDK também suporta tokens de utilizador OAuth `gho_` e GitHub App `ghu_`,
mas estes tipos estão apenas preparados no schema e são rejeitados pelo
formulário manual. OAuth/GitHub App user-to-server será a opção recomendada
para uma aplicação web multiutilizador. O acesso normal requer uma subscrição
GitHub Copilot; BYOK é a exceção documentada pelo SDK.

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
- Quando a listagem de modelos termina com `unknown`, a revalidação pode devolver ao
  proprietário um diagnóstico efémero, estritamente allowlisted/redigido e
  bounded. Não é persistido, listado nem mostrado por omissão na UI; para os
  restantes códigos o contrato proíbe esse campo.
- BFF e worker autenticam cada pedido com HMAC SHA-256 sobre método, path,
  timestamp, request-id e hash do body; o worker usa comparação constant-time,
  janela temporal e Redis partilhado com claim atómico contra replay.
- O worker recebe apenas token e request-id, limita body/concurrency/timeout,
  rejeita CORS e prompts/tools, usa `mode: "empty"` e remove o diretório
  temporário depois de cada validação.
- Falhas definitivas de credencial/entitlement/política/modelos mudam a conta
  para `invalid` e marcam o catálogo anterior stale/desativado. Falhas
  transitórias de worker/Redis mudam a conta para `error`, bloqueiam execução,
  mas preservam explicitamente o último catálogo e escolhas `enabled` para
  recuperação. Uma resposta antiga não vence uma mais recente porque a RPC
  compara request-id + generation.

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
`@github/copilot-sdk@1.0.13` e Node 24 no `Dockerfile.vercel`. O CI instala o
lockfile separado, testa/builda o worker e constrói a imagem. A aplicação
Next.js não depende do pacote SDK nem o inclui nas Functions.

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
- [GitHub Copilot SDK v1.0.13](https://github.com/github/copilot-sdk/tree/v1.0.13);
- [Vercel Services](https://vercel.com/kb/guide/vercel-services);
- [Vercel service bindings](https://vercel.com/docs/services/bindings);
- [Vercel container images](https://vercel.com/docs/functions/container-images);
- [Backend services](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/backend-services)
  e
  [multi-tenancy](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy).
