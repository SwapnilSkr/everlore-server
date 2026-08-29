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
  /** Prefer providers whose recent p90 latency is within this target. This is
   * a routing preference, not a hard failure cutoff; 0 disables it. */
  OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: '3',
  PINECONE_INDEX: 'nexus-memories',
  // Narration models — swap freely for A/B (narration is prose-only, no JSON/tools needed).
  NARRATION_SFW_MODEL: 'deepseek/deepseek-v3.2',
  NARRATION_NSFW_MODEL: 'gryphe/mythomax-l2-13b',
  // Comma-separated fallbacks used only after a pre-stream provider 429. Keep
  // the NSFW list to models suitable for mature narration; it must never fall
  // back into a SFW provider simply because capacity is tight.
  NARRATION_SFW_FALLBACK_MODELS: 'deepseek/deepseek-v3.2,mistralai/mistral-nemo',
  NARRATION_NSFW_FALLBACK_MODELS: 'thedrummer/unslopnemo-12b,aion-labs/aion-2.0',
  // OpenRouter image-generation model (avatars + chat backgrounds).
  IMAGE_MODEL: 'bytedance-seed/seedream-4.5',
  // One-shot creation autofill (drafts a whole world/character). Cheap, strong JSON + creative.
  AUTHORING_MODEL: 'google/gemini-2.5-flash-lite',
  // OpenRouter TTS (/api/v1/audio/speech). See everlore-docs/server/TTS_MODELS.md.
  TTS_MODEL: 'hexgrad/kokoro-82m',
  // AWS S3 + CloudFront for generated media. Bucket is private; served via CDN.
  AWS_REGION: 'ap-south-1',
  S3_BUCKET: '',
  CDN_BASE_URL: '',
  GOOGLE_CLIENT_ID: '',
  /**
   * Firebase project that mints the ID tokens `/auth/google` accepts.
   * Doubles as the required `aud` and `iss` on every one of them, so a token
   * for somebody else's Firebase project cannot authenticate here.
   */
  FIREBASE_PROJECT_ID: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_VERIFY_SERVICE_SID: '',
  /** When true, OTP send/verify skip Redis rate limits (local dev only). */
  DISABLE_OTP_RATE_LIMIT: 'false',
  /**
   * Google Play reviewer sign-in. Both must be set or the path stays inert.
   * REVIEW_DEMO_OTP must be exactly six digits and not a guessable one — see
   * providers/auth.provider.ts for the full set of guards.
   */
  REVIEW_DEMO_PHONE: '',
  REVIEW_DEMO_OTP: '',
  // ── Cheap-LLM signal flags (default OFF — both fall back to today's behavior) ──
  // Cheap aux model used by the optional re-rank / borderline-intent passes.
  // Keep this NON-Claude (cost). gpt-4o-mini is in OPENAI_MODELS so it uses the
  // direct OpenAI key; any other id routes via OpenRouter (see src/ai/client.ts).
  CHEAP_RANK_MODEL: 'gpt-4o-mini',
  /** Re-rank the fused RAG candidate pool for true relevance before the final
   *  top-K slice (risk A). Off ⇒ existing fused order is used unchanged. */
  RAG_RERANK_ENABLED: 'false',
  /** For BORDERLINE nsfw lexicon scores (1–2) only, defer to a Haiku intent
   *  classifier (risk G). Off ⇒ borderline stays SFW as today. Chat-mode
   *  (Ardent) opt-in is the primary signal and is independent of this flag. */
  NSFW_INTENT_DEFER_ENABLED: 'false',
  ADMIN_USERNAME: '',
  ADMIN_PASSWORD: '',
  // Throughput knobs — defaults are the safe production values. Crank these via
  // env for a parallel QA fleet (see AUTOCHAT_PLAYBOOK.md) without weakening the
  // committed defaults. GENERATION_CONCURRENCY = simultaneous turns the worker
  // runs; GENERATION_RATE_MAX = turns/min the worker accepts; CHAT_RATE_MAX =
  // player turns/60s; TEMPLATE_CREATE_RATE_MAX = worlds created per 24h.
  GENERATION_CONCURRENCY: '3',
  GENERATION_RATE_MAX: '10',
  CHAT_RATE_MAX: '10',
  TEMPLATE_CREATE_RATE_MAX: '5',
  /** Keeps the full billing path deployable before Play products are live. */
  BILLING_ENFORCEMENT_ENABLED: 'false',
  /** Non-production QA checkout. Never enable this in a public production app. */
  BILLING_SIMULATION_ENABLED: 'false',
  GOOGLE_PLAY_PACKAGE_NAME: '',
  /** JSON service-account credential with Android Publisher API access. */
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '',
  /** OIDC audience and sender configured on the Google Cloud Pub/Sub push subscription. */
  GOOGLE_PLAY_RTDN_AUDIENCE: '',
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: '',
} as const

