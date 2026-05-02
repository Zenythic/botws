# CashIn Processor — Guía de Integración para Clientes

## Visión General

El servicio permite dos flujos principales:

- **CashIn**: registrar expectativas de cobro y recibir notificaciones automáticas cuando llega un pago.
- **PayOut**: solicitar pagos salientes a una cuenta destino y recibir el comprobante vía webhook.

---

## Autenticación

Todos los endpoints requieren el header:

```
X-API-Key: {tu-api-key}
```

La API Key es provista por el equipo de integración. Se almacena hasheada (SHA-256) en el sistema.

---

## Base URL

| Ambiente    | URL                                               |
|-------------|---------------------------------------------------|
| Producción  | `https://ingress.soportecallcenter.com`           |
| Staging     | Consultar al equipo de integración                |

---

## Flujo CashIn

```
1. Obtener tu CVU via GET /api/v1/cvu y compartirlo con tus pagadores
2. Registrar un CashIn Request (qué CUIT esperás recibir)
3. El pagador hace la transferencia a tu CVU
4. El sistema detecta el pago desde el PSP y lo matchea con tu request por CUIT
5. El sistema notifica a tu CallbackUrl con los datos del pago
```

Si el request vence sin haber sido matcheado, el sistema también te notifica con evento `EXPIRED`.

---

## Flujo PayOut

```
1. Crear un pago saliente via POST /api/v1/payout/requests
2. El sistema procesa la transferencia (fondos de tu cuenta recaudadora → cuenta destino)
3. El sistema notifica a tu CallbackUrl con el comprobante (html/base64/stringbase64)
```

---

## Endpoints CashIn

### 1. Registrar CashIn Request

Registra la expectativa de recibir un pago de un CUIT determinado.

```
POST /api/v1/cashin-requests
```

**Body:**
```json
{
  "cuit": "20123456789",
  "accountNumber": "0000123456",
  "currency": "032",
  "expectedAmount": 1500.00,
  "expiresAt": "2026-03-26T23:59:59Z",
  "clientCallbackUrl": "https://tu-sistema.com/webhook/cashin",
  "nombre": "Juan Perez",
  "referenciaString": "ORDEN-001",
  "referenciaInt": 12345
}
```

**Campos:**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `cuit` | string | Sí | CUIT del pagador sin guiones (ej: `20123456789`) |
| `accountNumber` | string | Sí | Número de cuenta destino |
| `currency` | string | No | Código de moneda. Default: `032` (ARS) |
| `expectedAmount` | decimal | No | Monto esperado. Informativo — no afecta el matching |
| `expiresAt` | datetime ISO 8601 UTC | No | Vencimiento del request. Default: **30 minutos** desde la recepción |
| `clientCallbackUrl` | string | No | URL para recibir la notificación. Si no se envía usa la URL configurada en el contrato |
| `nombre` | string | No | Nombre del pagador (referencial) |
| `referenciaString` | string | No | Tu identificador externo en texto (te lo devolvemos en el callback) |
| `referenciaInt` | long | No | Tu identificador externo numérico (te lo devolvemos en el callback) |

**Respuesta exitosa `201 Created`:**
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"
}
```

---

### 2. Consultar Estado de un CashIn Request

```
GET /api/v1/cashin-requests/{id}
```

**Respuesta exitosa `200 OK`:**
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "cuit": "20123456789",
  "accountNumber": "0000123456",
  "currency": "032",
  "expectedAmount": 1500.00,
  "status": "Matched",
  "expiresAt": "2026-03-26T23:59:59Z",
  "matchedAt": "2026-03-26T18:45:22Z",
  "createdAt": "2026-03-26T18:30:00Z"
}
```

**Estados posibles (`status`):**

| Estado | Descripción |
|--------|-------------|
| `Pending` | Esperando el pago. El sistema reintenta matchear hasta que vence el request |
| `Matched` | Pago detectado y matcheado exitosamente |
| `Cancelled` | Request vencido sin match — recibirás un callback con evento `EXPIRED` |

---

### 3. Consultar CVU

Devuelve el CVU, Alias y Nombre de tu cuenta recaudadora. Compartí este CVU con tus pagadores para que puedan hacerte transferencias.

```
GET /api/v1/cvu
```

**Respuesta exitosa `200 OK`:**
```json
{
  "cvu": "0000338200000000017859",
  "alias": "empresa.alias.mp",
  "nombre": "Empresa S.A."
}
```

---

## Endpoints PayOut

### 4. Crear un PayOut (pago saliente)

Solicita una transferencia desde tu cuenta recaudadora hacia una cuenta destino.

```
POST /api/v1/payout/requests
```

**Body:**
```json
{
  "destination": "0000003100027270408385",
  "amount": 1000.00,
  "receiptFormat": "html",
  "callbackUrl": "https://tu-sistema.com/webhook/payout"
}
```

