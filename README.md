# Projecto Carcanhol

Aplicação Next.js de apoio à decisão de investimento, preparada para combinar
dados financeiros reais com análise assistida por IA. A arquitetura completa
está em [`docs/architecture.md`](docs/architecture.md).

**Estado atual: Fase 2 — shell responsivo e administração.** A aplicação já
inclui autenticação server-side, navegação protegida, gestão de conta,
premissas globais e Skills manuais. Pesquisa, Chat e Análises têm páginas
protegidas com um estado vazio explícito; não existe ainda integração LLM nem
dados financeiros.

## Stack

- Next.js 16, App Router e TypeScript;
- Tailwind CSS v4, com configuração CSS-first;
- Supabase Auth/Postgres/RLS através de `@supabase/ssr`;
- Zod para validação de ambiente e de todos os inputs BFF.

O projeto Supabase é partilhado. Todos os objetos desta aplicação vivem no
schema `carcanhol`; as migrations não criam tabelas em `public`, não instalam
triggers globais em `auth.users` e não concedem membership automaticamente.

## Funcionalidades da Fase 2

- Shell responsivo com sidebar recolhível em desktop e drawer acessível em
  ecrãs de telemóvel/tablet;
- navegação para Início, Pesquisa, Chat, Análises e Administração;
- administração numa página com tabs responsivas:
  - **Conta:** email atual e alteração de palavra-passe via Supabase Auth;
  - **Premissas globais:** uma versão atual de texto livre, até 20 000
    caracteres;
  - **Skills:** pesquisa paginada, criação manual, consulta, edição,
    duplicação, ativação, desativação, arquivo, restauro e eliminação
    definitiva reforçada;
- repositório server-only para a futura integração LLM, limitado a Skills
  `active`.

O browser nunca instancia Supabase. Todas as mutações passam por Route
Handlers BFF same-origin, usam a sessão em cookies `HttpOnly` e derivam o
`user_id` da sessão. Operações normais usam a anon key e ficam sujeitas a RLS;
a service role não participa nos fluxos de utilizador.

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
src/
  admin/                       Validação e repositórios server-only
  auth/                        Sessão e membership explícita
  components/                  Shell e componentes leves
  database/                    Clientes Supabase server-only
  http/                        Respostas no-store e proteção same-origin
  middleware/                  Refresh de sessão e redireção antecipada
  types/                       Tipos manuais do schema carcanhol
database/migrations/
  0001_init_carcanhol_schema.sql
  0002_admin_settings_and_skills.sql
docs/architecture.md
```

## Configuração local

### Pré-requisitos

- Node.js 22 ou superior;
- npm;
- projeto Supabase.

### Instalação

1. Instalar as dependências bloqueadas:

   ```bash
   npm ci
   ```

2. Copiar `.env.example` para `.env` e preencher:

   ```dotenv
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   SUPABASE_SCHEMA=carcanhol
   ```

   `NEXT_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` são server-only e
   nunca devem receber o prefixo `NEXT_PUBLIC_`.

3. No SQL Editor do Supabase, aplicar as migrations por ordem:

   1. `database/migrations/0001_init_carcanhol_schema.sql`;
   2. `database/migrations/0002_admin_settings_and_skills.sql`.

   A segunda migration cria `carcanhol.global_assumptions`,
   `carcanhol.skills`, índices, triggers locais de `updated_at`, a proteção
   contra eliminação de Skills ativas, grants mínimos e policies RLS por
   `auth.uid()`.

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

## Scripts

| Script                 | Descrição                   |
| ---------------------- | --------------------------- |
| `npm run dev`          | Servidor de desenvolvimento |
| `npm run build`        | Build de produção           |
| `npm run start`        | Executa o build             |
| `npm run lint`         | ESLint                      |
| `npm run type-check`   | TypeScript sem emissão      |
| `npm run format`       | Formatação Prettier         |
| `npm run format:check` | Verificação de formatação   |

## Segurança operacional

- Não existe registo público nem alteração de email nesta fase.
- Cookies de sessão usam `HttpOnly`, `SameSite=Lax` e `Secure` em produção.
- Cada página protegida repete `requireAuthorizedUser()`; o Proxy é apenas uma
  rejeição antecipada.
- Cada handler protegido valida autenticação + membership e devolve respostas
  `Cache-Control: no-store`.
- A password atual é verificada antes de uma alteração; passwords nunca são
  persistidas, registadas ou devolvidas.
- Markdown é apresentado como texto em `<pre>`; não é usado
  `dangerouslySetInnerHTML`.
- Uma Skill `active` tem primeiro de passar a `inactive` antes de ser
  eliminada, tanto no repositório BFF como num trigger Postgres.

## Deploy

A integração Vercel usa as quatro variáveis acima. O CI em
`.github/workflows/ci.yml` executa instalação reprodutível, lint, type-check e
build com valores placeholder, sem acesso a credenciais reais.
