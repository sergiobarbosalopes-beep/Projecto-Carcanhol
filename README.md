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
  api/auth/logout/   Route Handler de logout
src/
  database/          Clientes Supabase (browser + server), scoped a "carcanhol"
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

1. Instalar dependências:

   ```bash
   npm install
   ```

2. Copiar o ficheiro de exemplo de variáveis de ambiente:

   ```bash
   cp .env.example .env
   ```

3. Preencher `.env` com as credenciais reais do teu projeto Supabase
   (Dashboard → Project Settings → API):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (secreta — nunca commitar, nunca expor ao browser)
   - `SUPABASE_SCHEMA=carcanhol`

4. Aplicar a migration SQL no Supabase:
   - Abrir o Supabase Dashboard → **SQL Editor** (no projeto partilhado).
   - Colar e correr o conteúdo de
     `database/migrations/0001_init_carcanhol_schema.sql`.
   - Isto cria o schema `carcanhol`, a tabela `carcanhol.profiles`, as
     policies de RLS, e um trigger que cria automaticamente um perfil
     quando um novo utilizador é criado em `auth.users`.

5. **Expor o schema `carcanhol` na Data API** (passo fácil de esquecer):
   - Supabase Dashboard → Project Settings → **API** → **Exposed schemas** →
     adicionar `carcanhol` à lista (além de `public`, se já lá estiver).
   - Sem este passo, os pedidos dos clientes Supabase configurados com
     `schema: "carcanhol"` falham com erro de schema não encontrado.

6. Criar o(s) utilizador(es) manualmente (não há registo público):
   - Supabase Dashboard → **Authentication** → **Users** → **Add user** →
     definir email + palavra-passe.

7. Correr o servidor de desenvolvimento:

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
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_SCHEMA`).
3. Deploy — o Vercel deteta automaticamente o Next.js, `npm run build`
   corre sem passos adicionais.

## Autenticação — nota de âmbito

Esta fase implementa **apenas login** (email/password), sem registo
público. As contas são criadas manualmente pelo administrador no Supabase
Dashboard. As rotas `/dashboard` (e futuras rotas de negócio) são protegidas
por `middleware.ts`, que redireciona utilizadores não autenticados para
`/login`.
