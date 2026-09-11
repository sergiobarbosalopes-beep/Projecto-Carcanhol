# Documento de Arquitetura — Plataforma de Análise e Recomendação de Investimentos com IA

Versão: 1.0 (consolidado após 1ª ronda de discussão)
Estado: em validação iterativa com o utilizador — sujeito a alterações

---

## 1. Objetivo do projeto

Aplicação web de apoio à decisão de investimento, com foco em **análise temática/sectorial**
(ex.: "energia", "IA", "GPU", "semicondutores") combinando:

- Dados financeiros reais de instrumentos (ações, ETFs, obrigações, CFDs, opções, futuros);
- Conjuntura macroeconómica, política, geográfica e social relevante para o tema/sector pedido;
- Um LLM (via GitHub Models API, conta Copilot empresarial) que raciocina sobre esses dados
  através de "Skills" especializadas e "tools" (function calling), nunca como fonte primária
  de dados financeiros.

O utilizador pede análises orientadas a mercado/tema (não screening genérico e abrangente).
Uso inicial pessoal (1 utilizador), com arquitetura pronta para evoluir para multiutilizador.

---

## 2. Arquitetura de alto nível

```
UTILIZADOR (desktop / tablet / telemóvel)
        │
        ▼
┌─────────────────────────────────────────┐
│  Next.js App (App Router) — 1 repo        │
│  ┌───────────────────────────────────┐   │
│  │ /app/(frontend)                    │   │  UI responsiva PT
│  │  - Dashboard, Pesquisa, Chat,      │   │
│  │    Instrument detail, Watchlists   │   │
│  └───────────────────────────────────┘   │
│  ┌───────────────────────────────────┐   │
│  │ /app/api  (Route Handlers = backend)│  │  TypeScript
│  │  - Controllers → Services → Tools  │   │
│  │  - Auth guard (Supabase session)   │   │
│  │  - Agent Orchestrator (LLM tools)  │   │
│  └───────────────────────────────────┘   │
└───────┬─────────────┬─────────┬──────────┘
        │              │             │
        ▼              ▼             ▼
   Supabase       GitHub Models   Fontes de dados
   (DB/Auth/RLS)  API (LLM)       públicas e gratuitas:
                                   - Preços/fundamentais
                                     (Yahoo, Stooq, OpenFIGI…)
                                   - Contexto macro/político/social
                                     (GDELT, Eurostat, World Bank)

Deploy: GitHub (código + CI Actions) → Vercel (build/deploy automático, free tier)
Custos assumidos: apenas GitHub + Supabase
```

**Nota de design:** frontend e backend partilham o mesmo projeto Next.js e o mesmo deploy
Vercel (custo/operação mínimos), mas mantêm separação lógica estrita: nenhum secret,
chave de API ou service-role key do Supabase é acessível no lado do cliente. Toda a
comunicação sensível passa por Route Handlers server-side.

---

## 3. Padrão de orquestração do LLM: Function/Tool Calling

Em vez de um fluxo rígido "classificar intenção → buscar dados → gerar resposta" controlado
manualmente pelo backend, o LLM opera como **agente** dentro de uma única sessão de conversa,
com acesso a um conjunto de "tools" que o próprio LLM decide invocar:

```typescript
// Tools expostas ao LLM (implementadas pelo backend, executadas sob pedido do LLM)
type Tool =
  | { name: "search_instruments"; run(query: string): Promise<Instrument[]> }
  | { name: "get_quote"; run(symbol: string): Promise<PriceQuote> } // "tempo real" on-demand
  | { name: "get_fundamentals"; run(symbol: string): Promise<FundamentalData> }
  | {
      name: "get_macro_context";
      run(topic: string, country?: string): Promise<MacroSignal[]>;
    }
  | { name: "load_skill"; run(skillName: string): Promise<string> } // conteúdo do SKILL.md
  | { name: "list_skills"; run(): Promise<SkillSummary[]> };

interface LLMProvider {
  runAgentSession(request: AgentRequest, tools: Tool[]): Promise<AgentResponse>;
}
```

**Regras críticas de integridade de dados (obrigatórias):**

