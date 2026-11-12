# Investigación de integraciones gratuitas

Fecha de consulta: 30 de octubre de 2026.

## Recomendación de IA

Se compararon Gemini API, Groq y OpenRouter. Para esta aplicación se recomienda **Groq con `openai/gpt-oss-120b` como modelo configurable**, porque su documentación oficial publica límites gratuitos concretos: 30 RPM, 1.000 RPD, 8.000 TPM y 200.000 TPD para ese modelo en el plan Free. La integración usa el endpoint de chat completions y la API key se mantiene en el backend.

Gemini API también ofrece una capa gratuita con tokens de entrada y salida sin costo para modelos elegibles, pero la documentación indica que el contenido del Free tier puede usarse para mejorar productos. Para una aplicación real con preguntas de estudiantes, esa condición requiere una decisión de privacidad y consentimiento. Sus límites dependen del modelo y del proyecto y se consultan en AI Studio.

OpenRouter permite modelos gratuitos, pero su documentación indica que normalmente tienen límites bajos de 50 solicitudes diarias; con al menos 10 créditos comprados la cuota de modelos gratuitos puede subir a 1.000 solicitudes diarias. Por ello no se elige como base gratuita sin costo para operación real.

La clave elegida será `GROQ_API_KEY`, almacenada como secreto del servidor. El modelo queda en `GROQ_MODEL` para poder cambiarlo sin modificar el código. La respuesta de la IA se guardará en `agorahub.ai_messages` junto con la pregunta, y el endpoint verificará que la conversación pertenezca al estudiante autenticado.

## Recomendación de videollamadas

Se compararon Jitsi Meet, Daily y LiveKit. Para este alcance se elige **Jitsi Meet mediante la IFrame API en `meet.jit.si`**, porque la documentación oficial permite incrustar una reunión con `external_api.js`, `domain`, `roomName`, `parentNode` y `userInfo` sin comprar un plan de video. El servicio público está limitado actualmente a 95 minutos por reunión, por lo que las tutorías se deben limitar a sesiones de 60 minutos y mostrar esa condición.

Daily ofrece 10.000 minutos-participante gratis al mes y un SDK completo, pero después de consumirlos continúa facturando por uso y no tiene un tope duro automático. LiveKit Cloud tiene un plan Build de $0 sin tarjeta, pero sus beneficios publicados se centran en agentes y el flujo de producción necesita un endpoint propio para generar tokens de acceso.

Para la implementación inicial, el backend generará un `roomName` impredecible ligado a la tutoría y únicamente lo devolverá a sus dos participantes autenticados. El frontend cargará la IFrame API de Jitsi en el aula virtual. No se enviarán claves privadas al navegador. Como siguiente endurecimiento para operación sensible, se puede migrar el dominio a JaaS/8x8.vc o a una instancia Jitsi propia con JWT y políticas de acceso.

## Fuentes oficiales

- [1] https://console.groq.com/docs/quickstart "Groq Quickstart"
- [2] https://console.groq.com/docs/rate-limits "Groq Rate Limits"
- [3] https://ai.google.dev/gemini-api/docs/pricing "Gemini Developer API pricing"
- [4] https://ai.google.dev/gemini-api/docs/rate-limits "Gemini Rate limits"
- [5] https://openrouter.ai/docs/faq "OpenRouter FAQ"
- [6] https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe/ "Jitsi Meet IFrame API"
- [7] https://jitsi.org/blog/changes-coming/ "Changes coming to meet.jit.si"
- [8] https://www.daily.co/pricing/video-sdk/ "Daily Video SDK pricing"
- [9] https://livekit.com/pricing "LiveKit pricing"
- [10] https://docs.livekit.io/home/get-started/authentication/ "LiveKit authentication"
- [11] https://supabase.com/docs/guides/auth "Supabase Auth"
- [12] https://supabase.com/docs/guides/functions/secrets "Supabase environment variables and secrets"

## Recomendación de correo transaccional

Se eligió **Resend** para el correo de la aplicación porque ofrece una API HTTP sencilla para Node.js y está orientado a correos transaccionales activados por eventos. Su documentación exige una API key y un dominio propio verificado antes de enviar desde el remitente de la aplicación. La implementación mantiene `RESEND_API_KEY` y `EMAIL_FROM` solo en el entorno del backend; el navegador nunca recibe la clave.

El plan Free publicado por Resend incluye 3.000 correos mensuales y un límite de 100 correos por día. Si el volumen aumenta, los planes pagados agregan capacidad y límites superiores. La aplicación envía correo de bienvenida al crear una cuenta, confirmación al registrar una solicitud, aviso al recibir una propuesta y confirmación de la tutoría a estudiante y profesor.

Para activarlo en producción se debe verificar el dominio en Resend, crear una API key con permiso de envío, guardar esa clave como `RESEND_API_KEY`, guardar un remitente del dominio verificado como `EMAIL_FROM` y establecer `APP_URL` con la URL pública de la aplicación. El envío se realiza desde el backend con una clave de idempotencia para evitar duplicados durante reintentos.

### Fuentes oficiales de Resend

- [13] https://resend.com/docs/introduction "Resend Introduction"
- [14] https://resend.com/docs/api-reference/emails/send-email "Resend Send Email API"
- [15] https://resend.com/docs/knowledge-base/what-is-resend-pricing "Resend Pricing"