**Campos:**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `destination` | string | Sí | CVU o CBU destino del pago (22 dígitos) |
| `amount` | decimal | Sí | Monto a transferir |
| `receiptFormat` | string | No | Formato del comprobante. Ver opciones abajo. Default: `base64` |
| `callbackUrl` | string | No | URL donde recibir el comprobante. Si no se envía usa el callback configurado en el contrato |

**`receiptFormat` — opciones:**

| Valor | Descripción |
|-------|-------------|
| `html` | Comprobante en HTML dentro de un JSON |
| `base64` | Imagen JPEG enviada como body binario (`Content-Type: image/jpeg`) |
| `stringbase64` | Imagen JPEG codificada en base64 dentro de un JSON |

**Respuesta exitosa `202 Accepted`:**
```json
{
  "id": 36309,
  "status": "PENDING",
  "message": "Pago encolado exitosamente",
  "createdAt": "2026-03-26T16:40:11Z"
}
```

Guardá el `id` — lo vas a necesitar para consultar el estado y lo recibirás en el callback.

---

### 5. Consultar Estado de un PayOut

```
GET /api/v1/payout/requests/{id}
```

**Respuesta exitosa `200 OK`:**
```json
{
  "id": 36309,
  "status": "COMPLETED",
  "isSuccessful": true,
  "destination": "0000003100027270408385",
  "amount": 1000.00,
  "cvuPago": "0000338200000000017860",
  "source": "api",
  "createdDate": "2026-03-26T16:40:11Z",
  "modifiedDate": "2026-03-26T16:41:05Z",
  "jsonCashOut": "{...resultado de la transferencia...}"
}
```

**Estados posibles (`status`):**

| status | isSuccessful | Descripción |
|--------|-------------|-------------|
| `PENDING` | — | Pago encolado, aún no procesado |
| `COMPLETED` | `true` | Transferencia exitosa |
| `COMPLETED` | `false` | Procesado pero con error |

---

### 6. Listar PayOuts

```
GET /api/v1/payout/requests?isCompleted=false&page=1&pageSize=20
```

**Query params opcionales:**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `isCompleted` | bool | Filtrar por completados (`true`) o pendientes (`false`) |
| `from` | datetime | Fecha de inicio (UTC) |
| `to` | datetime | Fecha de fin (UTC) |
| `page` | int | Número de página. Default: `1` |
| `pageSize` | int | Registros por página. Max: `100`. Default: `20` |

**Respuesta `200 OK`:**
```json
{
  "page": 1,
  "pageSize": 20,
  "total": 42,
  "items": [ ... ]
}
```

---

## Endpoints de Notificaciones

### 7. Ver Notificaciones Fallidas

Lista los tickets de notificación que fallaron (no pudieron entregarse a tu CallbackUrl después de 10 intentos).

```
GET /api/v1/notifications/failed
```

**Respuesta `200 OK`:**
```json
[
  {
    "id": "9de45f11-...",
    "requestId": "3fa85f64-...",
    "cashInId": "7bc12a33-...",
    "callbackUrl": "https://tu-sistema.com/webhook/cashin",
    "status": "Failed",
    "attemptCount": 10,
    "lastAttemptAt": "2026-03-26T19:00:00Z",
    "deliveredAt": null,
    "errorLog": "[{\"attempt\":1,\"httpStatus\":500,...}]",
    "createdAt": "2026-03-26T18:45:22Z"
  }
]
```

> **Nota:** `cashInId` puede ser `null` en notificaciones de expiración (`EXPIRED`), donde no existe un pago asociado.

---

### 8. Reintentar una Notificación Fallida

Fuerza el reintento inmediato de una notificación en estado `Failed`.

```
POST /api/v1/notifications/{id}/retry
```

**Respuesta exitosa `202 Accepted`** (sin body)

---

## Callbacks (Webhooks)

El sistema llama a tu `CallbackUrl` via **HTTP POST** en los siguientes eventos. Tu endpoint debe responder `2xx` para confirmar la recepción.

### Evento: CashIn MATCHED

Cuando un pago entrante es detectado y matcheado con tu request.

```
POST {tu-callback-url}
Content-Type: application/json
```

```json
{
  "requestId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "cashInId": "7bc12a33-1234-5678-abcd-ef0123456789",
  "cuit": "20123456789",
  "nombre": "Juan Perez",
  "amount": 1500.00,
  "currency": "032",
  "pspTransactionId": "TXN-PSP-00123",
  "receivedAt": "2026-03-26T18:44:00Z",
  "matchedAt": "2026-03-26T18:45:22Z"
}
```

Para correlacionar con tu sistema, usá `requestId` — es el `id` que recibiste al crear el CashIn Request.

---

### Evento: CashIn EXPIRED

Cuando un CashIn Request vence (`expiresAt` alcanzado) sin haber sido matcheado. El status del request pasa a `Cancelled`.

```
POST {tu-callback-url}
Content-Type: application/json
```

