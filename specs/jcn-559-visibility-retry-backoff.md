# sqs-consumer: backoff exponencial por visibility para mensajes fallidos

> Repos: `packages/sqs-consumer` (branch `JCN-559-visibility-retry-backoff`) · `packages/sls-helper-plugin-janis` (branch `JCN-559-sqs-change-visibility-permission`) · Ticket: [JCN-559](https://janiscommerce.atlassian.net/browse/JCN-559)
> Estado: aprobado · Creado: 2026-10-06

## Objetivo

Los consumers pueden activar un backoff exponencial con jitter para los mensajes fallidos con un getter `retryBackoff`. El mensaje fallido vuelve a la cola tras un delay creciente en vez de la visibility fija. `sls-helper-plugin-janis` suma el permiso `sqs:ChangeMessageVisibility` por default.

## Contexto

- magento-pricing (JPS-452) y vtex-pricing (JPS-463, v1.96.0) tienen cada uno una copia de `src/helpers/retry-backoff.js`. Difieren en base/max (60/900 vs 300/7200), en `minDelaySeconds` y en `isLastAttempt` (solo vtex).
- Con visibility fija, los reintentos vuelven en olas sincronizadas. vtex-pricing midió 2,0–4,35 receives por mensaje terminado en ráfagas de 429. magento-pricing mandó 1.153 mensajes a la DLQ en una congestión de 32 min.
- `SQSHandler.handle()` (`lib/sqs-handler.js:77`) ya tiene `event.Records` (`receiptHandle`, `eventSourceARN`, `attributes.ApproximateReceiveCount`) y los failed (`this.results`).
- Los consumers reciben el record parseado. `ApproximateReceiveCount` se lee del record original del evento, por `messageId`.

## Alcance

✅ Incluye:
- Getter opt-in `retryBackoff` en el consumer: `{ baseDelaySeconds, maxDelaySeconds, jitterRatio }`.
- `addFailedMessage(messageId, { minDelaySeconds, delaySeconds })`: segundo parámetro opcional en `SQSConsumer` y `SQSHandler`. Sigue siendo sync.
- `delaySeconds`: delay exacto precalculado por el consumer. Reemplaza la fórmula y el piso; solo se le aplica el tope `maxDelaySeconds`.
- Export público `RetryBackoff` en `lib/index.js` con `getAttempt(record)` y `getRetryDelaySeconds(attempt, config, minDelaySeconds)`. `config` acepta la misma forma que el getter y completa defaults. Permite que magento-pricing precalcule el delay, lo guarde (`nextRetryDate`) y lo pase con `delaySeconds`.
- Cálculo del delay: `base × 2^(attempt − 1)`, jitter ±`jitterRatio`, piso `minDelaySeconds`, tope `maxDelaySeconds` aplicado al final. Resultado entero. `attempt` = `ApproximateReceiveCount` (inválido o ausente = 1).
- Aplicación al final de `handle()`, después de `janiscommerce.ended` y antes de devolver `batchItemFailures`. `ChangeMessageVisibilityBatch` en chunks de 10 por cola, en paralelo. Queue URL derivada del `eventSourceARN`. Cliente SQS por región del ARN, con X-Ray como en `S3Downloader`.
- Detección de `AccessDenied` (error de la llamada o `Code` de una entry): un `logger.error` por container y backoff deshabilitado en ese container.
- Cola FIFO (ARN termina en `.fifo`): sin cambio de visibility y un warn por container.
- Log de resumen por invocación (`lllog`): cantidad con backoff, rango de attempt, rango de delay, cantidad de fallos de visibility.
- Tipos (`types/`) regenerados con `npm run build-types`.
- Dependencia `@aws-sdk/client-sqs`. Dev: `aws-sdk-client-mock` ya está.
- README de `sqs-consumer`: uso del getter, `minDelaySeconds`, requisito de permiso y versión mínima del plugin.
- `sls-helper-plugin-janis`: `sqs:ChangeMessageVisibility` en `SQSHelper.sqsPermissions`, test en `tests/unit/hook-builder/sqs.js` y los 3 bloques del README que listan los permisos.

❌ NO incluye:
- Rate limit compartido (Mongo): queda en cada service. El package solo recibe el piso `minDelaySeconds`.
- Métricas CloudWatch del package.
- Detección de último intento (`isLastAttempt`), `GetQueueAttributes` o conocimiento de la topología de colas.
- Decidir qué mensajes llevan backoff: aplica a todo lo que pase por `addFailedMessage()`.
- Soporte FIFO.
- Backoff cuando `processBatch` / `processSingleRecord` tira: se propaga el error como hoy.
- Peer dependency o validación en CI/CD de la versión del plugin.
- Migrar magento-pricing y vtex-pricing: tickets propios.
- Release y bump de versión de los dos packages (se hacen después, plugin primero).

## Criterios de aceptación

- [ ] Sin getter, `handle()` devuelve exactamente lo mismo que hoy y no instancia ni llama a SQS.
- [ ] Con getter, cada failed recibe `VisibilityTimeout` = `base × 2^(n−1)` con jitter ±`jitterRatio`, topeado en `maxDelaySeconds`.
- [ ] `minDelaySeconds` sube el delay hasta el piso, y el piso también queda topeado en `maxDelaySeconds`.
- [ ] Un mensaje no failed nunca recibe cambio de visibility.
- [ ] Más de 10 failed de una cola → varias llamadas de a 10. Failed de colas distintas → una llamada por cola.
- [ ] Falla parcial (`Failed` en la respuesta) o total (la llamada tira) → el mensaje sigue en `batchItemFailures` y hay warn.
- [ ] `AccessDenied` → un solo `error` por container con el texto `retryBackoff requires sqs:ChangeMessageVisibility: update sls-helper-plugin-janis >= <versión>`. Las invocaciones siguientes del container no llaman a SQS.
- [ ] Cola FIFO → sin llamada a SQS y un warn.
- [ ] Si el handler tira, no hay llamada a SQS.
- [ ] Modo single: solo los mensajes de `addFailedMessage()` reciben backoff.
- [ ] `addFailedMessage(id, { delaySeconds })` → `VisibilityTimeout` = `delaySeconds` topeado en `maxDelaySeconds`, sin jitter.
- [ ] `require('@janiscommerce/sqs-consumer').RetryBackoff.getRetryDelaySeconds(attempt, { baseDelaySeconds: 300 })` devuelve el mismo cálculo que usa el handler.
- [ ] Log de resumen por invocación con backoff aplicado.
- [ ] `sls-helper-plugin-janis` incluye `sqs:ChangeMessageVisibility` en `sqsPermissions`, con test.
- [ ] README de los dos packages actualizado. Tipos de `sqs-consumer` regenerados.
- [ ] Lint y tests verdes en los dos repos, coverage de `sqs-consumer` sin bajar.

## Plan de archivos

`packages/sqs-consumer`:
- `lib/helpers/retry-backoff.js` (nuevo) — config, cálculo de delay, chunking por cola, `ChangeMessageVisibilityBatch`, estado por container (AccessDenied, FIFO warn).
- `lib/sqs-handler.js` (edit) — lee el getter, guarda `minDelaySeconds` por failed, aplica el backoff al final de `handle()`.
- `lib/sqs-consumer.js` (edit) — `addFailedMessage(messageId, options)`.
- `lib/index.js` (edit) — export `RetryBackoff`.
- `tests/helpers/retry-backoff.js` (nuevo), `tests/sqs-handler.js` (edit).
- `types/**` (regenerado), `package.json` + `package-lock.json` (dep), `README.md`.

`packages/sls-helper-plugin-janis`:
- `lib/sqs-helper/*.js` (edit) — `sqsPermissions`.
- `tests/unit/hook-builder/sqs.js` (edit), `README.md` (edit).

## Decisiones

- Del ticket: opt-in por getter (minor), sin detección de último intento, nunca rechaza por fallas de visibility, FIFO no soportado, release plugin → sqs-consumer.
- Campos faltantes del getter toman default: `baseDelaySeconds: 60`, `maxDelaySeconds: 900`, `jitterRatio: 0.2` (valores de vtex-pricing). El getter puede devolver `{}`.
- Config inválida (no numérica, `base <= 0`, `base > max`, `max > 42300`, `jitterRatio` fuera de `[0, 1)`) → `error` una vez por container y backoff deshabilitado. No tira: un error de config no debe reprocesar el batch entero.
- `messageId` failed que no está en `event.Records` → queda failed, sin visibility, cuenta como fallo en el log de resumen.
- Review (opción a): magento-pricing guarda el delay en el doc antes de publicar. El package acepta el delay exacto y expone los helpers puros para que magento borre su copia. vtex-pricing debe re-llamar `addFailedMessage` al final para refrescar el piso del rate limit (gana el último): va al ticket de migración.
- `addFailedMessage` repetido para el mismo `messageId` → gana el último `minDelaySeconds`/`delaySeconds` y el mensaje recibe un solo cambio de visibility. `batchItemFailures` no cambia respecto de hoy.
- `AccessDenied` se detecta por `error.name`/`Code` `AccessDenied` o `AccessDeniedException` (el SDK v3 sobre protocolo JSON puede devolver cualquiera).
- El backoff corre después de `janiscommerce.ended`: los logs del consumer ya están emitidos y la latencia extra no afecta su flush.

- Review: `undefined`, `null` y `false` en el getter apagan el backoff sin log. `max` se valida contra 42300 (12 h − 15 min de Lambda): SQS cuenta las 12 h desde la recepción. Todo delay (fórmula o `delaySeconds`) queda en `[1, max]`. `@aws-sdk/client-sqs` se carga lazy. `RetryBackoff` es una clase con métodos estáticos (standard de packages). `handle()` envuelve el backoff en try/catch.

## Abiertas

—
