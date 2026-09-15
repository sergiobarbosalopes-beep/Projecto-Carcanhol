# Tests

`npm test` usa o test runner nativo do Node.js e executa também a suite do
worker. A cobertura inclui:

- parsing e autenticação de contexto AES-256-GCM;
- schemas de credenciais/endpoints;
- criação bloqueada quando a validação real falha;
- concorrência bounded e coalescimento da auto-validação;
- HMAC, timestamp, body hash, comparação constant-time e replay;
- schema estrito/CORS fechado e ausência do PAT nas respostas;
- sanitização de modelos, policy, timeout e error mapping;
- invariantes da migration 0005 para transação, sync/stale e stale writes.

O adapter do SDK é substituído por mocks em CI. O teste real é deliberadamente
separado e requer `COPILOT_REAL_TEST_TOKEN`:

```bash
npm run test:real --prefix services/copilot-worker
```

Lint, type-check, builds Next/worker e container continuam separados no CI.
