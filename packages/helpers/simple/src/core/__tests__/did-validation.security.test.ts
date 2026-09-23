import { validateDIDDocument, validateDIDResolutionResult } from '../did-validation'
import { DID } from '../../modules/did'

const TXID = 'a'.repeat(64)
const DID_STRING = `did:bsv:${TXID}`
const PUBLIC_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const METHOD_ID = `${DID_STRING}#subject-key`

function document(): any {
  return DID.buildDocument(TXID, PUBLIC_KEY, DID_STRING, [
    {
      id: `${DID_STRING}#messages`,
      type: 'MessageBox',
      serviceEndpoint: 'https://example.com/messages'
    }
  ])
}

function resolution(): any {
  return {
    didDocument: document(),
    didDocumentMetadata: {
      created: '2026-09-21T00:00:00.000Z',
      updated: '2026-09-21T01:00:00.000Z',
      deactivated: false,
      versionId: 'b'.repeat(64),
      nextVersionId: 'c'.repeat(64)
    },
    didResolutionMetadata: {
      contentType: 'application/did+ld+json',
      message: 'resolved'
    }
  }
}

describe('DID document trust-boundary validation', () => {
  it('returns owned normalized document data', () => {
    const input = document()
    input['@context'] = ['https://www.w3.org/ns/did/v1', 'https://example.com/context']
    input.assertionMethod = [METHOD_ID]
    const validated = validateDIDDocument(input, DID_STRING)

    input['@context'][0] = 'mutated'
    input.authentication[0] = 'mutated'
    input.verificationMethod[0].publicKeyJwk.x = 'mutated'
    input.service[0].serviceEndpoint = 'https://attacker.example'

    expect(validated).toMatchObject({
      '@context': ['https://www.w3.org/ns/did/v1', 'https://example.com/context'],
      controller: DID_STRING,
      authentication: [METHOD_ID],
      assertionMethod: [METHOD_ID],
      service: [{ serviceEndpoint: 'https://example.com/messages' }]
    })
    expect(validated.verificationMethod[0].publicKeyJwk.x).not.toBe('mutated')
  })

  it('accepts and owns embedded verification methods in DID relationships', () => {
    const input = document()
    const embedded = {
      ...input.verificationMethod[0],
      id: `${DID_STRING}#embedded-key`,
      publicKeyJwk: { ...input.verificationMethod[0].publicKeyJwk }
    }
    input.authentication = [embedded]
    input.assertionMethod = [embedded]

    const validated = validateDIDDocument(input, DID_STRING)
    embedded.publicKeyJwk.x = 'mutated'

    expect(validated.authentication).toEqual([
      expect.objectContaining({ id: `${DID_STRING}#embedded-key` })
    ])
    expect(validated.assertionMethod).toEqual([
      expect.objectContaining({ id: `${DID_STRING}#embedded-key` })
    ])
    const authentication = validated.authentication[0]
    if (typeof authentication === 'string') throw new Error('Expected an embedded method')
    expect(authentication.publicKeyJwk.x).not.toBe('mutated')
  })

  it('rejects duplicate or conflicting embedded verification methods', () => {
    const duplicate = document()
    duplicate.authentication = [
      duplicate.verificationMethod[0],
      { ...duplicate.verificationMethod[0] }
    ]
    expect(() => validateDIDDocument(duplicate, DID_STRING)).toThrow(
      'Duplicate DID verification relationship'
    )

    const conflicting = document()
    conflicting.authentication = [
      { ...conflicting.verificationMethod[0], controller: `did:bsv:${'b'.repeat(64)}` }
    ]
    expect(() => validateDIDDocument(conflicting, DID_STRING)).toThrow(
      'Conflicting DID verification method'
    )

    const crossRelationshipReference = document()
    const assertionOnly = {
      ...crossRelationshipReference.verificationMethod[0],
      id: `${DID_STRING}#assertion-only`
    }
    crossRelationshipReference.authentication = [assertionOnly.id]
    crossRelationshipReference.assertionMethod = [assertionOnly]
    expect(() => validateDIDDocument(crossRelationshipReference, DID_STRING)).toThrow(
      'Invalid DID verification reference'
    )
  })

  it.each([
    ['non-record document', []],
    ['wrong identifier', { ...document(), id: `did:bsv:${'b'.repeat(64)}` }],
    ['missing DID context', { ...document(), '@context': ['https://example.com'] }],
    [
      'too many contexts',
      { ...document(), '@context': Array(9).fill('https://www.w3.org/ns/did/v1') }
    ],
    ['no verification method', { ...document(), verificationMethod: [] }],
    ['non-record verification method', { ...document(), verificationMethod: [null] }],
    [
      'duplicate verification method',
      {
        ...document(),
        verificationMethod: [document().verificationMethod[0], document().verificationMethod[0]]
      }
    ],
    [
      'unknown authentication reference',
      { ...document(), authentication: [`${DID_STRING}#unknown`] }
    ],
    ['unknown assertion reference', { ...document(), assertionMethod: [`${DID_STRING}#unknown`] }],
    ['non-DID controller', { ...document(), controller: 'https://example.com/controller' }],
    ['empty controller', { ...document(), controller: '' }]
  ])('rejects %s', (_name, input) => {
    expect(() => validateDIDDocument(input, DID_STRING)).toThrow()
  })

  it('rejects sparse arrays and accessors without invoking attacker code', () => {
    const sparse = document()
    sparse.authentication = Array(1)
    expect(() => validateDIDDocument(sparse, DID_STRING)).toThrow('Invalid DID authentication')

    const getter = jest.fn(() => DID_STRING)
    const hostile = document()
    Object.defineProperty(hostile, 'controller', { enumerable: true, get: getter })
    expect(() => validateDIDDocument(hostile, DID_STRING)).toThrow('does not match')
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong JWK type', { kty: 'RSA', crv: 'secp256k1' }],
    [
      'non-canonical x coordinate',
      { ...document().verificationMethod[0].publicKeyJwk, x: 'A'.repeat(42) }
    ],
    [
      'mismatched curve y coordinate',
      {
        ...document().verificationMethod[0].publicKeyJwk,
        y: `${document().verificationMethod[0].publicKeyJwk.y.slice(0, -1)}A`
      }
    ]
  ])('rejects a %s', (_name, publicKeyJwk) => {
    const input = document()
    input.verificationMethod[0].publicKeyJwk = publicKeyJwk
    expect(() => validateDIDDocument(input, DID_STRING)).toThrow()
  })

  it.each([
    ['cross-DID service ID', { id: 'did:bsv:foreign#messages' }],
    ['malformed service URL', { serviceEndpoint: 'not a URL' }],
    ['insecure service URL', { serviceEndpoint: 'http://example.com/messages' }],
    [
      'credential-bearing service URL',
      { serviceEndpoint: 'https://user:pass@example.com/messages' }
    ]
  ])('rejects a %s', (_name, servicePatch) => {
    const input = document()
    input.service[0] = { ...input.service[0], ...servicePatch }
    expect(() => validateDIDDocument(input, DID_STRING)).toThrow()
  })

  it('rejects duplicate and excessive services', () => {
    const duplicate = document()
    duplicate.service.push({ ...duplicate.service[0] })
    expect(() => validateDIDDocument(duplicate, DID_STRING)).toThrow('Duplicate DID service')

    const excessive = document()
    excessive.service = Array.from({ length: 33 }, (_, index) => ({
      id: `${DID_STRING}#service-${index}`,
      type: 'Example',
      serviceEndpoint: `https://example.com/${index}`
    }))
    expect(() => validateDIDDocument(excessive, DID_STRING)).toThrow('Invalid DID services')
  })
})

