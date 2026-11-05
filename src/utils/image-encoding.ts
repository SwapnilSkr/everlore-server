import sharp from 'sharp'
import { log } from './logger'

/**
 * The one encoding for creator-selected images, shared by the upload route and
 * the catalog seed so the seed can tell whether a stored cover is current.
 * Lossy WebP at 82: covers are paintings, where lossless cost ~1.7 MB each
 * (10+ s for a shelf on a slow phone connection) for no visible difference.
 */
export function encodeUserImage(image: sharp.Sharp): Promise<Buffer> {
  return image
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 6 })
    .toBuffer()
}

export interface EncodedImage {
  data: Buffer
  contentType: string
}

/**
 * A generated still is stored with the same bounded encoding as an uploaded
 * one: the generator returns a few-MB PNG and every picture is fetched on a
 * phone. Callers gate the generator's exact bytes first — this runs after the
 * safety check and before the upload — then take the key extension from
 * `contentType`, which is `image/webp` whenever encoding succeeded.
 *
 * Compression never costs a player a paid picture: bytes sharp cannot decode
 * are uploaded exactly as the generator returned them, with a warning.
 */
export async function encodeGeneratedStill(image: EncodedImage, kind: string): Promise<EncodedImage> {
  try {
    const data = await encodeUserImage(sharp(image.data, { limitInputPixels: 40_000_000 }))
    return { data, contentType: 'image/webp' }
  } catch (error) {
    log.warn('image.encode_failed', {
      kind, contentType: image.contentType, bytes: image.data.length,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    })
    return image
  }
}
