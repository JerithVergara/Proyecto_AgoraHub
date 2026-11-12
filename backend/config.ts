const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const config = {
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseSchema: process.env.SUPABASE_SCHEMA ?? 'agorahub',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
  groqBaseUrl: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
  jitsiDomain: (process.env.JITSI_DOMAIN ?? 'meet.jit.si').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM,
  appUrl: process.env.APP_URL?.replace(/\/$/, ''),
  authRequireEmailConfirmation: process.env.AUTH_REQUIRE_EMAIL_CONFIRMATION === 'true',
};
