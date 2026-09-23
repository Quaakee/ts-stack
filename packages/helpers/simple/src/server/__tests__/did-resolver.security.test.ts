import { OP, Script, Utils } from '@bsv/sdk'
import { DID } from '../../modules/did'
import { DIDResolverService } from '../did-resolver'

const TXID = 'a'.repeat(64)
const NEXT_TXID = 'b'.repeat(64)
const DID_STRING = `did:bsv:${TXID}`
const SUBJECT_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'

function marker(payload: string): string {
  return new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray('BSVDID', 'utf8'))
    .writeBin(Utils.toArray('identity', 'utf8'))
    .writeBin(Utils.toArray(payload, 'utf8'))
    .toHex()
}

describe('DIDResolverService security boundaries', () => {
  it('ignores inherited transport and endpoint configuration', () => {
    const ambientFetch = jest.fn()
    Object.defineProperties(Object.prototype, {
      resolverUrl: { value: 'http://ambient.invalid', configurable: true, writable: true },
      wocBaseUrl: { value: 'http://ambient.invalid', configurable: true, writable: true },
      fetch: { value: ambientFetch, configurable: true, writable: true }
    })
    try {
      const resolver = new DIDResolverService({}) as unknown as {
        resolverUrl: string
        wocBaseUrl: string
        trustedFetch?: typeof fetch
      }
      expect(resolver.resolverUrl).toBe('https://bsvdid-universal-resolver.nchain.systems')
      expect(resolver.wocBaseUrl).toBe('https://api.whatsonchain.com/v1/bsv/main')
      expect(resolver.trustedFetch).toBeUndefined()
      expect(ambientFetch).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'resolverUrl')
      Reflect.deleteProperty(Object.prototype, 'wocBaseUrl')
      Reflect.deleteProperty(Object.prototype, 'fetch')
    }
  })

  it('does not obtain a deactivated DID document from Object.prototype', async () => {
    Object.defineProperty(Object.prototype, 'didDocument', {
      value: DID.buildDocument(TXID, SUBJECT_KEY),
      configurable: true
    })
    try {
      const fetchMock = jest.fn(async () => new Response('{}', { status: 410 }))
      const resolver = new DIDResolverService({ fetch: fetchMock as typeof fetch })
      await expect(resolver.resolve(DID_STRING)).resolves.toMatchObject({
        didDocument: null,
        didDocumentMetadata: { deactivated: true }
      })
    } finally {
      Reflect.deleteProperty(Object.prototype, 'didDocument')
    }
  })

  it('accepts only a resolver document bound to the requested DID', async () => {
    const foreign = DID.buildDocument(NEXT_TXID, SUBJECT_KEY)
    const fetchMock = jest.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            didDocument: foreign,
            didDocumentMetadata: {},
            didResolutionMetadata: { contentType: 'application/did+ld+json' }
          })
        )
    )
    const resolver = new DIDResolverService({ fetch: fetchMock as typeof fetch })

    await expect(resolver.resolve(DID_STRING)).resolves.toMatchObject({ didDocument: null })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(DID_STRING)),
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it('follows only the authenticated output-zero spend chain and rejects an unrelated next transaction', async () => {
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/1.0/identifiers/')) return new Response('{}', { status: 404 })
      if (url.endsWith(`/tx/${TXID}`)) {
        return new Response(
          JSON.stringify({
            txid: TXID,
            time: 1_753_660_800,
            vout: [{ scriptPubKey: { hex: marker('1') } }]
          })
        )
      }
      if (url.endsWith(`/tx/${TXID}/out/0/spend`)) {
        return new Response(JSON.stringify({ txid: NEXT_TXID }))
      }
      if (url.endsWith(`/tx/${NEXT_TXID}`)) {
        return new Response(
          JSON.stringify({
            txid: NEXT_TXID,
            vin: [],
            vout: [
              {
                scriptPubKey: { hex: marker(JSON.stringify(DID.buildDocument(TXID, SUBJECT_KEY))) }
              }
            ]
          })
        )
      }
      throw new Error(`Unexpected test URL: ${url}`)
    })
    const resolver = new DIDResolverService({ fetch: fetchMock as typeof fetch })

    await expect(resolver.resolve(DID_STRING)).resolves.toMatchObject({
      didDocument: null,
      didResolutionMetadata: { error: 'notFound' }
    })
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/history'))).toBe(false)
  })

  it('rejects insecure endpoints, unbounded work factors, and oversized responses', async () => {
    expect(() => new DIDResolverService({ resolverUrl: 'http://resolver.example' })).toThrow(
      'credential-free HTTPS'
    )
    expect(() => new DIDResolverService({ maxHops: Number.POSITIVE_INFINITY })).toThrow('maxHops')
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
      )
    const resolver = new DIDResolverService({ fetch: fetchMock as typeof fetch })
    await expect(resolver.resolve(DID_STRING)).resolves.toMatchObject({ didDocument: null })
  })
})
