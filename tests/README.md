# Tests

`npm test` usa o test runner nativo do Node.js, sem dependências adicionais.
A suite atual cobre parsing estrito da chave de 32 bytes, round-trip e
autenticação de contexto AES-256-GCM, rejeição de envelopes adulterados e os
schemas de credenciais/endpoints das contas LLM.

Lint, type-check e build continuam a ser executados separadamente no CI.
