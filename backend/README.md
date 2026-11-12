# Backend REST de TutoresOn-Line

El backend está construido con Node.js, TypeScript y `@supabase/supabase-js`. Sirve las páginas estáticas actuales y expone la API REST bajo `/api`.

## Configuración necesaria

Los secretos ya están declarados en la configuración del proyecto:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GROQ_API_KEY`
- `RESEND_API_KEY`
- `EMAIL_FROM`

También se puede configurar `SUPABASE_SCHEMA` si el esquema no se llama `agorahub`, `PORT` para el puerto de escucha, `CORS_ORIGIN` para limitar los orígenes permitidos, `APP_URL` para los enlaces de correo y `AUTH_REQUIRE_EMAIL_CONFIRMATION=true` si se quiere obligar la confirmación del correo antes del primer acceso. La clave `service_role` solo se usa en el servidor.

`GROQ_API_KEY` es necesaria para activar el Asistente IA. El modelo por defecto es `openai/gpt-oss-120b` y puede cambiarse con `GROQ_MODEL`; la clave nunca llega al navegador.

`RESEND_API_KEY` y `EMAIL_FROM` activan los correos de bienvenida, solicitud recibida, propuesta recibida y tutoría confirmada. `EMAIL_FROM` debe ser una dirección de un dominio verificado en Resend, por ejemplo `ÁgoraHub <notificaciones@tudominio.com>`. Si faltan estas variables, la operación principal no se pierde, pero el backend registra que el correo está pendiente de configuración.

Antes del primer registro se debe ejecutar en el SQL Editor de Supabase:

```sql
-- database/migrations/001_supabase_auth.sql
```

Esto permite que Supabase Auth sea el único dueño del hash de las contraseñas. El UUID de `auth.users` se reutiliza como `agorahub.users.id`.

Después de las migraciones iniciales ejecuta también `database/migrations/003_blogs_subjects_usd.sql`. Esta migración crea `tutor_blogs`, agrega las relaciones de materias personalizadas y fija los importes de perfiles, solicitudes y propuestas en USD. Sin ella, el perfil y las materias funcionan, pero los endpoints de blogs responderán que la tabla no existe.

El esquema `agorahub` también debe estar habilitado en **API → Exposed schemas** de Supabase, porque el backend usa `.schema('agorahub')`.

## Recuperación de contraseña

Todo el proceso visible para el usuario ocurre dentro de ÁgoraHub: el formulario de login llama a `POST /api/auth/forgot-password`, que usa `supabase.auth.resetPasswordForEmail()`. El enlace redirige a `/pages/reset-password.html`; la página soporta tanto PKCE (`?code=...`, intercambiado por `POST /api/auth/exchange-recovery-code`) como sesión en hash (`#access_token=...`). Finalmente, `POST /api/auth/update-password` actualiza la contraseña con Supabase Auth y la página vuelve al login interno de ÁgoraHub.

En **Authentication → URL Configuration**, configura la `Site URL` pública y agrega como `Redirect URLs` la URL exacta `https://tu-dominio.example/pages/reset-password.html` (y la URL de Preview si la utilizarás). Define también `APP_URL=https://tu-dominio.example` en el backend para que los enlaces generados por correo sean consistentes.

Para desarrollo puede utilizarse el proveedor de correo predeterminado de Supabase, pero tiene límites de envío y no es recomendable para producción. En producción configura **Authentication → Emails → SMTP Settings** con un proveedor transaccional como Resend, Postmark, SendGrid o Amazon SES, usando un dominio verificado, host, puerto, usuario, contraseña y remitente válidos. El SMTP de Resend usado para notificaciones de la aplicación (`RESEND_API_KEY`) es independiente del SMTP que Supabase Auth necesita para sus propios correos.

## Desarrollo

```bash
npm install
npm run dev
```

Comprobaciones de producción:

```bash
npm run check
npm run build
npm start
```

## API inicial

