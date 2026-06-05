const requiredEnvVars = [
  'JWT_SECRET',
  'MONGODB_URI',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'PINECONE_API_KEY',
] as const

const optionalEnvVars = {
  PORT: '3000',
  CLIENT_ORIGINS: 'http://localhost:3000,http://localhost:8080',
  OPENROUTER_API_KEY: '',
  PINECONE_INDEX: 'nexus-memories',
  // Narration models — swap freely for A/B (narration is prose-only, no JSON/tools needed).
  NARRATION_SFW_MODEL: 'deepseek/deepseek-v3.2',
  NARRATION_NSFW_MODEL: 'gryphe/mythomax-l2-13b',
  // OpenRouter image-generation model (avatars + chat backgrounds).
  IMAGE_MODEL: 'bytedance-seed/seedream-4.5',
  // One-shot creation autofill (drafts a whole world/character). Cheap, fast, 1M ctx.
  AUTHORING_MODEL: 'deepseek/deepseek-v4-flash',
  // OpenRouter TTS (/api/v1/audio/speech). See everlore-docs/server/TTS_MODELS.md.
  TTS_MODEL: 'hexgrad/kokoro-82m',
  // AWS S3 + CloudFront for generated media. Bucket is private; served via CDN.
  AWS_REGION: 'ap-south-1',
  S3_BUCKET: '',
  CDN_BASE_URL: '',
  GOOGLE_CLIENT_ID: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_VERIFY_SERVICE_SID: '',
  /** When true, OTP send/verify skip Redis rate limits (local dev only). */
  DISABLE_OTP_RATE_LIMIT: 'false',
  ADMIN_USERNAME: '',
  ADMIN_PASSWORD: '',
} as const

export interface Env {
  PORT: number
  JWT_SECRET: string
  MONGODB_URI: string
  REDIS_URL: string
  OPENAI_API_KEY: string
  OPENROUTER_API_KEY: string
  PINECONE_API_KEY: string
  PINECONE_INDEX: string
  NARRATION_SFW_MODEL: string
  NARRATION_NSFW_MODEL: string
  IMAGE_MODEL: string
  AUTHORING_MODEL: string
  TTS_MODEL: string
  AWS_REGION: string
  S3_BUCKET: string
  CDN_BASE_URL: string
  CLIENT_ORIGINS: string[]
  GOOGLE_CLIENT_ID: string
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_VERIFY_SERVICE_SID: string
  DISABLE_OTP_RATE_LIMIT: boolean
  ADMIN_USERNAME: string
  ADMIN_PASSWORD: string
}

function loadEnv(): Env {
  const missing: string[] = []
  for (const key of requiredEnvVars) {
    if (!process.env[key]) missing.push(key)
  }
  if (missing.length > 0) {
    console.warn(`Warning: Missing env vars: ${missing.join(', ')}. Using defaults for development.`)
  }

  return {
    PORT: Number(process.env.PORT || optionalEnvVars.PORT),
    JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/everlore',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || optionalEnvVars.OPENROUTER_API_KEY,
    PINECONE_API_KEY: process.env.PINECONE_API_KEY || '',
    PINECONE_INDEX: process.env.PINECONE_INDEX || optionalEnvVars.PINECONE_INDEX,
    NARRATION_SFW_MODEL: process.env.NARRATION_SFW_MODEL || optionalEnvVars.NARRATION_SFW_MODEL,
    NARRATION_NSFW_MODEL: process.env.NARRATION_NSFW_MODEL || optionalEnvVars.NARRATION_NSFW_MODEL,
    IMAGE_MODEL: process.env.IMAGE_MODEL || optionalEnvVars.IMAGE_MODEL,
    AUTHORING_MODEL: process.env.AUTHORING_MODEL || optionalEnvVars.AUTHORING_MODEL,
    TTS_MODEL: process.env.TTS_MODEL || optionalEnvVars.TTS_MODEL,
    AWS_REGION: process.env.AWS_REGION || optionalEnvVars.AWS_REGION,
    S3_BUCKET: process.env.S3_BUCKET || optionalEnvVars.S3_BUCKET,
    CDN_BASE_URL: process.env.CDN_BASE_URL || optionalEnvVars.CDN_BASE_URL,
    CLIENT_ORIGINS: (process.env.CLIENT_ORIGINS || optionalEnvVars.CLIENT_ORIGINS).split(','),
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || optionalEnvVars.GOOGLE_CLIENT_ID,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || optionalEnvVars.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || optionalEnvVars.TWILIO_AUTH_TOKEN,
    TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID || optionalEnvVars.TWILIO_VERIFY_SERVICE_SID,
    DISABLE_OTP_RATE_LIMIT: process.env.DISABLE_OTP_RATE_LIMIT === 'true',
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || optionalEnvVars.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || optionalEnvVars.ADMIN_PASSWORD,
  }
}

export const env: Env = loadEnv()
