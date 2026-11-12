import { config } from './config.js';
import { HttpError } from './http.js';

export type AssistantMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export const generateAssistantReply = async (messages: AssistantMessage[]): Promise<{ content: string; model: string }> => {
  if (!config.groqApiKey) {
    throw new HttpError(503, 'AI_NOT_CONFIGURED', 'El Asistente IA todavía no tiene configurada la clave del proveedor.');
  }
  const response = await fetch(`${config.groqBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.groqModel,
      messages: [
        {
          role: 'system',
          content: 'Eres el Asistente IA educativo de TutoresOn-Line. Responde en español claro, cálido y preciso. Ayuda a comprender conceptos, preparar planes de estudio, resumir textos y formular preguntas para un tutor. No inventes fuentes ni afirmes haber hecho acciones externas. No resuelvas evaluaciones para copiar; explica el procedimiento y fomenta el aprendizaje. Mantén respuestas prácticas y de máximo 700 palabras.',
        },
        ...messages.slice(-20),
      ],
      temperature: 0.35,
      max_tokens: 900,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(502, 'AI_PROVIDER_ERROR', 'El proveedor de IA no respondió correctamente.', typeof body?.error?.message === 'string' ? body.error.message : undefined);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new HttpError(502, 'AI_EMPTY_RESPONSE', 'El proveedor de IA devolvió una respuesta vacía.');
  }
  return { content: content.trim(), model: config.groqModel };
};