describe('DID resolution result trust-boundary validation', () => {
  it('normalizes valid metadata without retaining nested input objects', () => {
    const input = resolution()
    const validated = validateDIDResolutionResult(input, DID_STRING)
    input.didDocumentMetadata.versionId = 'd'.repeat(64)
    input.didResolutionMetadata.message = 'mutated'

    expect(validated.didDocumentMetadata).toEqual({
      created: '2026-09-21T00:00:00.000Z',
      updated: '2026-09-21T01:00:00.000Z',
      deactivated: false,
      versionId: 'b'.repeat(64),
      nextVersionId: 'c'.repeat(64)
    })
    expect(validated.didResolutionMetadata.message).toBe('resolved')
  })

  it.each([
    ['non-record envelope', []],
    ['missing document metadata', { didDocument: null, didResolutionMetadata: {} }],
    [
      'invalid deactivation state',
      { ...resolution(), didDocumentMetadata: { deactivated: 'yes' } }
    ],
    [
      'unknown error',
      { ...resolution(), didDocument: null, didResolutionMetadata: { error: 'other' } }
    ],
    [
      'wrong content type',
      { ...resolution(), didResolutionMetadata: { contentType: 'text/html' } }
    ],
    [
      'document and error together',
      { ...resolution(), didResolutionMetadata: { error: 'notFound' } }
    ],
    [
      'non-canonical creation time',
      { ...resolution(), didDocumentMetadata: { created: '2026-09-21' } }
    ],
    [
      'invalid version transaction',
      { ...resolution(), didDocumentMetadata: { versionId: 'A'.repeat(64) } }
    ]
  ])('rejects %s', (_name, input) => {
    expect(() => validateDIDResolutionResult(input, DID_STRING)).toThrow()
  })

  it('accepts a bounded not-found result', () => {
    expect(
      validateDIDResolutionResult(
        {
          didDocument: null,
          didDocumentMetadata: {},
          didResolutionMetadata: { error: 'notFound', message: 'not found' }
        },
        DID_STRING
      )
    ).toEqual({
      didDocument: null,
      didDocumentMetadata: {},
      didResolutionMetadata: { error: 'notFound', message: 'not found' }
    })
  })
})