| Método | Ruta | Requiere sesión | Descripción |
|---|---|---:|---|
| GET | `/api/health` | No | Comprueba API y acceso al catálogo de roles. |
| POST | `/api/auth/register` | No | Registra estudiante o tutor en Supabase Auth y `agorahub`. |
| POST | `/api/auth/login` | No | Inicia sesión y devuelve tokens de Supabase. |
| GET | `/api/me` | Sí | Devuelve el usuario y su rol. |
| GET/PATCH | `/api/students/me/profile` | Estudiante | Consulta o actualiza la información de Mi cuenta del estudiante. |
| GET | `/api/tutors` | No | Busca tutores por materia, modalidad o área. |
| GET/PATCH | `/api/tutors/me/profile` | Tutor | Consulta o actualiza perfil profesional. |
| GET/POST | `/api/tutors/me/availability` | Tutor | Consulta o crea horarios disponibles. |
| GET | `/api/subjects` | Sesión | Lista todas las materias activas del catálogo. |
| GET | `/api/subjects/mine` | Tutor | Lista las materias asociadas al perfil del tutor. |
| POST/DELETE | `/api/subjects` y `/api/subjects/:id` | Tutor | Crea o asocia una materia nueva y permite retirarla del perfil. |
| GET/POST | `/api/tutors/me/blogs` | Tutor | Lista o publica artículos persistentes. |
| PATCH/DELETE | `/api/tutors/me/blogs/:id` | Tutor | Edita o elimina un artículo propio. |
| GET/POST | `/api/requests` | Estudiante | Lista o crea solicitudes de tutoría. |
| GET | `/api/requests/:id` | Participante | Consulta una solicitud y sus propuestas. |
| POST | `/api/requests/:id/proposals` | Tutor | Envía una propuesta o contraoferta. |
| PATCH | `/api/proposals/:id` | Estudiante | Acepta o rechaza una propuesta. Al aceptar crea la tutoría. |
| GET | `/api/sessions` | Participante | Lista las tutorías del usuario. |
| GET | `/api/sessions/:id/meeting` | Participante | Genera o recupera el enlace externo privado de meet.jit.si para una tutoría online. |
| POST | `/api/sessions/:id/finish` | Participante | Marca la llamada como terminada y deja la sesión pendiente de reseña. |
| POST | `/api/sessions/:id/cancel` | Participante | Cancela la tutoría con motivo y notifica por correo a la otra parte. |
| POST | `/api/sessions/:id/reviews` | Estudiante | Publica la reseña pendiente y cambia la tutoría a completada. |
| GET/POST | `/api/ai/conversations` | Estudiante | Lista o crea conversaciones del Asistente IA. |
| GET/POST | `/api/ai/conversations/:id...` | Estudiante | Consulta mensajes o guarda una pregunta. |

Las rutas protegidas usan `Authorization: Bearer <accessToken>`. El endpoint del Asistente IA persiste mensajes y genera la respuesta mediante Groq usando `GROQ_API_KEY` únicamente en el servidor. El endpoint de reunión devuelve el dominio, nombre de sala y URL externa de Jitsi solo al estudiante o tutor participante; la aplicación abre esa URL en una pestaña nueva y no incrusta la videollamada. Los correos se envían de forma asíncrona para que una caída temporal del proveedor no deshaga una cuenta, solicitud o tutoría ya guardada.


## Si `/api/health` devuelve `Invalid schema: agorahub`

Ejecuta primero `database/migrations/002_expose_agorahub.sql` en el SQL Editor de Supabase. También puedes abrir **Project Settings → API → Exposed schemas** y agregar `agorahub`; después verifica los permisos del esquema y recarga la configuración de PostgREST.

El backend fue validado contra la URL base del proyecto (`https://<project-ref>.supabase.co`). No debe configurarse `SUPABASE_URL` con el sufijo `/rest/v1/`, porque el cliente Supabase agrega esa ruta automáticamente.


## Cuentas iniciales creadas

Estas cuentas se provisionaron en Supabase Auth y tienen únicamente su perfil inicial:

| Rol | Correo | Contraseña |
|---|---|---|
| Estudiante | `estudiante@agorahub.co` | `Estudiante123` |
| Tutor | `tutor@agorahub.co` | `Tutor123` |

No se crearon clases, solicitudes, propuestas ni tutorías para ninguna de las dos cuentas.

### Disponibilidad del tutor

- `GET /api/tutors/me/availability` lista los horarios propios.
- `POST /api/tutors/me/availability` crea un horario.
- `PATCH /api/tutors/me/availability/:availabilityId` actualiza un horario propio.
- `DELETE /api/tutors/me/availability/:availabilityId` elimina un horario propio.

- `POST /api/auth/refresh` renueva el access token usando el refresh token de Supabase.

La respuesta pública de perfil de tutor incluye `blogs` publicados para las vistas de perfil y previsualización.

| GET | `/api/students/me/metrics` | Estudiante autenticado | Métricas de aprendizaje derivadas de sus sesiones completadas |

El dashboard del tutor reutiliza `GET /api/requests` para mostrar solicitudes abiertas en el resumen, sin crear una fuente paralela de datos.
