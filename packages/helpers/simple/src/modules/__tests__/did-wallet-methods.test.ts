import { Beef, PrivateKey, Transaction } from '@bsv/sdk'
import * as SDK from '@bsv/sdk'
import { WalletCore } from '../../core/WalletCore'
import { createDIDMethods, DID } from '../did'

jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual<typeof import('@bsv/sdk')>('@bsv/sdk')
  return { ...actual, completeBoundAction: jest.fn(actual.completeBoundAction) }
})

const TXID = 'a'.repeat(64)
const DID_STRING = `did:bsv:${TXID}`
const SUBJECT_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'

function wocScript(identityCode: string, payload: string): string {
  const bytes = (value: string): number[] => Array.from(new TextEncoder().encode(value))
  return new SDK.Script()
    .writeOpCode(SDK.OP.OP_FALSE)
    .writeOpCode(SDK.OP.OP_RETURN)
    .writeBin(bytes('BSVDID'))
    .writeBin(bytes(identityCode))
    .writeBin(bytes(payload))
    .toHex()
}

function createCore(
  client: Record<string, jest.Mock>,
  didProxyUrl?: string,
  didResolverUrl = ''
): WalletCore {
  return {
    defaults: {
      didBasket: 'dids',
      didProtocolID: [0, 'bsvdid'],
      didProxyUrl,
      didResolverUrl,
      didFetch: global.fetch
    },
    getClient: jest.fn().mockReturnValue(client),
    getIdentityKey: jest.fn().mockReturnValue(SUBJECT_KEY)
  } as unknown as WalletCore
}

function chainInstructions(status: 'active' | 'deactivated'): string {
  return JSON.stringify({
    did: DID_STRING,
    identityCode: 'identity-code',
    issuanceTxid: TXID,
    subjectKey: SUBJECT_KEY,
    status
  })
}

