/**
 * bson >= 7.3 calls v8.startupSnapshot.isBuildingSnapshot() during ObjectId
 * static init. Bun 1.3.x exposes the method but throws ERR_NOT_IMPLEMENTED.
 */
const v8 = process.getBuiltinModule?.('v8') as
  | { startupSnapshot?: { isBuildingSnapshot?: () => boolean } }
  | undefined

if (v8?.startupSnapshot && typeof v8.startupSnapshot.isBuildingSnapshot === 'function') {
  try {
    v8.startupSnapshot.isBuildingSnapshot()
  } catch {
    v8.startupSnapshot.isBuildingSnapshot = () => false
  }
}