1. O LLM pode **propor** candidatos a instrumentos por tema/sector com base no seu conhecimento
   geral (ex.: "empresas de energia solar"), mas **cada candidato tem de ser verificado** via
   `get_quote`/`get_fundamentals` antes de aparecer na resposta final ao utilizador.
2. Não há taxonomia fixa de sectores/temas no backend — a identificação de "que instrumentos
   pertencem a este tema" é feita pelo próprio LLM, sujeita à regra 1.
3. Dados financeiros "atuais" (preços, métricas) nunca vêm do conhecimento do LLM — só de
   tool calls a fontes externas reais.
4. O LLM nunca executa operações financeiras (é analista/assistente, não executor).

---

## 4. Fontes de dados (todas gratuitas, selecionadas dinamicamente)

Em vez de um único `FinancialDataProvider` fixo, existe um **registry de providers**:
cada fonte regista-se com metadados (tipos de ativo suportados, região, fiabilidade),
e a seleção de qual(is) usar acontece em runtime (dentro das tool calls do agente,
com fallback em cadeia se uma fonte falhar/estiver rate-limited).

| Categoria                           | Fontes candidatas (grátis)                                                      | Observações                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Preços / fundamentais               | Yahoo Finance (endpoints públicos), Stooq                                       | Yahoo não é API oficial — risco de instabilidade; cache no Supabase mitiga |
| Identificadores                     | OpenFIGI                                                                        | Mapeamento ISIN/ticker                                                     |
| Contexto político/social/geográfico | GDELT Project                                                                   | Eventos globais, tom de notícias, por país/tema                            |
| Contexto macroeconómico             | Eurostat, World Bank, IMF                                                       | Indicadores por país                                                       |
| Obrigações/CFDs/opções/futuros      | A validar por sector — cobertura gratuita mais fraca; esperar lacunas no início |

**Broker (nota informativa, baixa prioridade):** menção estática, não um provider dedicado.
Referência simples "este ativo pode estar disponível em: XTB / DeGiro / Revolut" — tabela
curada e revista manualmente, implementada apenas numa fase tardia, sem tempo real.

---

## 5. Skills

Mantidas como estava previsto no esboço original — pasta `/skills` no repositório,
cada uma com `SKILL.md` (objetivo, contexto, regras, metodologia, dados necessários,
limitações, formato de resposta). A diferença face ao esboço original é **como** são
selecionadas: o LLM usa a tool `list_skills`/`load_skill` para as descobrir e carregar
por si mesmo durante a sessão do agente, em vez de uma classificação prévia determinística
feita pelo backend.

Skills iniciais sugeridas (Fase 1, dado o foco em análise sectorial/temática):

- `sector-thematic-analysis` (nova, central ao caso de uso principal)
- `stock-analysis`
- `etf-analysis`
- `macro-context-analysis` (nova, para cruzar GDELT/Eurostat com o tema pedido)
- `risk-analysis`

---

## 6. Modelo de dados (Supabase) — multi-ativo

```
instruments
  id, symbol, isin, name, asset_type (stock|etf|bond|cfd|option|future),
  exchange, country, currency, active, created_at, updated_at

instrument_equity_data / instrument_etf_data / instrument_bond_data / instrument_derivative_data
  (colunas específicas por tipo de ativo — extensão 1:1 de instruments)

prices
  instrument_id, timestamp, price, source, pulled_on_demand (bool)

macro_signals
  country, topic, tone, source (gdelt|eurostat|world_bank), timestamp

broker_notes            -- baixa prioridade, fase tardia
  instrument_id, broker_name, country, last_verified_at

users                    -- Supabase Auth
watchlists / watchlist_items
analyses
  id, user_id, request, agent_trace (tools chamadas), response, created_at
```

NOTA IMPORTANTE PARA ESTA IMPLEMENTAÇÃO: todas estas tabelas devem viver no schema "carcanhol", não no schema public, porque o projeto Supabase é partilhado com outras aplicações do utilizador. Nesta Fase 1 só precisas de criar o schema e a tabela de perfil (profiles) — as restantes tabelas (instruments, prices, etc.) ficam para fases posteriores.