describe('wallet-integrated DID methods', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest
      .mocked(SDK.completeBoundAction)
      .mockImplementation(
        jest.requireActual<typeof import('@bsv/sdk')>('@bsv/sdk').completeBoundAction
      )
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.clearAllMocks()
    jest.restoreAllMocks()
    jest.mocked(SDK.completeBoundAction).mockReset()
  })

  it('rejects unsafe identity codes before invoking the wallet', async () => {
    const client = {
      getPublicKey: jest.fn(),
      createAction: jest.fn()
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods.createDID({ identityCode: '../admin\n' })).rejects.toThrow(
      'URL-safe characters'
    )
    expect(client.getPublicKey).not.toHaveBeenCalled()
    expect(client.createAction).not.toHaveBeenCalled()
  })

  it('rejects inherited DID creation options without invoking the wallet', async () => {
    const client = { getPublicKey: jest.fn(), createAction: jest.fn() }
    const options = Object.create({
      identityCode: 'inherited-code',
      basket: 'inherited-basket',
      services: []
    }) as Parameters<ReturnType<typeof createDIDMethods>['createDID']>[0]

    await expect(createDIDMethods(createCore(client)).createDID(options)).rejects.toThrow(
      'plain data object'
    )
    expect(client.getPublicKey).not.toHaveBeenCalled()
    expect(client.createAction).not.toHaveBeenCalled()
  })

  it('rejects accessor-backed options despite an ambient descriptor value', async () => {
    const client = { getPublicKey: jest.fn(), createAction: jest.fn() }
    const identityCodeGetter = jest.fn()
    const options: Record<string, unknown> = {}
    Object.defineProperty(options, 'identityCode', {
      enumerable: true,
      get: identityCodeGetter
    })
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value')
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      value: 'ambient-code'
    })
    try {
      await expect(createDIDMethods(createCore(client)).createDID(options as any)).rejects.toThrow(
        'must be a data property'
      )
      expect(identityCodeGetter).not.toHaveBeenCalled()
      expect(client.getPublicKey).not.toHaveBeenCalled()
      expect(client.createAction).not.toHaveBeenCalled()
    } finally {
      if (previous == null) delete (Object.prototype as Record<string, unknown>).value
      else Object.defineProperty(Object.prototype, 'value', previous)
    }
  })

  it('rejects prototype-only public keys before creating an issuance', async () => {
    const client = {
      getPublicKey: jest.fn().mockResolvedValue(Object.create({ publicKey: SUBJECT_KEY })),
      createAction: jest.fn()
    }

    await expect(
      createDIDMethods(createCore(client)).createDID({ identityCode: 'own-code' })
    ).rejects.toThrow('object prototype')
    expect(client.createAction).not.toHaveBeenCalled()
  })

  it('rejects prototype-only issuance transaction IDs before basket polling', async () => {
    const client = {
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: SUBJECT_KEY }),
      createAction: jest.fn().mockResolvedValue(Object.create({ txid: TXID })),
      listOutputs: jest.fn()
    }

    await expect(
      createDIDMethods(createCore(client)).createDID({ identityCode: 'own-code' })
    ).rejects.toThrow('object prototype')
    expect(client.listOutputs).not.toHaveBeenCalled()
  })

  it('resolves active local chain state into a DID document', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        outputs: [{ outpoint: `${TXID}.0`, customInstructions: chainInstructions('active') }]
      })
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods._resolveFromBasket(DID_STRING)).resolves.toMatchObject({
      didDocument: {
        id: DID_STRING,
        controller: DID_STRING
      },
      didDocumentMetadata: {}
    })
  })

  it('resolves deactivated local chain state and preserves its last document', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        outputs: [{ outpoint: `${TXID}.0`, customInstructions: chainInstructions('deactivated') }]
      })
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods._resolveFromBasket(DID_STRING)).resolves.toMatchObject({
      didDocument: { id: DID_STRING },
      didDocumentMetadata: { deactivated: true }
    })
  })

  it('does not synthesize local chain state from inherited wallet outputs', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue(
        Object.create({
          outputs: [{ outpoint: `${TXID}.0`, customInstructions: chainInstructions('active') }]
        })
      )
    }

    await expect(
      createDIDMethods(createCore(client))._resolveFromBasket(DID_STRING)
    ).rejects.toThrow('plain data object')
  })

  it('rejects sparse wallet output pages', async () => {
    const outputs: unknown[] = []
    outputs.length = 1
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs }) }

    await expect(
      createDIDMethods(createCore(client))._resolveFromBasket(DID_STRING)
    ).rejects.toThrow('bounded dense array')
  })

  it('rejects accessor-backed wallet output entries despite an ambient descriptor value', async () => {
    const outputGetter = jest.fn()
    const outputs: unknown[] = []
    Object.defineProperty(outputs, '0', { enumerable: true, get: outputGetter })
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value')
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      value: { outpoint: `${TXID}.0`, customInstructions: chainInstructions('active') }
    })
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs }) }
    try {
      await expect(
        createDIDMethods(createCore(client))._resolveFromBasket(DID_STRING)
      ).rejects.toThrow('bounded dense array')
      expect(outputGetter).not.toHaveBeenCalled()
    } finally {
      if (previous == null) delete (Object.prototype as Record<string, unknown>).value
      else Object.defineProperty(Object.prototype, 'value', previous)
    }
  })

  it('accepts a valid result from the configured proxy resolver', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          didDocument: DID.buildDocument(TXID, SUBJECT_KEY),
          didDocumentMetadata: {},
          didResolutionMetadata: { contentType: 'application/did+ld+json' }
        })
      )
    )
    const methods = createDIDMethods(createCore(client, 'https://resolver-proxy.example'))

    await expect(methods.resolveDID(DID_STRING)).resolves.toMatchObject({
      didDocument: { id: DID_STRING }
    })
  })

  it('rejects a proxy document for another DID and an oversized resolver response', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    const foreign = DID.buildDocument('b'.repeat(64), SUBJECT_KEY)
    global.fetch = jest.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            didDocument: foreign,
            didDocumentMetadata: {},
            didResolutionMetadata: { contentType: 'application/did+ld+json' }
          })
        )
    )
    const methods = createDIDMethods(createCore(client, 'https://resolver-proxy.example'))
    await expect(methods.resolveDID(DID_STRING)).resolves.toMatchObject({
      didDocument: null
    })

    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
      )
    const oversizedMethods = createDIDMethods(createCore(client, 'https://resolver-proxy.example'))
    await expect(oversizedMethods.resolveDID(DID_STRING)).resolves.toMatchObject({
      didDocument: null
    })
  })

  it('rejects local chain metadata whose issuance does not match the requested DID', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        outputs: [
          {
            outpoint: `${TXID}.0`,
            customInstructions: JSON.stringify({
              ...JSON.parse(chainInstructions('active')),
              issuanceTxid: 'b'.repeat(64)
            })
          }
        ]
      })
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods._resolveFromBasket(DID_STRING)).rejects.toThrow(
      'does not match the requested DID'
    )
  })

  it('ignores incomplete chain records when listing owned DIDs', async () => {
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        outputs: [
          {
            outpoint: `${TXID}.0`,
            customInstructions: JSON.stringify({ identityCode: 'missing-did' })
          },
          {
            outpoint: `${TXID}.1`,
            customInstructions: chainInstructions('active')
          }
        ]
      })
    }
    const methods = createDIDMethods(createCore(client))

    await expect(methods.listDIDs()).resolves.toEqual([
      expect.objectContaining({
        did: DID_STRING,
        identityCode: 'identity-code',
        status: 'active'
      })
    ])
  })

  it('fails closed when a chain spend does not return a signable transaction', async () => {
    const chainKeyHex = PrivateKey.fromRandom().toHex()
    const client = {
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          outputs: [
            {
              outpoint: `${TXID}.0`,
              customInstructions: JSON.stringify({
                ...JSON.parse(chainInstructions('active')),
                chainKeyHex
              })
            }
          ]
        })
        .mockResolvedValueOnce({ BEEF: [1, 2, 3] }),
      createAction: jest.fn().mockResolvedValue({})
    }
    jest.spyOn(Beef.prototype, 'mergeBeef').mockImplementation(() => undefined)
    jest.spyOn(Beef.prototype, 'toBinary').mockReturnValue([1, 2, 3])
    const methods = createDIDMethods(createCore(client))

    await expect(methods.updateDID({ did: DID_STRING })).rejects.toThrow(
      'Wallet signable transaction must be a plain data object'
    )
  })

  it('delegates chain spends to the exact-outpoint bound action primitive', async () => {
    const chainKeyHex = PrivateKey.fromRandom().toHex()
    const client = {
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          outputs: [
            {
              outpoint: `${TXID}.0`,
              customInstructions: JSON.stringify({
                ...JSON.parse(chainInstructions('active')),
                chainKeyHex
              })
            }
          ]
        })
        .mockResolvedValueOnce({ BEEF: [1, 2, 3] }),
      createAction: jest.fn()
    }
    const signed = {
      id: jest.fn(() => 'c'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [4, 5, 6])
    } as unknown as Transaction
    jest.spyOn(Beef.prototype, 'mergeBeef').mockImplementation(() => undefined)
    jest.spyOn(Beef.prototype, 'toBinary').mockReturnValue([1, 2, 3])
    const complete = jest.mocked(SDK.completeBoundAction)
    complete.mockResolvedValueOnce(signed)
    const methods = createDIDMethods(createCore(client))

    await expect(methods.updateDID({ did: DID_STRING })).resolves.toMatchObject({
      did: DID_STRING,
      txid: TXID
    })
    expect(complete).toHaveBeenCalledTimes(1)
    const [, createArgs, options] = complete.mock.calls[0]
    expect(createArgs.inputs).toEqual([
      expect.objectContaining({ outpoint: `${TXID}.0`, unlockingScriptLength: 108 })
    ])
    expect(Object.keys(options?.inputSigners ?? {})).toEqual([`${TXID}.0`])
  })

  it('creates an issuance and an exact-outpoint-bound document chain transaction', async () => {
    const client = {
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: SUBJECT_KEY }),
      createAction: jest.fn().mockResolvedValue({ txid: TXID }),
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({ outputs: [{ outpoint: `${TXID}.0` }] })
        .mockResolvedValueOnce({ BEEF: [1, 2, 3] })
    }
    jest.spyOn(Beef.prototype, 'mergeBeef').mockImplementation(() => undefined)
    jest.spyOn(Beef.prototype, 'toBinary').mockReturnValue([1, 2, 3])
    const signed = {
      id: jest.fn(() => 'b'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [4, 5, 6])
    } as unknown as Transaction
    const sign = jest.fn().mockResolvedValue({})
    jest.spyOn(SDK.P2PKH.prototype, 'unlock').mockReturnValue({ sign } as any)
    const complete = jest
      .mocked(SDK.completeBoundAction)
      .mockImplementationOnce(async (_client, args, options) => {
        await options?.inputSigners?.[`${TXID}.0`]?.({} as Transaction, 0)
        return signed
      })
    const methods = createDIDMethods(createCore(client))
    const service = {
      id: '#messages',
      type: 'MessageBox',
      serviceEndpoint: 'https://example.com/messages'
    }
    await expect(
      methods.createDID({ identityCode: 'alice_1', services: [service] })
    ).resolves.toMatchObject({
      did: DID_STRING,
      txid: TXID,
      identityCode: 'alice_1',
      document: {
        id: DID_STRING,
        controller: DID_STRING,
        service: [{ ...service, id: `${DID_STRING}#messages` }]
      }
    })

    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            basket: 'dids',
            customInstructions: expect.stringContaining('"status":"pending"')
          }),
          expect.objectContaining({ satoshis: 0 })
        ]
      })
    )
    const [, documentArgs, options] = complete.mock.calls[0]
    expect(documentArgs.inputs).toEqual([
      expect.objectContaining({ outpoint: `${TXID}.0`, unlockingScriptLength: 108 })
    ])
    const documentOutputs = documentArgs.outputs ?? []
    expect(documentOutputs[0].customInstructions).toContain('"status":"active"')
    expect(documentOutputs[0].customInstructions).toContain(`"did":"${DID_STRING}"`)
    expect(documentOutputs[0].customInstructions).toContain(`"id":"${DID_STRING}#messages"`)
    expect(Object.keys(options?.inputSigners ?? {})).toEqual([`${TXID}.0`])
    expect(sign).toHaveBeenCalledWith({} as Transaction, 0)
  })

  it('validates document services before creating an orphaned issuance output', async () => {
    const client = {
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: SUBJECT_KEY }),
      createAction: jest.fn()
    }

    await expect(
      createDIDMethods(createCore(client)).createDID({
        services: [
          {
            id: '#messages',
            type: 'MessageBox',
            serviceEndpoint: 'http://insecure.example/messages'
          }
        ]
      })
    ).rejects.toThrow('DID creation failed')
    expect(client.createAction).not.toHaveBeenCalled()
  })

  it('rejects an absolute service identifier owned by a foreign DID before issuance', async () => {
    const client = {
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: SUBJECT_KEY }),
      createAction: jest.fn()
    }

    await expect(
      createDIDMethods(createCore(client)).createDID({
        services: [
          {
            id: `did:bsv:${'f'.repeat(64)}#messages`,
            type: 'MessageBox',
            serviceEndpoint: 'https://example.com/messages'
          }
        ]
      })
    ).rejects.toThrow('DID creation failed')
    expect(client.createAction).not.toHaveBeenCalled()
  })

  it('fails when issuance does not return a transaction id', async () => {
    const client = {
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: SUBJECT_KEY }),
      createAction: jest.fn().mockResolvedValue({})
    }

    await expect(
      createDIDMethods(createCore(client)).createDID({ identityCode: 'bounded-code' })
    ).rejects.toThrow('Invalid createAction result txid')
  })

  it('deactivates only the selected active chain state and records a local tracker', async () => {
    const chainKeyHex = PrivateKey.fromRandom().toHex()
    const client = {
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          outputs: [
            { outpoint: `${'f'.repeat(64)}.0`, customInstructions: '{invalid' },
            {
              outpoint: `${TXID}.0`,
              customInstructions: JSON.stringify({
                ...JSON.parse(chainInstructions('active')),
                chainKeyHex
              })
            }
          ]
        })
        .mockResolvedValueOnce({ BEEF: [1, 2, 3] })
    }
    jest.spyOn(Beef.prototype, 'mergeBeef').mockImplementation(() => undefined)
    jest.spyOn(Beef.prototype, 'toBinary').mockReturnValue([1, 2, 3])
    const complete = jest.mocked(SDK.completeBoundAction).mockResolvedValueOnce({
      id: jest.fn(() => 'd'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [7, 8, 9])
    } as unknown as Transaction)

    await expect(createDIDMethods(createCore(client)).deactivateDID(DID_STRING)).resolves.toEqual({
      txid: 'd'.repeat(64)
    })
    const [, args] = complete.mock.calls[0]
    expect(args.inputs).toEqual([expect.objectContaining({ outpoint: `${TXID}.0` })])
    const outputs = args.outputs ?? []
    expect(outputs).toHaveLength(2)
    expect(outputs[0]).toMatchObject({ satoshis: 0, outputDescription: 'DID revocation marker' })
    expect(outputs[1]).toMatchObject({
      satoshis: 1,
      basket: 'dids',
      customInstructions: expect.stringContaining('"status":"deactivated"')
    })
  })

  it.each([
    ['no active state', { outputs: [] }, 'No active chain state'],
    [
      'missing chain key',
      {
        outputs: [
          {
            outpoint: `${TXID}.0`,
            customInstructions: chainInstructions('active')
          }
        ]
      },
      'Chain key not found'
    ]
  ])('rejects deactivation with %s', async (_name, listResult, error) => {
    const client = { listOutputs: jest.fn().mockResolvedValue(listResult) }
    await expect(createDIDMethods(createCore(client)).deactivateDID(DID_STRING)).rejects.toThrow(
      error
    )
    expect(SDK.completeBoundAction).not.toHaveBeenCalled()
  })

  it('accepts a validated direct resolver document and a deactivated response', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    const activeDocument = DID.buildDocument(TXID, SUBJECT_KEY)
    activeDocument.authentication = [activeDocument.verificationMethod[0]]
    activeDocument.assertionMethod = [activeDocument.verificationMethod[0]]
    const active = {
      didDocument: activeDocument,
      didDocumentMetadata: {},
      didResolutionMetadata: {}
    }
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(active), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            didDocument: null,
            didDocumentMetadata: {},
            didResolutionMetadata: {}
          }),
          { status: 410 }
        )
      )
    const methods = createDIDMethods(createCore(client, '', 'https://resolver.example/base'))

    await expect(methods.resolveDID(DID_STRING)).resolves.toMatchObject({
      didDocument: {
        id: DID_STRING,
        authentication: [{ id: `${DID_STRING}#subject-key` }],
        assertionMethod: [{ id: `${DID_STRING}#subject-key` }]
      },
      didResolutionMetadata: { contentType: 'application/did+ld+json' }
    })
    await expect(methods.resolveDID(DID_STRING)).resolves.toMatchObject({
      didDocument: null,
      didDocumentMetadata: { deactivated: true }
    })
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `https://resolver.example/base/1.0/identifiers/${encodeURIComponent(DID_STRING)}`,
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
    )
  })

  it('ignores an ambient didDocument property when parsing a direct document', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    const document = DID.buildDocument(TXID, SUBJECT_KEY)
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'didDocument')
    Object.defineProperty(Object.prototype, 'didDocument', {
      configurable: true,
      value: DID.buildDocument('b'.repeat(64), SUBJECT_KEY)
    })
    try {
      global.fetch = jest
        .fn()
        .mockImplementation(async (url: string) =>
          url.startsWith('https://resolver.example')
            ? new Response(JSON.stringify(document), { status: 200 })
            : new Response('{}', { status: 404 })
        )
      const methods = createDIDMethods(createCore(client, '', 'https://resolver.example'))

      await expect(methods.resolveDID(DID_STRING)).resolves.toMatchObject({
        didDocument: { id: DID_STRING }
      })
    } finally {
      if (previous == null) delete (Object.prototype as Record<string, unknown>).didDocument
      else Object.defineProperty(Object.prototype, 'didDocument', previous)
    }
  })

  it('does not synthesize a deactivated document from an ambient property', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'didDocument')
    Object.defineProperty(Object.prototype, 'didDocument', {
      configurable: true,
      value: DID.buildDocument(TXID, SUBJECT_KEY)
    })
    try {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 410 }))
        .mockResolvedValue(new Response('{}', { status: 404 }))
      const methods = createDIDMethods(createCore(client, '', 'https://resolver.example'))

      await expect(methods.resolveDID(DID_STRING)).resolves.toMatchObject({
        didDocument: null,
        didDocumentMetadata: { deactivated: true }
      })
    } finally {
      if (previous == null) delete (Object.prototype as Record<string, unknown>).didDocument
      else Object.defineProperty(Object.prototype, 'didDocument', previous)
    }
  })

  it('resolves a legacy public-key DID without consulting wallet or network state', async () => {
    const client = { listOutputs: jest.fn() }
    await expect(
      createDIDMethods(createCore(client)).resolveDID(`did:bsv:${SUBJECT_KEY}`)
    ).resolves.toMatchObject({
      didDocument: { id: `did:bsv:${SUBJECT_KEY}` },
      didResolutionMetadata: { contentType: 'application/did+ld+json' }
    })
    expect(client.listOutputs).not.toHaveBeenCalled()
  })

  it('accepts a bounded direct-resolver response without a readable body stream', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    const document = DID.buildDocument(TXID, SUBJECT_KEY)
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: null,
      text: jest.fn(async () => JSON.stringify(document))
    } as unknown as Response)

    await expect(
      createDIDMethods(createCore(client, '', 'https://resolver.example')).resolveDID(DID_STRING)
    ).resolves.toMatchObject({ didDocument: { id: DID_STRING } })
  })

  it('rejects a streamed resolver response that crosses the size limit', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    global.fetch = jest
      .fn()
      .mockImplementation(async (url: string) =>
        url.startsWith('https://proxy.example')
          ? new Response('x'.repeat(2 * 1024 * 1024 + 1))
          : new Response('{}', { status: 404 })
      )

    await expect(
      createDIDMethods(createCore(client, 'https://proxy.example')).resolveDID(DID_STRING)
    ).resolves.toMatchObject({ didResolutionMetadata: { error: 'notFound' } })
  })

  it.each([
    ' https://resolver.example',
    'http://resolver.example',
    'https://user:pass@resolver.example',
    'https://resolver.example?query=yes',
    'https://resolver.example#fragment',
    'x'.repeat(2049)
  ])('rejects unsafe resolver URL %p and falls back without using it', async resolverUrl => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 404 }))

    await expect(
      createDIDMethods(createCore(client, resolverUrl)).resolveDID(DID_STRING)
    ).resolves.toMatchObject({ didResolutionMetadata: { error: 'notFound' } })
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.whatsonchain.com'),
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it('falls through a non-matching proxy result to the authoritative chain view', async () => {
    const client = { listOutputs: jest.fn().mockResolvedValue({ outputs: [] }) }
    global.fetch = jest.fn().mockImplementation(async (url: string) =>
      url.startsWith('https://proxy.example')
        ? new Response(
            JSON.stringify({
              didDocument: null,
              didDocumentMetadata: {},
              didResolutionMetadata: { error: 'notFound' }
            })
          )
        : new Response('{}', { status: 404 })
    )

    await expect(
      createDIDMethods(createCore(client, 'https://proxy.example')).resolveDID(DID_STRING)
    ).resolves.toMatchObject({ didResolutionMetadata: { error: 'notFound' } })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an unavailable transaction', 404, {}],
    ['a null transaction', 200, null],
    ['a mismatched transaction ID', 200, { txid: 'b'.repeat(64), vout: [] }],
    ['a non-array output list', 200, { txid: TXID, vout: {} }]
  ])('rejects %s from the chain data source', async (_name, status, body) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
    const methods = createDIDMethods(createCore({}))

    await expect(methods._resolveViaWhatsOnChain(TXID)).resolves.toMatchObject({
      didDocument: null,
      didResolutionMetadata: { error: 'notFound' }
    })
  })

  it('does not accept an ambient transaction ID from the chain data source', async () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'txid')
    Object.defineProperty(Object.prototype, 'txid', { configurable: true, value: TXID })
    try {
      global.fetch = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            vout: [{ scriptPubKey: { hex: wocScript('ambient', '1') } }]
          }),
          { status: 200 }
        )
      )

      await expect(
        createDIDMethods(createCore({}))._resolveViaWhatsOnChain(TXID)
      ).resolves.toMatchObject({ didResolutionMetadata: { error: 'notFound' } })
      expect(global.fetch).toHaveBeenCalledTimes(1)
    } finally {
      if (previous == null) delete (Object.prototype as Record<string, unknown>).txid
      else Object.defineProperty(Object.prototype, 'txid', previous)
    }
  })

  it('rejects a chain hop that is not bound to the previous output-zero spend', async () => {
    const nextTxid = 'b'.repeat(64)
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 400))
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(`/tx/${TXID}`)) {
        return new Response(JSON.stringify({ txid: TXID, vout: [], time: 1 }))
      }
      if (url.endsWith(`/tx/${TXID}/out/0/spend`)) {
        return new Response(JSON.stringify({ txid: nextTxid }))
      }
      return new Response(JSON.stringify({ txid: nextTxid, vout: [], vin: [] }))
    })

    await expect(
      createDIDMethods(createCore({}))._resolveViaWhatsOnChain(TXID)
    ).resolves.toMatchObject({ didResolutionMetadata: { error: 'notFound' } })
  })

  it('follows an output-zero spend and returns the latest validated DID document', async () => {
    const nextTxid = 'b'.repeat(64)
    const document = DID.buildDocument(TXID, SUBJECT_KEY)
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 400))
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(`/tx/${TXID}`)) {
        return new Response(
          JSON.stringify({
            txid: TXID,
            vout: [{ scriptPubKey: { hex: wocScript('alice', '1') } }],
            time: 1_753_660_800
          })
        )
      }
      if (url.endsWith(`/tx/${TXID}/out/0/spend`)) {
        return new Response(JSON.stringify({ txid: nextTxid }))
      }
      if (url.endsWith(`/tx/${nextTxid}`)) {
        return new Response(
          JSON.stringify({
            txid: nextTxid,
            vin: [{ txid: TXID, vout: 0 }],
            vout: [{ scriptPubKey: { hex: wocScript('alice', JSON.stringify(document)) } }],
            time: 1_753_664_400
          })
        )
      }
      return new Response('{}', { status: 404 })
    })

    await expect(
      createDIDMethods(createCore({}))._resolveViaWhatsOnChain(TXID)
    ).resolves.toMatchObject({
      didDocument: { id: DID_STRING },
      didDocumentMetadata: { versionId: nextTxid },
      didResolutionMetadata: { contentType: 'application/did+ld+json' }
    })
  })

  it('contains spend-index failures and returns not found', async () => {
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 400))
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(`/tx/${TXID}`)) {
        return new Response(JSON.stringify({ txid: TXID, vout: [] }))
      }
      throw new Error('spend index unavailable')
    })

    await expect(
      createDIDMethods(createCore({}))._resolveViaWhatsOnChain(TXID)
    ).resolves.toMatchObject({ didResolutionMetadata: { error: 'notFound' } })
  })
})