```json
{
  "event": "EXPIRED",
  "requestId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "referenciaString": "ORDEN-001",
  "referenciaInt": 12345,
  "cuit": "20123456789",
  "expiresAt": "2026-03-26T17:00:00Z",
  "message": "La solicitud expiró sin ser procesada"
}
```

Los campos `referenciaString` y `referenciaInt` corresponden a los valores que enviaste al crear el request — útiles para correlacionar con tus registros internos.

---

### Evento: PayOut COMPLETED (formato `html`)

```
POST {tu-callback-url}
Content-Type: application/json
```

```json
{
  "status": "COMPLETED",
  "id": 36309,
  "data": { "...resultado de la transferencia..." },
  "receipt": {
    "format": "html",
    "content": "<!DOCTYPE html>..."
  }
}
```

---

### Evento: PayOut COMPLETED (formato `stringbase64`)

```
POST {tu-callback-url}
Content-Type: application/json
```

```json
{
  "status": "COMPLETED",
  "id": 36309,
  "data": { "...resultado de la transferencia..." },
  "receipt": {
    "format": "stringbase64",
    "content": "iVBORw0KGgoAAAANSUhEUgAA..."
  }
}
```

El campo `content` es la imagen del comprobante codificada en Base64. Decodificala para obtener el JPEG.

---

### Evento: PayOut COMPLETED (formato `base64`)

```
POST {tu-callback-url}
Content-Type: image/jpeg

<body binario de la imagen JPEG>
```

En este caso el body es directamente la imagen binaria. Guardala como archivo `.jpg` o procesala como stream.

---

### Evento: PayOut FAILED

Si el pago no pudo procesarse (destino inválido, fondos insuficientes, error en la transferencia):

```
POST {tu-callback-url}
Content-Type: application/json
```

```json
{
  "status": "FAILED",
  "id": 36309,
  "error": "El Destino solicitado no Existe o no esta activo"
}
```

---

## Política de Reintentos (Callbacks)

Si tu endpoint no responde `2xx`, el sistema reintenta con **backoff exponencial**:

| Intento | Espera antes del reintento |
|---------|---------------------------|
| 1 | inmediato |
| 2 | 1 segundo |
| 3 | 2 segundos |
| 4 | 4 segundos |
| 5 | 8 segundos |
| 6 | 16 segundos |
| 7 | 32 segundos |
| 8 | 64 segundos |
| 9 | 128 segundos (~2 min) |
| 10 | 256 segundos (~4 min) |

Tras 10 intentos fallidos el ticket queda en estado `Failed`. Podés reiniciarlo manualmente con el [endpoint de retry](#8-reintentar-una-notificación-fallida).

> **La política de reintentos aplica para:** callbacks de CashIn MATCHED, CashIn EXPIRED, y PayOut COMPLETED (formatos html y stringbase64). Los callbacks PayOut en formato `base64` y `FAILED` también se reintentan bajo la misma política.

---

## Recomendaciones de Implementación

1. **Idempotencia en tu callback**: El sistema puede entregar la misma notificación más de una vez (retries). Usá `requestId` (CashIn) o `id` (PayOut) como clave de idempotencia. Para eventos `EXPIRED` usá el `requestId`.

2. **Responder rápido**: Tu endpoint de callback debe responder en menos de 30 segundos. Si el procesamiento toma más tiempo, respondé `202 Accepted` y procesá en background.

3. **Distinguir eventos**: Los callbacks de CashIn incluyen el campo `event` solo en el caso `EXPIRED`. Los callbacks de match no incluyen ese campo — podés usarlo para diferenciar el tipo de evento.

4. **CUIT sin guiones**: Siempre enviá el CUIT sin guiones (`20123456789`, no `20-12345678-9`).

5. **Moneda**: El código `032` corresponde a Pesos Argentinos (ARS) según ISO 4217.

6. **CVU destino PayOut**: El CVU/CBU destino debe ser una cuenta activa en el sistema bancario argentino (22 dígitos). Si la cuenta no existe o está inactiva, recibirás un callback con `status: "FAILED"`.

---

## Códigos HTTP

**Éxito:**

| HTTP | Descripción |
|------|-------------|
| `200` | OK |
| `201` | Recurso creado |
| `202` | Operación aceptada (async) |

**Errores:**

| HTTP | code | Descripción |
|------|------|-------------|
| `400` | — | Datos inválidos en el body |
| `401` | `UNAUTHORIZED` | API Key ausente o inválida |
| `404` | — | Recurso no encontrado o no pertenece a tu cuenta |
| `422` | `NO_CVU_RECA` | Tu cuenta no tiene CVU recaudador configurado (PayOut) |
| `422` | `LIMIT_EXCEEDED` | Monto supera el límite por transacción o diario |
| `422` | `NO_PAYMENT_ACCOUNT` | Sin cuentas de pago disponibles (error temporal) |
