const requiredEnvVars = [
  'JWT_SECRET',
  'MONGODB_URI',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
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
  NARRATION_SFW_MODEL: 'deepseek/deepseek-v4.1-flash-1017',
  NARRATION_NSFW_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
  // Comma-separated fallbacks used only after a pre-stream provider 429. Keep
  // the NSFW list to models suitable for mature narration; it must never fall
  // back into a SFW provider simply because capacity is tight.
  NARRATION_SFW_FALLBACK_MODELS: 'mistralai/mistral-small-3.2-24b-instruct,meta-llama/llama-3.1-70b-instruct,mistralai/mistral-nemo',
  NARRATION_NSFW_FALLBACK_MODELS: 'meta-llama/llama-4-maverick,thedrummer/skyfall-36b-v2,thedrummer/unslopnemo-12b',
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
  // Keep this NON-Claude (cost). gpt-4o-mini routes through OpenRouter.
  CHEAP_RANK_MODEL: 'gpt-4o-mini',
  /** Re-rank the fused RAG candidate pool for true relevance before the final
   *  top-K slice (risk A). Off ⇒ existing fused order is used unchanged. */
  RAG_RERANK_ENABLED: 'false',
  /** Query embedding timing, ms. A player is waiting on it, so a stalled call is
   *  duplicated once after EMBED_HEDGE_MS and abandoned at EMBED_DEADLINE_MS —
   *  retrieval then drops its vector half instead of losing the turn. Background
   *  embeddings ignore both. */
  EMBED_HEDGE_MS: '700',
  /** Choice metadata usually starts in ~0.8 s (deaths: 0.75–1.6 s).
   * Hedge only a slow first token; 0 restores the non-streamed call. */
  CHOICE_HEDGE_MS: '1500',
  CHOICE_LEDGER_SPLIT: 'off',
  OVERLAP_PREFETCH: 'off',
  EMBED_DEADLINE_MS: '2500',
  /** Keeps this process's Pinecone and embedding connections warm while the box
   *  is quiet (see services/keep-warm.ts). `off` disables the pinger entirely. */
  KEEP_WARM: 'on',
  /** `stats` calls describeIndexStats, which is not billed in read units;
   *  `query` is a topK-1 search on a scope that cannot exist (0.25 read units). */
  KEEP_WARM_PINECONE: 'stats',
  /** How many Pinecone requests one ping sends at once, 1–6. A turn runs its
   *  lore, memory and summaries searches in parallel and each needs its own
   *  connection, so a single ping would keep only one of the three warm. */
  KEEP_WARM_PINECONE_WIDTH: '3',
  /** A client unused for this long gets one ping. Box probe, Oct 23 2026: Pinecone
   *  goes cold between 45 and 60 s idle, the embedding connection sooner; a 10 s
   *  ping kept both fast (the stats ping is free, the embedding one ~2 tokens). */
  KEEP_WARM_IDLE_MS: '10000',
  /** How often the idle check runs. */
  KEEP_WARM_CHECK_MS: '5000',
  /** For BORDERLINE nsfw lexicon scores (1–2) only, defer to a Haiku intent
   *  classifier (risk G). Off ⇒ borderline stays SFW as today. Chat-mode
   *  (Ardent) opt-in is the primary signal and is independent of this flag. */
  NSFW_INTENT_DEFER_ENABLED: 'false',
  NSFW_SAME_TURN_ROUTER: 'on',
  NSFW_SAME_TURN_ROUTER_MODEL: 'deepseek/deepseek-v4.1-flash-1017',
  NSFW_SAME_TURN_ROUTER_HOST: 'Relace',
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
  INK_PROMO_UNLIMITED: 'false',
  INK_PROMO_DAILY_TURN_CAP: '500',
  /** Non-production QA checkout. Never enable this in a public production app. */
  BILLING_SIMULATION_ENABLED: 'false',
  FORGE_OPEN_TO_ALL_TIERS: 'false',
  // Cloudflare Web Analytics, read-only. The marketing site's page views live
  // there; the admin console reads them through us so the token never reaches a
  // browser. Absent means the traffic panel simply says it is not configured.
  CLOUDFLARE_API_TOKEN: '',
  CLOUDFLARE_ACCOUNT_ID: '',
  // NOT the beacon token in the site's <script data-cf-beacon> tag. Cloudflare
  // issues two different ids per site: the snippet token, which identifies the
  // page when it reports, and the site tag, which identifies the same site when
  // you read the data back. Using the first here returns a valid, empty answer
  // with no error — it filters on a site that never reported anything. Read the
  // real one off the data itself: query rumPageloadEventsAdaptiveGroups with no
  // siteTag filter and select `dimensions { siteTag }`.
  CLOUDFLARE_RUM_SITE_TAG: '',
  PLAY_DEVELOPER_ACCOUNT_ID: '7899281946407974865',
  GOOGLE_PLAY_PACKAGE_NAME: '',
  /** JSON service-account credential with Android Publisher API access. */
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '',
  /** OIDC audience and sender configured on the Google Cloud Pub/Sub push subscription. */
  GOOGLE_PLAY_RTDN_AUDIENCE: '',
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: '',
  /** §4.7 error triage. On by default: the owner wants every group explained.
   * The caps are checked against `app_triage_calls` before each model call. */
  ERROR_TRIAGE_ENABLED: 'true',
  ERROR_TRIAGE_DAILY_CAP: '20',
  ERROR_TRIAGE_MONTHLY_USD_CAP: '1',
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
  VECTOR_LAYOUT: 'namespaced' | 'shared' | 'dual'
  PINECONE_SHARED_NAMESPACE: string
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
  EMBED_HEDGE_MS: number
  CHOICE_LEDGER_SPLIT: 'on' | 'off'
  OVERLAP_PREFETCH: 'on' | 'off'
  CHOICE_HEDGE_MS: number
  EMBED_DEADLINE_MS: number
  KEEP_WARM: boolean
  KEEP_WARM_PINECONE: 'stats' | 'query'
  KEEP_WARM_PINECONE_WIDTH: number
  KEEP_WARM_IDLE_MS: number
  KEEP_WARM_CHECK_MS: number
  NSFW_INTENT_DEFER_ENABLED: boolean
  NSFW_SAME_TURN_ROUTER: 'on' | 'off'
  NSFW_SAME_TURN_ROUTER_MODEL: string
  NSFW_SAME_TURN_ROUTER_HOST: string
  ADMIN_USERNAME: string
  ADMIN_PASSWORD: string
  GENERATION_CONCURRENCY: number
  GENERATION_RATE_MAX: number
  CHAT_RATE_MAX: number
  TEMPLATE_CREATE_RATE_MAX: number
  BILLING_ENFORCEMENT_ENABLED: boolean
  INK_PROMO_UNLIMITED: boolean
  INK_PROMO_DAILY_TURN_CAP: number
  BILLING_SIMULATION_ENABLED: boolean
  FORGE_OPEN_TO_ALL_TIERS: boolean
  CLOUDFLARE_API_TOKEN: string
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_RUM_SITE_TAG: string
  PLAY_DEVELOPER_ACCOUNT_ID: string
  GOOGLE_PLAY_PACKAGE_NAME: string
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: string
  GOOGLE_PLAY_RTDN_AUDIENCE: string
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: string
  ERROR_TRIAGE_ENABLED: boolean
  ERROR_TRIAGE_DAILY_CAP: number
  ERROR_TRIAGE_MONTHLY_USD_CAP: number
}