export interface Env {
  PORT: number
  JWT_SECRET: string
  MONGODB_URI: string
  REDIS_URL: string
  OPENAI_API_KEY: string
  OPENROUTER_API_KEY: string
  OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: number
  PINECONE_API_KEY: string
  PINECONE_INDEX: string
  NARRATION_SFW_MODEL: string
  NARRATION_NSFW_MODEL: string
  NARRATION_SFW_FALLBACK_MODELS: string[]
  NARRATION_NSFW_FALLBACK_MODELS: string[]
  IMAGE_MODEL: string
  AUTHORING_MODEL: string
  TTS_MODEL: string
  AWS_REGION: string
  S3_BUCKET: string
  CDN_BASE_URL: string
  CLIENT_ORIGINS: string[]
  GOOGLE_CLIENT_ID: string
  FIREBASE_PROJECT_ID: string
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_VERIFY_SERVICE_SID: string
  DISABLE_OTP_RATE_LIMIT: boolean
  REVIEW_DEMO_PHONE: string
  REVIEW_DEMO_OTP: string
  CHEAP_RANK_MODEL: string
  RAG_RERANK_ENABLED: boolean
  NSFW_INTENT_DEFER_ENABLED: boolean
  ADMIN_USERNAME: string
  ADMIN_PASSWORD: string
  GENERATION_CONCURRENCY: number
  GENERATION_RATE_MAX: number
  CHAT_RATE_MAX: number
  TEMPLATE_CREATE_RATE_MAX: number
  BILLING_ENFORCEMENT_ENABLED: boolean
  BILLING_SIMULATION_ENABLED: boolean
  GOOGLE_PLAY_PACKAGE_NAME: string
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: string
  GOOGLE_PLAY_RTDN_AUDIENCE: string
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: string
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
    OPENROUTER_PREFERRED_P90_LATENCY_SECONDS: Number(
      process.env.OPENROUTER_PREFERRED_P90_LATENCY_SECONDS ||
        optionalEnvVars.OPENROUTER_PREFERRED_P90_LATENCY_SECONDS,
    ),
    PINECONE_API_KEY: process.env.PINECONE_API_KEY || '',
    PINECONE_INDEX: process.env.PINECONE_INDEX || optionalEnvVars.PINECONE_INDEX,
    NARRATION_SFW_MODEL: process.env.NARRATION_SFW_MODEL || optionalEnvVars.NARRATION_SFW_MODEL,
    NARRATION_NSFW_MODEL: process.env.NARRATION_NSFW_MODEL || optionalEnvVars.NARRATION_NSFW_MODEL,
    NARRATION_SFW_FALLBACK_MODELS: (process.env.NARRATION_SFW_FALLBACK_MODELS || optionalEnvVars.NARRATION_SFW_FALLBACK_MODELS)
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
    NARRATION_NSFW_FALLBACK_MODELS: (process.env.NARRATION_NSFW_FALLBACK_MODELS || optionalEnvVars.NARRATION_NSFW_FALLBACK_MODELS)
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
    IMAGE_MODEL: process.env.IMAGE_MODEL || optionalEnvVars.IMAGE_MODEL,
    AUTHORING_MODEL: process.env.AUTHORING_MODEL || optionalEnvVars.AUTHORING_MODEL,
    TTS_MODEL: process.env.TTS_MODEL || optionalEnvVars.TTS_MODEL,
    AWS_REGION: process.env.AWS_REGION || optionalEnvVars.AWS_REGION,
    S3_BUCKET: process.env.S3_BUCKET || optionalEnvVars.S3_BUCKET,
    CDN_BASE_URL: process.env.CDN_BASE_URL || optionalEnvVars.CDN_BASE_URL,
    CLIENT_ORIGINS: (process.env.CLIENT_ORIGINS || optionalEnvVars.CLIENT_ORIGINS).split(','),
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || optionalEnvVars.GOOGLE_CLIENT_ID,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || optionalEnvVars.FIREBASE_PROJECT_ID,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || optionalEnvVars.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || optionalEnvVars.TWILIO_AUTH_TOKEN,
    TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID || optionalEnvVars.TWILIO_VERIFY_SERVICE_SID,
    DISABLE_OTP_RATE_LIMIT: process.env.DISABLE_OTP_RATE_LIMIT === 'true',
    REVIEW_DEMO_PHONE: process.env.REVIEW_DEMO_PHONE || optionalEnvVars.REVIEW_DEMO_PHONE,
    REVIEW_DEMO_OTP: process.env.REVIEW_DEMO_OTP || optionalEnvVars.REVIEW_DEMO_OTP,
    CHEAP_RANK_MODEL: process.env.CHEAP_RANK_MODEL || optionalEnvVars.CHEAP_RANK_MODEL,
    RAG_RERANK_ENABLED: process.env.RAG_RERANK_ENABLED === 'true',
    NSFW_INTENT_DEFER_ENABLED: process.env.NSFW_INTENT_DEFER_ENABLED === 'true',
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || optionalEnvVars.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || optionalEnvVars.ADMIN_PASSWORD,
    GENERATION_CONCURRENCY: Number(process.env.GENERATION_CONCURRENCY || optionalEnvVars.GENERATION_CONCURRENCY),
    GENERATION_RATE_MAX: Number(process.env.GENERATION_RATE_MAX || optionalEnvVars.GENERATION_RATE_MAX),
    CHAT_RATE_MAX: Number(process.env.CHAT_RATE_MAX || optionalEnvVars.CHAT_RATE_MAX),
    TEMPLATE_CREATE_RATE_MAX: Number(process.env.TEMPLATE_CREATE_RATE_MAX || optionalEnvVars.TEMPLATE_CREATE_RATE_MAX),
    BILLING_ENFORCEMENT_ENABLED: process.env.BILLING_ENFORCEMENT_ENABLED === 'true',
    BILLING_SIMULATION_ENABLED: process.env.BILLING_SIMULATION_ENABLED === 'true',
    GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME || optionalEnvVars.GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || optionalEnvVars.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    GOOGLE_PLAY_RTDN_AUDIENCE: process.env.GOOGLE_PLAY_RTDN_AUDIENCE || optionalEnvVars.GOOGLE_PLAY_RTDN_AUDIENCE,
    GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL || optionalEnvVars.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL,
  }
}

export const env: Env = loadEnv()
