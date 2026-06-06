# Bot de WhatsApp con Baileys

Primer hito del proyecto: que el numero se conecte y responda cuando le escribes.

## Que hace ahora

- Conecta una cuenta de WhatsApp con Baileys.
- Guarda la sesion en `.auth/` para no escanear QR cada vez.
- Escucha mensajes nuevos en chats directos.
- Responde usando Gemini con memoria corta por chat.
- Espera entre 7 y 25 segundos antes de contestar para que no responda instantaneamente.

## Requisitos

- Node.js 20+

## Instalar

```bash
npm install
```

## Configuracion

El proyecto lee variables desde `.env`.

Variables principales:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `LOG_LEVEL`
- `ESMERALDA_BASE_URL`
- `ESMERALDA_USER`
- `ESMERALDA_PASS`
- `ESMERALDA_DB_PATH`
- `ESMERALDA_PROVIDER_IDS`
- `ESMERALDA_SOURCE_ID`
- `CASINO_DEPOSIT_CVU`
- `CASINO_DEPOSIT_ALIAS`
- `CASINO_DEPOSIT_HOLDER`
- `CASINO_DEPOSIT_MIN_AMOUNT`
- `WHATSAPP_MEDIA_DIR`

## Ejecutar con QR

```bash
npm start
```

Despues:

1. Abre WhatsApp en tu telefono.
2. Ve a `Dispositivos vinculados`.
3. Escanea el QR que aparece en la terminal.

Cuando la conexion quede abierta, escribe al numero y el bot te respondera.

## Ejecutar con codigo de vinculacion

Si prefieres pairing code en lugar de QR:

```bash
USE_PAIRING_CODE=true PHONE_NUMBER=573001234567 npm start
```

`PHONE_NUMBER` debe ir en formato E.164 sin el `+`.

## Estructura

- `src/bot.js`: punto de entrada del bot.
- `src/whatsapp/`: conexion con Baileys, colas por chat, demoras y presencia.
- `data/whatsapp-media/`: comprobantes y adjuntos descargados desde WhatsApp.
- `src/casino/`: logica conversacional del agente y ejecucion de acciones.
- `src/ai/`: prompts, cliente de Gemini y generacion de planes/respuestas.
- `src/esmeralda/`: autenticacion, operaciones del panel y persistencia SQLite.
- `src/panel/`: panel web local para revisar conversaciones y metricas.
- `.auth/`: credenciales locales de WhatsApp.

## Compatibilidad interna

Todavia existen estos archivos puente para no romper imports viejos:

- `src/openrouter.js`
- `src/casino-agent.js`

Redirigen a los modulos nuevos en `src/ai/` y `src/casino/`.

## Probar autenticacion de Esmeralda

Cuando tengas `ESMERALDA_USER` y `ESMERALDA_PASS` en `.env`, puedes probar solo la autenticacion asi:

```bash
npm run esmeralda:auth
```

Ese flujo hace esto:

1. Genera localmente un `PHPSESSID`.
2. Genera localmente un `token` hex de 64 caracteres.
3. Hace `POST /services/login.php`.
4. Reutiliza el mismo `PHPSESSID` en `GET /users.php`.
5. Extrae `document.body.dataset.session_token='...'` del HTML.

## Sincronizar usuarios de Esmeralda

Una vez autenticado, el cliente puede llamar `operation_get_users_list.php`, reutilizando:

- el mismo `PHPSESSID`
- el `session_token` obtenido desde `users.php`

Para bajar los usuarios y guardarlos en SQLite:

```bash
npm run esmeralda:sync-users
```

Se guarda una tabla `esmeralda_users` con estos datos utiles:

- `username`
- `balance_text`
- `balance_amount`
- `balance_cents`
- `remote_user_id`
- `unknown_value`
- `user_type`

## Crear usuario en Esmeralda

El cliente ahora valida esto antes de crear:

- `username` obligatorio
- `username` solo con letras, numeros y `_`
- `password` alfanumerica de minimo 8 caracteres
- sincroniza usuarios antes de crear para evitar duplicados

Luego de crear:

- vuelve a sincronizar los usuarios
- actualiza SQLite
- deja el `remote_user_id` disponible

Comando:

```bash
npm run esmeralda:create-user -- nuevo_usuario hola12345
```

## Sumar o quitar saldo

Ambas operaciones usan el mismo endpoint:

- `action=add`
- `action=deduct`

El cliente:

- reutiliza `PHPSESSID` y `session_token`
- busca el usuario por `username` en SQLite
- si hace falta, sincroniza primero
- usa `ESMERALDA_SOURCE_ID` como `source_id`
- resincroniza usuarios al terminar

Sumar saldo:

```bash
npm run esmeralda:add-credit -- Hacelo78fg 100
```

Quitar saldo:

```bash
npm run esmeralda:deduct-credit -- Hacelo78fg 50
```

## Flujo de recarga desde WhatsApp

Cuando un cliente pide cargar saldo desde el bot:

- el bot ya no acredita directo
- manda el CVU/alias configurado
- queda esperando referencia o comprobante
- guarda los adjuntos entrantes en `WHATSAPP_MEDIA_DIR`
- si detecta una referencia en texto o en una captura, la deja tomada y ahi se corta ese flujo

## Reautenticacion por inactividad

El cliente no se reautentica en cada llamada.

La regla ahora es:

- si ya hay una sesion valida y la ultima peticion autenticada fue hace menos de 1 minuto, reutiliza esa sesion
- si vas a hacer una nueva peticion autenticada y la ultima fue hace mas de 1 minuto, reautentica justo en ese momento

No existe un timer que reautentique solo por pasar el tiempo.

## Nota importante

Para este primer paso estamos usando `useMultiFileAuthState`, que la propia documentacion de Baileys no recomienda para produccion. Nos sirve perfecto para arrancar y comprobar que el numero responde. Cuando pasemos a una version mas seria, cambiamos esa persistencia por base de datos o almacenamiento propio.