RLS ativo desde o início (mesmo com 1 utilizador), preparando multiutilizador futuro.

---

## 7. Segurança (herdado do esboço original, mantido)

- Nenhuma API key/secret no frontend nem no GitHub — só em env vars do Vercel/backend.
- `.env.example` documentado, `.env` no `.gitignore`.
- Validação de inputs (Zod).
- RLS no Supabase por `user_id`.
- Nunca enviar credenciais financeiras ao LLM.
- LLM nunca executa transações — apenas analisa/sugere.

---

## 8. Fases (ajustadas ao foco em análise sectorial/temática)

1. **Foundation** — repo, Next.js app, ligação Supabase, env vars, CI básico, login. ← ESTAMOS AQUI
2. **LLM + Agent loop** — GitHub Models SDK, `LLMProvider`, tool-calling framework, `/api/chat`.
3. **Skills** — estrutura de carregamento, primeiras Skills (destacando `sector-thematic-analysis`).
4. **Financial data + Macro context** — registry de providers, adapters Yahoo/Stooq/OpenFIGI, GDELT/Eurostat.
5. **Análise temática end-to-end** — caso de uso central: "recomenda-me ativos do sector de energia
   tendo em conta conjuntura atual" funcionando ponta a ponta.
6. **Frontend detalhado** — dashboard, pesquisa, chat, watchlists, gráficos.
7. **Segurança e produção** — RLS afinado, rate limiting, logging, CI/CD completo.

---

## 9. Decisões funcionais para fases futuras (registadas antecipadamente)

> **Nota:** esta secção documenta decisões de produto/arquitetura já validadas
> com o utilizador para iterações futuras. **Nada aqui é implementado na
> Fase 1** — são apenas registos para orientar o desenho de UI/BD quando as
> fases correspondentes (ver secção 8) forem executadas.

### 9.1 Navegação e estrutura de página (fase de frontend detalhado)

- Navegação principal futura: **Início, Pesquisa, Chat, Análises,
  Administração**.
- **Fora do âmbito atual**: watchlist e atividade recente não fazem parte
  da navegação nem da home nesta iteração de desenho.
- **Home minimalista**: apenas atalhos/acessos rápidos para Pesquisa, Chat,
  Análises e Administração. Sem "market pulse", sem indicadores de mercado
  na home.

### 9.2 Direção visual (fase de frontend detalhado)

- Layout financeiro **moderno e sóbrio**, fundo claro, paleta em
  azul-petróleo/verde.
- Densidade de informação **compacta**, mas progressivamente expansível
  (i.e. vistas resumidas com possibilidade de expandir detalhe, não tudo
  espalhado por omissão).
- **Sidebar recolhível** em desktop.
- Em iPhone/iPad: **drawer/menu adaptativo** (não a mesma sidebar de
  desktop).
- Mobile-first; nenhuma interação pode depender de hover (tudo acessível
  por tap/click/foco).

### 9.3 Administração — estrutura da página (3 tabs)

- Administração é uma **única página com 3 tabs**: **Conta**, **Premissas
  globais**, **Skills**.
- Em mobile, as tabs adaptam-se a uma das seguintes formas (a decidir em
  desenho de UI dessa fase, ambas aceitáveis): **navegação horizontal
  rolável** (tabs em linha, scroll horizontal) ou **seletor compacto**
  (ex.: dropdown/segmented control). Em qualquer dos casos, mobile-first e
  sem depender de hover.

### 9.4 Administração — Conta

- Tab "Conta": permite ver/alterar **email** e **alterar palavra-passe**
  exclusivamente através do **Supabase Auth** (`supabase.auth.updateUser`
  ou equivalente).
- **Nunca** guardar ou gerir palavras-passe numa tabela própria da
  aplicação — a gestão de credenciais fica inteiramente do lado do
  Supabase Auth.

### 9.5 Administração — Premissas Globais da IA

- Tab "Premissas globais": um **único editor de texto livre** (não
  estruturado em campos) para as premissas/instruções globais que
  orientam o comportamento do LLM.
- **Sem histórico de versões** — existe apenas a versão atual/ativa;
  substituir é editar essa versão única (sem log de revisões nesta
  iteração).
