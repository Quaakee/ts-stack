import { processWocSegments, type WocChainState } from '../did-woc'
import { DID } from '../did'

const TXID = 'a'.repeat(64)
const DID_STRING = `did:bsv:${TXID}`
const PUBKEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const document = DID.buildDocument(TXID, PUBKEY)

function chainState(): WocChainState {
  return {
    did: DID_STRING,
    identityCode: undefined,
    lastDocument: null,
    lastDocTxid: undefined,
    created: '2026-07-28T00:00:00.000Z',
    updated: undefined,
    foundIssuance: false
  }
}

describe('DID WhatsOnChain transitions', () => {
  it('ignores incomplete, funding, and malformed-document segments', () => {
    const state = chainState()

    expect(processWocSegments(['BSVDID', 'identity'], {}, 'incomplete', state)).toBeNull()
    expect(processWocSegments(['BSVDID', 'identity', '2'], {}, 'funding', state)).toBeNull()
    expect(
      processWocSegments(['BSVDID', 'identity', '{invalid'], {}, 'malformed', state)
    ).toBeNull()
    expect(state).toEqual(chainState())
  })

  it('records issuance and valid document transitions', () => {
    const state = chainState()

    expect(processWocSegments(['BSVDID', 'identity', '1'], {}, 'issuance', state)).toBeNull()
    expect(state.foundIssuance).toBe(true)

    expect(
      processWocSegments(
        ['BSVDID', 'identity', JSON.stringify(document)],
        { time: 1_753_660_800 },
        'document',
        state
      )
    ).toBeNull()
    expect(state).toEqual({
      lastDocument: document,
      lastDocTxid: 'document',
      created: '2026-07-28T00:00:00.000Z',
      updated: '2025-07-28T00:00:00.000Z',
      foundIssuance: true,
      did: DID_STRING,
      identityCode: 'identity'
    })
  })

  it('rejects documents before issuance, from another identity chain, or for another DID', () => {
    const state = chainState()
    processWocSegments(['BSVDID', 'identity', JSON.stringify(document)], {}, 'pre-issuance', state)
    expect(state.lastDocument).toBeNull()

    processWocSegments(['BSVDID', 'identity', '1'], {}, TXID, state)
    processWocSegments(
      ['BSVDID', 'other-identity', JSON.stringify(document)],
      {},
      'wrong-chain',
      state
    )
    expect(state.lastDocument).toBeNull()

    const foreign = DID.buildDocument('b'.repeat(64), PUBKEY)
    processWocSegments(
      ['BSVDID', 'identity', JSON.stringify(foreign)],
      {},
      'foreign-document',
      state
    )
    expect(state.lastDocument).toBeNull()
  })

  it('returns the last document when the chain is deactivated', () => {
    const state = chainState()
    state.foundIssuance = true
    state.identityCode = 'identity'
    state.lastDocument = document
    state.updated = '2026-07-28T01:00:00.000Z'

    expect(processWocSegments(['BSVDID', 'identity', '3'], {}, 'revocation', state)).toEqual({
      didDocument: state.lastDocument,
      didDocumentMetadata: {
        created: state.created,
        updated: state.updated,
        deactivated: true,
        versionId: 'revocation'
      },
      didResolutionMetadata: { contentType: 'application/did+ld+json' }
    })
  })
})
