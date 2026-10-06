# Plan — JCN-559 visibility retry backoff

> Spec: `specs/jcn-559-visibility-retry-backoff.md` (aprobado 2026-10-06)

Orden entre repos: plugin primero (el release del plugin va antes que `sqs-consumer`). Los batches de `sqs-consumer` no dependen del código del plugin.

## Batch 1 ✅ (5af29c7) — plugin: permiso `sqs:ChangeMessageVisibility` (`sls-helper-plugin-janis`)

- [x] `lib/sqs-helper/index.js` — sumar `sqs:ChangeMessageVisibility` a `sqsPermissions`.
- [x] `tests/unit/hook-builder/sqs.js` (y cualquier otro test que asserte la lista) — actualizar.
- [x] `README.md` — los 3 bloques que listan los permisos.
- Verifica: `npm run lint` + `npm test` verdes.

## Batch 2 ✅ (915d653) — sqs-consumer: helper `lib/helpers/retry-backoff.js`

Depende de: nada.

- [x] Dependencia `@aws-sdk/client-sqs` (`package.json` + lock).
- [x] Normalización/validación de config (defaults 60/900/0.2; inválida → `null` + motivo).
- [x] `getAttempt(record)`, `getRetryDelaySeconds(attempt, config, minDelaySeconds)`.
- [x] Queue URL desde ARN, detección FIFO, chunking de a 10 por cola, `ChangeMessageVisibilityBatch` en paralelo, cliente por región con X-Ray.
- [x] Clasificación de fallos: entry `Failed`, error de llamada, `AccessDenied`/`AccessDeniedException`.
- [x] `tests/helpers/retry-backoff.js`.
- Verifica: lint + tests, coverage del helper 100 %.

## Batch 3 ✅ (f6ccf19) — sqs-consumer: integración en el handler + docs

Depende de: Batch 2.

- [x] `lib/sqs-consumer.js` y `lib/sqs-handler.js` — `addFailedMessage(messageId, { minDelaySeconds })`; `minDelaySeconds` por `messageId` (gana el último).
- [x] `lib/sqs-handler.js` — leer el getter; aplicar al final de `handle()` solo sobre failed, solo si no tiró; estado por container (AccessDenied → deshabilitado, FIFO → warn una vez, config inválida → error una vez); log de resumen.
- [x] `tests/sqs-handler.js` — criterios de aceptación del spec.
- [x] `README.md` — getter, `minDelaySeconds`, permiso y versión mínima del plugin.
- [x] `types/` — `npm run build-types` (está en `.gitignore`: se genera en el publish, no se commitea).
- Verifica: lint + suite completa + coverage sin bajar.

## Batch 3b ✅ (09f9846, abb674e) — fixes del code review

- [x] Getter que tira → config inválida. `delaySeconds` exacto, export `RetryBackoff`, `null`/`false` apagan, tope 42300, mínimo 1 s, try/catch en `handle()`.

## Batch 4 — refactor de estructura (review del usuario)

Depende de: Batch 3b.

- [ ] `lib/helpers/retry-backoff.js` → `lib/retry-backoff/` con `index.js` (`RetryBackoff`), `config.js` (`RetryBackoffConfig`, superstruct), `delay.js` (`RetryDelay`), `visibility-changer.js` (`VisibilityChanger`).
- [ ] Sin `WeakMap`: estado estático plano en `RetryBackoff`. Sin `global-require`. Sin `function` sueltas; constantes como static getters.
- [ ] `sqs-handler.js`: solo `RetryBackoff.apply(...)` dentro del try/catch; logs y estado se mudan a `RetryBackoff`.
- [ ] `lib/index.js` exporta `RetryBackoff` desde la ubicación nueva. API pública sin cambios.
- [ ] Tests reorganizados por archivo; coverage 100 %.

## Pendiente de release

- Versión mínima del plugin en el mensaje de error y en el README: placeholder `11.6.0` (minor sobre 11.5.1). Confirmar al releasear el plugin (JCN-557 puede salir antes).
- `MIN_PLUGIN_VERSION` vive en `lib/sqs-handler.js`, `README.md` y el texto esperado de `tests/sqs-handler.js`.
