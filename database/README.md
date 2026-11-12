# Diseño de base de datos — TutoresOn-Line / ÁgoraHub

## Decisión: base de datos relacional SQL

La mejor opción para este proyecto es **PostgreSQL**, una base de datos relacional SQL.

La razón principal es que los flujos tienen relaciones estructuradas y reglas de integridad que deben mantenerse consistentes:

- Un usuario puede tener uno o más roles y un perfil de estudiante o tutor.
- Un tutor puede enseñar varias materias y atender varios niveles.
- Un estudiante crea solicitudes con materia, nivel, modalidad, fecha y presupuesto.
- Una solicitud puede recibir propuestas y mensajes de negociación.
- Una propuesta aceptada genera una tutoría programada.
- Una tutoría puede tener archivos, notas, checklist y una reseña.
- El Asistente IA tiene conversaciones y mensajes ordenados cronológicamente.

Estos datos tienen dependencias y transiciones de estado. PostgreSQL permite aplicar claves foráneas, restricciones `CHECK`, índices, unicidad y transacciones para evitar datos huérfanos o inconsistentes. NoSQL sería útil para guardar conversaciones o documentos sin estructura fija, pero aquí esos componentes son solo una parte del sistema y se pueden modelar correctamente con tablas relacionadas.

## Entregables

| Archivo | Propósito |
|---|---|
| `schema.sql` | Código SQL para PostgreSQL 15 o superior. Incluye tablas, claves, restricciones, índices, datos base y dos vistas de consulta. |
| `diagrama.d2` | Fuente editable del diagrama visual. |
| `diagrama.png` | Diagrama visual renderizado del modelo. |

El diseño **no está conectado al proyecto frontend** y no crea credenciales ni datos de las cuentas iniciales. Es una propuesta independiente para la siguiente etapa backend.

## Módulos del modelo

### 1. Identidad y perfiles

- `users`: credenciales, datos básicos, estado y zona horaria.
- `roles` y `user_roles`: separación entre estudiante, tutor y administrador.
- `student_profiles`: información propia del estudiante.
- `tutor_profiles`: tarifa, modalidad, área de servicio, verificación y reputación resumida.
- `user_sessions`: sesiones de autenticación almacenando únicamente el hash del token.

### 2. Catálogos y perfil profesional

- `subjects` y `education_levels`: catálogos para búsqueda y solicitudes.
- `tutor_subjects` y `tutor_education_levels`: relaciones muchos-a-muchos.
- `tutor_badges`: distintivos visibles en el perfil.
- `verification_documents`: documentos de identidad, títulos o certificados.
- `user_addresses`: ubicación para tutorías presenciales y filtros geográficos.

### 3. Disponibilidad

- `tutor_availability_rules`: horario semanal recurrente.
- `tutor_availability_exceptions`: bloqueos o espacios extraordinarios para una fecha específica.

### 4. Solicitud y negociación

- `tutoring_requests`: solicitud iniciada por el estudiante.
- `tutoring_proposals`: tarifa y horario ofrecidos por cada tutor.
- `negotiation_messages`: conversación relacionada con la solicitud o propuesta.

### 5. Tutoría y aula virtual

- `tutoring_sessions`: tutoría confirmada a partir de una propuesta aceptada.
- `session_files`: archivos compartidos.
- `session_notes`: notas de tutor o estudiante.
- `session_checklist_items`: preparación y seguimiento de la clase.
- `tutor_reviews`: valoración posterior a la tutoría.

### 6. Asistente IA

- `ai_conversations` y `ai_messages`: historial del Asistente IA del estudiante.

## Flujo de datos principal

```text
Estudiante
  → crea tutoring_requests
  → recibe tutoring_proposals
  → acepta una propuesta
  → se crea tutoring_sessions
  → usa el aula, archivos, notas y checklist
  → publica tutor_reviews
```

El tutor participa así:

```text
Tutor
  → configura tutor_profiles
  → relaciona materias y niveles
  → define disponibilidad
  → consulta solicitudes
  → envía propuestas y mensajes
  → imparte tutoring_sessions
  → registra notas y archivos
```

## Reglas importantes

1. `users.email` es único sin distinguir mayúsculas y minúsculas mediante un índice sobre `lower(email)`.
2. Las contraseñas deben llegar al sistema como `password_hash`; nunca se debe guardar una contraseña plana.
3. Una propuesta es única por solicitud y tutor.
4. Una tutoría se origina en una única propuesta aceptada.
5. Una tutoría solo puede tener una reseña por sesión.
6. Los horarios deben terminar después de comenzar.
7. Las tutorías presenciales deben tener una ubicación.
8. Las tarifas no pueden ser negativas.
9. Las calificaciones están limitadas de 1 a 5.
10. La aplicación debe verificar en la capa de servicio que quien crea una solicitud tenga rol estudiante y quien envía una propuesta tenga rol tutor. Esa regla depende del contexto de la operación y se complementa con las claves foráneas.

## Normalización

El diseño evita repetir información usando relaciones normalizadas:

- Las materias y niveles se almacenan una vez y se reutilizan mediante tablas puente.
- La información común de identidad está en `users`; los datos específicos están en perfiles separados.
- Las propuestas no duplican la solicitud completa: la referencian mediante `request_id`.
- Los mensajes de IA están separados de la conversación para conservar el orden y permitir múltiples mensajes.

La reputación resumida (`average_rating` y `review_count`) se mantiene en `tutor_profiles` para consultas rápidas, pero debe actualizarse desde las reseñas mediante una transacción o proceso de dominio en backend.

## Cómo visualizar

La imagen `diagrama.png` es la versión lista para presentar. Si se desea editar el diagrama, se modifica `diagrama.d2` y se vuelve a renderizar con:

```bash
manus-render-diagram database/diagrama.d2 database/diagrama.png
```

## Alcance excluido por ahora

- Conexión con el frontend actual.
- API REST, controladores y autenticación real.
- Migraciones ejecutadas en un servidor.
- Integración real con pagos, videoconferencia o servicios externos.
- Persistencia real de las cuentas iniciales usadas para recorrer las interfaces.

## Ajuste solicitado

Se retiró del diseño la funcionalidad de notificaciones por email, SMS y WhatsApp. El esquema SQL ya no contiene las tablas `notifications`, `notification_deliveries` ni `notification_preferences`, y el diagrama fue regenerado sin ese módulo.
