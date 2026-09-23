import type { DIDDocumentV2, DIDResolutionResult } from '../core/types'
import { validateDIDDocument } from '../core/did-validation'

const DID_CONTENT_TYPE = 'application/did+ld+json'

export interface WocChainState {
  did: string
  identityCode: string | undefined
  lastDocument: DIDDocumentV2 | null
  lastDocTxid: string | undefined
  created: string | undefined
  updated: string | undefined
  foundIssuance: boolean
}

export function processWocSegments(
  segments: string[],
  txData: any,
  currentTxid: string,
  state: WocChainState
): DIDResolutionResult | null {
  if (segments.length < 3) return null
  const identityCode = segments[1]
  const payload = segments[2]
  let timestamp: string | undefined
  if (Number.isSafeInteger(txData.time) && txData.time >= 0) {
    const date = new Date(txData.time * 1000)
    if (Number.isFinite(date.getTime())) timestamp = date.toISOString()
  }

  if (payload === '1') {
    if (state.foundIssuance || !/^[A-Za-z0-9_-]{1,128}$/.test(identityCode)) return null
    state.foundIssuance = true
    state.identityCode = identityCode
    return null
  }

  if (!state.foundIssuance || identityCode !== state.identityCode) return null

  if (payload === '3') {
    return {
      didDocument: state.lastDocument,
      didDocumentMetadata: {
        created: state.created,
        updated: state.updated,
        deactivated: true,
        versionId: currentTxid
      },
      didResolutionMetadata: { contentType: DID_CONTENT_TYPE }
    }
  }

  if (payload !== '2') {
    try {
      state.lastDocument = validateDIDDocument(JSON.parse(payload), state.did)
      state.lastDocTxid = currentTxid
      state.updated = timestamp
    } catch {
      // Not valid JSON
    }
  }
  return null
}