- O backend injeta a versão ativa das Premissas Globais **numa camada
  superior ao pedido do utilizador** em todas as sessões do agente LLM
  (i.e. como contexto/system-level, antes/acima da mensagem do
  utilizador), não como algo que o utilizador possa ver ou editar
  diretamente na conversa.

### 9.6 Administração — Skills: modelo e ciclo de vida

- Tab "Skills": **Supabase passa a ser a fonte oficial em runtime** para as
  Skills que o agente LLM carrega (via `list_skills` / `load_skill`) a
  partir da fase em que Skills forem implementadas.
- A pasta `/skills` no repositório GitHub deixa de ser a fonte de runtime e
  passa a conter apenas **templates, seeds e documentação** (ponto de
  partida para popular a base de dados, não o que é lido em produção).
- `list_skills` / `load_skill` devem ler **apenas Skills com estado
  `active`** da base de dados.
- **Modelo de dados de cada Skill**: campos separados `name`,
  `description`, `status`, mais um **único editor Markdown** para o
  conteúdo/instruções da Skill (equivalente ao corpo de um `SKILL.md`).
- **Estados**: `draft` (rascunho, não visível ao agente), `active`
  (carregável pelo agente), `inactive` (desativada, preservada) e
  `archived` (arquivada, preservada, fora da gestão ativa do dia a dia).
- **Gestão de ciclo de vida na Administração** — CRUD completo (visualizar
  conteúdo, criar, editar) mais as seguintes ações de estado:
  - **Desativar** (`active` → `inactive`).
  - **Arquivar / Restaurar** (para/de `archived`).
  - **Eliminar definitivamente** (hard delete) — o utilizador optou por
    ter **ambas** as opções, arquivar _e_ eliminar definitivamente (não
    apenas arquivar). Regras:
    - Exige **confirmação reforçada** (ex.: diálogo de confirmação
      distinto do habitual, podendo pedir para escrever o nome da Skill
      ou equivalente) antes de executar.
    - Uma Skill em estado `active` **tem de ser desativada primeiro**
      (`inactive`) antes de poder ser eliminada definitivamente — não é
      possível eliminar diretamente uma Skill ativa.

### 9.7 Criação/alteração de Skills assistida por LLM

- Fluxo dedicado (chat próprio, distinto do chat de análise de
  investimento): o utilizador descreve o que quer numa Skill em
  linguagem natural; o LLM gera uma Skill estruturada (equivalente a um
  `SKILL.md`) e apresenta uma **pré-visualização editável** ao
  utilizador.
- O utilizador tem de escolher explicitamente uma de duas ações antes de
  qualquer persistência ter efeito real no agente:
  - **Guardar como rascunho** (estado `draft`) — não fica disponível ao
    agente.
  - **Guardar e ativar** (estado `active`) — fica imediatamente
    disponível ao agente.
- **Nunca ativar uma Skill automaticamente** sem esta escolha explícita do
  utilizador.

---

## 10. Notas de implementação da Fase 1 (Foundation)

Decisões técnicas tomadas ao implementar esta fase, não 100% especificadas no
documento original:

- **Sem página de registo pública.** Apenas login (email/password). Contas
  são criadas manualmente pelo utilizador no Supabase Dashboard
  (Authentication → Users). Confirmado explicitamente com o utilizador.
- **Tailwind CSS v4** usa configuração CSS-first (`@import "tailwindcss"` +
  `@theme` em `app/globals.css`), pelo que não existe `tailwind.config.ts`
  separado — é a forma recomendada pela própria ferramenta na versão atual.
- **`@supabase/ssr`** é usado para os clientes browser/server, seguindo o
  padrão oficial recomendado pela Supabase para Next.js App Router
  (cookies de sessão geridos automaticamente, incluindo no middleware).
- **Trigger `carcanhol_on_auth_user_created`** em `auth.users` cria automaticamente a
  linha correspondente em `carcanhol.profiles`, para que o perfil exista
  desde o primeiro login sem lógica adicional no frontend.
- **Rota `/` faz apenas redirect** para `/dashboard` (autenticado) ou
  `/login` (não autenticado) — não existe landing page pública nesta fase.
