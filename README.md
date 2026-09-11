# Projecto Carcanhol — Plataforma de Análise e Recomendação de Investimentos com IA

Aplicação web (Next.js, App Router) de apoio à decisão de investimento, com
análise temática/sectorial combinando dados financeiros reais, conjuntura
macroeconómica e um LLM orquestrado via "Skills" e "tools". Ver
[`docs/architecture.md`](docs/architecture.md) para a arquitetura completa.

**Estado atual: Fase 1 (Foundation).** Apenas estrutura do projeto, ligação
Supabase, autenticação e preparação para deploy. Nenhuma funcionalidade de
negócio (pesquisa de instrumentos, chat, LLM, Skills) está implementada
ainda — ver secção 8 de `docs/architecture.md` para o roadmap de fases.

## Stack

- [Next.js](https://nextjs.org) 16 (App Router, TypeScript) — frontend e
  backend (Route Handlers em `app/api`) no mesmo projeto e deploy.
- [Tailwind CSS](https://tailwindcss.com) v4 (config CSS-first, sem
  `tailwind.config.ts`).
- [Supabase](https://supabase.com) — Postgres, Auth, Row Level Security.
  **Projeto Supabase partilhado**: todos os objetos desta app vivem no
  schema `carcanhol` (nunca em `public`).
- [Zod](https://zod.dev) para validação de variáveis de ambiente (e, mais
  tarde, de inputs).

## Estrutura do repositório

```
app/
  login/            Página de login (email/password)
  dashboard/         Página protegida (placeholder)
  api/auth/           Route Handlers BFF de login/logout
src/
  database/          Clientes Supabase server-only, scoped a "carcanhol"
  middleware/         Lógica de proteção de rotas / refresh de sessão
  types/              Tipos partilhados (incl. tipos do schema "carcanhol")
  utils/              Utilitários (validação de env vars, etc.)
skills/               Reservado para a Fase 3 (Skills do LLM) — vazio por agora
database/migrations/  SQL para criar o schema "carcanhol" e tabelas, com RLS
docs/architecture.md  Documento de arquitetura completo
tests/                Reservado para testes automatizados futuros
.github/workflows/    CI: lint + type-check + build
```

## Pré-requisitos

- Node.js 22+ e npm (requerido pelas dependências `@supabase/*` atuais).
- Um projeto Supabase (pode ser o mesmo usado por outras aplicações — esta
  app só escreve no schema `carcanhol`).

## Configuração local

1. Instalar dependências de forma reprodutível:

   ```bash
   npm ci
   ```

2. Copiar o ficheiro de exemplo de variáveis de ambiente:

   ```bash
   cp .env.example .env
   ```

3. Preencher `.env` com as credenciais reais do teu projeto Supabase
   (Dashboard → Project Settings → API):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_SUPABASE_ANON_KEY` (server-only — nunca expor ao browser)
   - `SUPABASE_SERVICE_ROLE_KEY` (secreta — nunca commitar, nunca expor ao browser)
   - `SUPABASE_SCHEMA=carcanhol`

4. **Aplicar primeiro a migration SQL** no Supabase:
   - Abrir o Supabase Dashboard → **SQL Editor** (no projeto partilhado).
   - Colar e correr o conteúdo de
     `database/migrations/0001_init_carcanhol_schema.sql`.
   - Isto cria o schema `carcanhol`, a allowlist
     `carcanhol.profiles` e a policy de RLS que permite a cada utilizador
     autenticado consultar apenas a sua própria membership.

5. **Expor o schema `carcanhol` na Data API** (passo fácil de esquecer):
   - Supabase Dashboard → Project Settings → **API** → **Exposed schemas** →
     adicionar `carcanhol` à lista (além de `public`, se já lá estiver).
   - Sem este passo, os pedidos dos clientes Supabase configurados com
     `schema: "carcanhol"` falham com erro de schema não encontrado.

6. **Criar depois o utilizador manualmente** (não há registo público):
   - Supabase Dashboard → **Authentication** → **Users** → **Add user** →
     definir email + palavra-passe.
   - Abrir o utilizador criado e copiar o seu **UUID**.

7. **Autorizar por fim esse UUID no Carcanhol**:
   - No Supabase Dashboard → **SQL Editor**, substituir `UUID` e `EMAIL`
     pelos valores do utilizador e executar exatamente:

     ```sql
     insert into carcanhol.profiles (id,email) values ('UUID','EMAIL');
     ```

   - A ordem obrigatória é **migration → user em Authentication → INSERT na
     allowlist**. Criar apenas o utilizador em Authentication não concede
     acesso à aplicação.

8. Correr o servidor de desenvolvimento:

   ```bash
   npm run dev
   ```

   Abrir [http://localhost:3000](http://localhost:3000) — deve redirecionar
   para `/login`. Após autenticação, redireciona para `/dashboard`.

## Scripts disponíveis

| Script                 | Descrição                                        |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Servidor de desenvolvimento                      |
| `npm run build`        | Build de produção (usado também pelo Vercel)     |
| `npm run start`        | Corre o build de produção localmente             |
| `npm run lint`         | ESLint                                           |
| `npm run type-check`   | Verificação de tipos TypeScript (`tsc --noEmit`) |
| `npm run format`       | Formata o código com Prettier                    |
| `npm run format:check` | Verifica formatação sem alterar ficheiros        |

## CI

`.github/workflows/ci.yml` corre `lint` + `type-check` + `build` em cada
push/PR para `main`. Não faz deploy — o deploy é feito pela integração
direta do Vercel com o GitHub (ver secção seguinte).

## Deploy no Vercel

1. Importar este repositório no Vercel (New Project → Import Git Repository).
2. Configurar as mesmas variáveis de ambiente do `.env` em
   Project Settings → Environment Variables (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_SCHEMA`).
3. Deploy — o Vercel deteta automaticamente o Next.js, `npm run build`
   corre sem passos adicionais.

## Autenticação — nota de âmbito

Esta fase implementa **apenas login** (email/password), sem registo
público. Uma sessão Supabase válida não basta: o UUID também tem de existir
em `carcanhol.profiles`, que funciona como allowlist explícita da aplicação.
O browser comunica apenas com os Route Handlers BFF de login/logout. A anon
key fica em `NEXT_SUPABASE_ANON_KEY`, é lida exclusivamente no servidor e não
entra no bundle do browser; apenas `NEXT_PUBLIC_SUPABASE_URL` continua pública.
As sessões são transportadas por cookies `HttpOnly` geridos por
`@supabase/ssr`. O Proxy e os Server Components protegidos validam sessão +
membership usando a anon key, a sessão do utilizador e RLS; a service role
nunca é usada no fluxo de autenticação.

Num projeto Supabase partilhado, **não desativar globalmente o signup** se
essa definição afetar as outras aplicações. O Carcanhol não expõe qualquer
fluxo de signup, e a row em `carcanhol.profiles` é a barreira de autorização
que isola os utilizadores desta app. Futuras Route Handlers protegidas devem
usar `requireAuthorizedUser()` (ou `getAuthorizedUser()` quando precisarem de
devolver explicitamente JSON 401/403) de `src/auth/server.ts`.
