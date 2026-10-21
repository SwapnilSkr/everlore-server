import { scopeFromLegacyNamespace, vectorStore } from './vector-store'

/** Compatibility for offline callers; all addresses still pass strict scope validation. */
export async function deletePineconeNamespace(namespaceName: string): Promise<void> {
  await vectorStore.deleteScope(scopeFromLegacyNamespace(namespaceName))
}

export async function deletePineconeVector(namespaceName: string, vectorId: string): Promise<void> {
  await vectorStore.deleteIds(scopeFromLegacyNamespace(namespaceName), [vectorId])
}
