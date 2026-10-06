# Plan — JCN-559 visibility retry backoff

> Spec: `specs/jcn-559-visibility-retry-backoff.md` (aprobado 2026-10-06)

Orden entre repos: plugin primero (el release del plugin va antes que `sqs-consumer`). Los batches de `sqs-consumer` no dependen del código del plugin.

## Batch 1 — plugin: permiso `sqs:ChangeMessageVisibility` (`sls-helper-plugin-janis`)

- [ ] `lib/sqs-helper/index.js` — sumar `sqs:ChangeMessageVisibility` a `sqsPermissions`.
- [ ] `tests/unit/hook-builder/sqs.js` (y cualquier otro test que asserte la lista) — actualizar.
- [ ] `README.md` — los 3 bloques que listan los permisos.
- Verifica: `npm run lint` + `npm test` verdes.

## Batch 2 — sqs-consumer: helper `lib/helpers/retry-backoff.js`

Depende de: nada.

- [ ] Dependencia `@aws-sdk/client-sqs` (`package.json` + lock).
- [ ] Normalización/validación de config (defaults 60/900/0.2; inválida → `null` + motivo).
- [ ] `getAttempt(record)`, `getRetryDelaySeconds(attempt, config, minDelaySeconds)`.
- [ ] Queue URL desde ARN, detección FIFO, chunking de a 10 por cola, `ChangeMessageVisibilityBatch` en paralelo, cliente por región con X-Ray.
- [ ] Clasificación de fallos: entry `Failed`, error de llamada, `AccessDenied`/`AccessDeniedException`.
- [ ] `tests/helpers/retry-backoff.js`.
- Verifica: lint + tests, coverage del helper 100 %.

## Batch 3 — sqs-consumer: integración en el handler + docs

Depende de: Batch 2.

- [ ] `lib/sqs-consumer.js` y `lib/sqs-handler.js` — `addFailedMessage(messageId, { minDelaySeconds })`; `minDelaySeconds` por `messageId` (gana el último).
- [ ] `lib/sqs-handler.js` — leer el getter; aplicar al final de `handle()` solo sobre failed, solo si no tiró; estado por container (AccessDenied → deshabilitado, FIFO → warn una vez, config inválida → error una vez); log de resumen.
- [ ] `tests/sqs-handler.js` — criterios de aceptación del spec.
- [ ] `README.md` — getter, `minDelaySeconds`, permiso y versión mínima del plugin.
- [ ] `types/` — `npm run build-types`.
- Verifica: lint + suite completa + coverage sin bajar.

## Pendiente de release

- Versión mínima del plugin en el mensaje de error y en el README: placeholder `11.6.0` (minor sobre 11.5.1). Confirmar al releasear el plugin (JCN-557 puede salir antes).
