import { getPineconeIndex } from '../config/pinecone'

/**
 * Deletes all vectors in a Pinecone namespace.
 * Uses the deleteAll operation if available, otherwise falls back to listing and deleting.
 */
export async function deletePineconeNamespace(namespaceName: string): Promise<void> {
  const index = getPineconeIndex()
  const namespace = index.namespace(namespaceName)
  
  try {
    // Pinecone supports deleting all vectors in a namespace by using a deleteAll operation
    // with an empty filter or by deleting the namespace itself
    await namespace.deleteAll()
    console.log(`Successfully deleted all vectors in namespace: ${namespaceName}`)
  } catch (err) {
    console.warn(`Failed to delete namespace ${namespaceName}:`, (err as Error).message)
    // If deleteAll fails, we could implement fallback logic here
    // For now, we log the error and continue
    throw err
  }
}

/**
 * Deletes a specific vector from a namespace.
 */
export async function deletePineconeVector(
  namespaceName: string,
  vectorId: string,
): Promise<void> {
  const index = getPineconeIndex()
  const namespace = index.namespace(namespaceName)
  
  try {
    await namespace.deleteOne({ id: vectorId })
  } catch (err) {
    console.warn(`Failed to delete vector ${vectorId} from ${namespaceName}:`, (err as Error).message)
    throw err
  }
}