function loadEnv(): Env {
  const missing: string[] = []
  for (const key of requiredEnvVars) {
    if (!process.env[key]) missing.push(key)
  }
  if (missing.length > 0) {
    console.warn(`Warning: Missing env vars: ${missing.join(', ')}. Using defaults for development.`)
  }

  const sameTurnRouter = process.env.NSFW_SAME_TURN_ROUTER || optionalEnvVars.NSFW_SAME_TURN_ROUTER
  if (sameTurnRouter !== 'on' && sameTurnRouter !== 'off') throw new Error('Invalid NSFW_SAME_TURN_ROUTER')

  const configuredPromoCap = Number(process.env.INK_PROMO_DAILY_TURN_CAP || optionalEnvVars.INK_PROMO_DAILY_TURN_CAP)

  // A cap is a spend limit, so a typo must not silently mean "no cap": a value
  // that is not a non-negative number falls back to the committed default, and
  // a cap of 0 is honoured (it means "do not triage").
  const triageNumber = (value: string | undefined, fallback: string): number => {
    const parsed = Number(value || fallback)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number(fallback)
  }

  // Prod moved to the shared layout on Oct 22 2026 and its per-scope namespaces are gone; a server
  // without this setting must not write them again (they count against the plan's namespace cap).
  const vectorLayout = process.env.VECTOR_LAYOUT || 'shared'
  if (vectorLayout !== 'namespaced' && vectorLayout !== 'shared' && vectorLayout !== 'dual') throw new Error('Invalid VECTOR_LAYOUT')

  // A typo here silently changes what a quiet process pays per ping, so it fails
  // loudly at startup instead of defaulting.
  const keepWarmPinecone = process.env.KEEP_WARM_PINECONE || optionalEnvVars.KEEP_WARM_PINECONE
  if (keepWarmPinecone !== 'stats' && keepWarmPinecone !== 'query') throw new Error('Invalid KEEP_WARM_PINECONE')

  // A turn searches lore, memory and summaries at once and each parallel request
  // needs its own connection, so that many pings have to go out together. Clamped
  // rather than rejected: a typo must not turn a free ping into a burst of reads.
  const configuredWidth = Number(
    process.env.KEEP_WARM_PINECONE_WIDTH || optionalEnvVars.KEEP_WARM_PINECONE_WIDTH,
  )
  const keepWarmPineconeWidth = Number.isSafeInteger(configuredWidth)
    ? Math.min(6, Math.max(1, configuredWidth))
    : Number(optionalEnvVars.KEEP_WARM_PINECONE_WIDTH)

  return {
    VECTOR_LAYOUT: vectorLayout,
    PINECONE_SHARED_NAMESPACE: process.env.PINECONE_SHARED_NAMESPACE || 'everlore',
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
    EMBED_HEDGE_MS: Number(process.env.EMBED_HEDGE_MS || optionalEnvVars.EMBED_HEDGE_MS),
    CHOICE_LEDGER_SPLIT: process.env.CHOICE_LEDGER_SPLIT === 'on' ? 'on' : 'off',
    OVERLAP_PREFETCH: process.env.OVERLAP_PREFETCH === 'on' ? 'on' : 'off',
    CHOICE_HEDGE_MS: Number(process.env.CHOICE_HEDGE_MS || optionalEnvVars.CHOICE_HEDGE_MS),
    EMBED_DEADLINE_MS: Number(process.env.EMBED_DEADLINE_MS || optionalEnvVars.EMBED_DEADLINE_MS),
    KEEP_WARM: (process.env.KEEP_WARM || optionalEnvVars.KEEP_WARM) !== 'off',
    KEEP_WARM_PINECONE: keepWarmPinecone,
    KEEP_WARM_PINECONE_WIDTH: keepWarmPineconeWidth,
    KEEP_WARM_IDLE_MS: Number(process.env.KEEP_WARM_IDLE_MS || optionalEnvVars.KEEP_WARM_IDLE_MS),
    KEEP_WARM_CHECK_MS: Number(process.env.KEEP_WARM_CHECK_MS || optionalEnvVars.KEEP_WARM_CHECK_MS),
    NSFW_INTENT_DEFER_ENABLED: process.env.NSFW_INTENT_DEFER_ENABLED === 'true',
    NSFW_SAME_TURN_ROUTER: sameTurnRouter,
    NSFW_SAME_TURN_ROUTER_MODEL: process.env.NSFW_SAME_TURN_ROUTER_MODEL || optionalEnvVars.NSFW_SAME_TURN_ROUTER_MODEL,
    NSFW_SAME_TURN_ROUTER_HOST: process.env.NSFW_SAME_TURN_ROUTER_HOST || optionalEnvVars.NSFW_SAME_TURN_ROUTER_HOST,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || optionalEnvVars.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || optionalEnvVars.ADMIN_PASSWORD,
    GENERATION_CONCURRENCY: Number(process.env.GENERATION_CONCURRENCY || optionalEnvVars.GENERATION_CONCURRENCY),
    GENERATION_RATE_MAX: Number(process.env.GENERATION_RATE_MAX || optionalEnvVars.GENERATION_RATE_MAX),
    CHAT_RATE_MAX: Number(process.env.CHAT_RATE_MAX || optionalEnvVars.CHAT_RATE_MAX),
    TEMPLATE_CREATE_RATE_MAX: Number(process.env.TEMPLATE_CREATE_RATE_MAX || optionalEnvVars.TEMPLATE_CREATE_RATE_MAX),
    BILLING_ENFORCEMENT_ENABLED: process.env.BILLING_ENFORCEMENT_ENABLED === 'true',
    INK_PROMO_UNLIMITED: process.env.INK_PROMO_UNLIMITED === 'true',
    INK_PROMO_DAILY_TURN_CAP: Number.isSafeInteger(configuredPromoCap) && configuredPromoCap > 0
      ? configuredPromoCap
      : Number(optionalEnvVars.INK_PROMO_DAILY_TURN_CAP),
    BILLING_SIMULATION_ENABLED: process.env.BILLING_SIMULATION_ENABLED === 'true',
    FORGE_OPEN_TO_ALL_TIERS: process.env.FORGE_OPEN_TO_ALL_TIERS === 'true',
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || optionalEnvVars.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || optionalEnvVars.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_RUM_SITE_TAG: process.env.CLOUDFLARE_RUM_SITE_TAG || optionalEnvVars.CLOUDFLARE_RUM_SITE_TAG,
    PLAY_DEVELOPER_ACCOUNT_ID: process.env.PLAY_DEVELOPER_ACCOUNT_ID || optionalEnvVars.PLAY_DEVELOPER_ACCOUNT_ID,
    GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME || optionalEnvVars.GOOGLE_PLAY_PACKAGE_NAME,
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || optionalEnvVars.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    GOOGLE_PLAY_RTDN_AUDIENCE: process.env.GOOGLE_PLAY_RTDN_AUDIENCE || optionalEnvVars.GOOGLE_PLAY_RTDN_AUDIENCE,
    GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL || optionalEnvVars.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL,
    ERROR_TRIAGE_ENABLED: (process.env.ERROR_TRIAGE_ENABLED || optionalEnvVars.ERROR_TRIAGE_ENABLED) !== 'false',
    ERROR_TRIAGE_DAILY_CAP: triageNumber(process.env.ERROR_TRIAGE_DAILY_CAP, optionalEnvVars.ERROR_TRIAGE_DAILY_CAP),
    ERROR_TRIAGE_MONTHLY_USD_CAP: triageNumber(process.env.ERROR_TRIAGE_MONTHLY_USD_CAP, optionalEnvVars.ERROR_TRIAGE_MONTHLY_USD_CAP),
  }
}

export const env: Env = loadEnv()
