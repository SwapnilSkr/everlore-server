import type sharp from 'sharp'

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
