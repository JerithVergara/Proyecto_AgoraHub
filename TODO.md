

## Calendario ocupado y ajustes visuales — 5 de noviembre de 2026
- [x] El calendario de disponibilidad consulta las tutorías del profesor y muestra como «Ocupada» la franja exacta de sesiones programadas o en curso.
- [x] Los bloques disponibles se fragmentan alrededor de las clases ocupadas y el resumen semanal descuenta esas horas.
- [x] La reserva solo ofrece cantidades de horas enteras y limita las horas de inicio a aquellas con al menos una hora completa disponible.
- [x] El backend rechaza rangos de solicitud con duración no entera para mantener la regla de horas completas.
- [x] Se eliminaron las barras de búsqueda superiores de las páginas autenticadas.
- [x] Los avatares del lateral mantienen sus iniciales centradas y separadas del texto del rol.

## Avatares de perfil
- [x] Desde Mi cuenta, tanto estudiante como profesor pueden subir, reemplazar y eliminar una foto de perfil.
- [x] La imagen acepta JPG, PNG y WebP, se optimiza a 400 × 400 píxeles y se limita a 300 KB antes de guardarse.
- [x] El backend guarda una única imagen por usuario en Supabase Storage, reemplaza la anterior y persiste `avatar_url` en `users`.
- [x] La foto se muestra en la barra lateral, encabezado, perfil público/tarjetas de tutor y lista de conversaciones del Chat.
