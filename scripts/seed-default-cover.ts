/**
 * seed-default-cover.ts — one-shot generator + S3 upload for the universal
 * fallback cover used when creators skip portrait generation in Forge / Create
 * Character.
 *
 * Run:   bun run seed:default-cover            (skips if object exists)
 *        bun run seed:default-cover --force     (regenerate + overwrite)
 *
 * Writes to: s3://<S3_BUCKET>/media/defaults/everlore-cover.webp
 * Served at: <CDN_BASE_URL>/media/defaults/everlore-cover.webp
 */
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { generateImage } from '../src/ai'
import { DEFAULT_COVER_KEY } from '../src/constants/default-cover'
import { env } from '../src/config/env'
import { storageService } from '../src/services/storage.service'

const OUT_WIDTH = 768
const OUT_HEIGHT = 1024
const WEBP_QUALITY = 85

const PROMPT =
  'Atmospheric anime wallpaper on pure black void background, subtle drifting golden ember particles ' +
  'and faint teal aether wisps, soft cinematic rim light from above, moody versatile story backdrop, ' +
  'abstract depth with gentle nebula haze, premium 3D-shaded anime aesthetic, no characters, no faces, ' +
  'no text, no watermark, no logo, vertical portrait composition suited to a phone screen.'

async function objectExists(key: string): Promise<boolean> {
  const { S3Client } = await import('@aws-sdk/client-s3')
  const client = new S3Client({ region: env.AWS_REGION })
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function toCover(raw: Buffer): Promise<Buffer> {
  return sharp(raw)
    .resize(OUT_WIDTH, OUT_HEIGHT, { fit: 'cover', position: 'centre' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}

async function main() {
  const force = process.argv.includes('--force')

  if (!env.S3_BUCKET || !env.CDN_BASE_URL) {
    console.error('S3_BUCKET and CDN_BASE_URL must be set in .env')
    process.exit(1)
  }

  if (!force && (await objectExists(DEFAULT_COVER_KEY))) {
    const url = `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${DEFAULT_COVER_KEY}`
    console.log(`Default cover already exists — ${url}`)
    console.log('Use --force to regenerate.')
    return
  }

  console.log('Generating universal default cover…')
  const { data } = await generateImage(PROMPT)
  const cover = await toCover(data)

  const { url } = await storageService.upload(cover, 'image/webp', {
    key: DEFAULT_COVER_KEY,
  })

  console.log(`\nDefault cover uploaded (${(cover.length / 1024).toFixed(1)} KB)`)
  console.log(`CDN URL: ${url}`)
  console.log('\nNew worlds/characters without a portrait will use this automatically.')
}

main().catch((e) => {
  console.error('\nseed-default-cover failed:', e)
  process.exit(1)
})
