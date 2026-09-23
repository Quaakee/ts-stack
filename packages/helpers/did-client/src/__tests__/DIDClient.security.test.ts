import {
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Script,
  TopicBroadcaster,
  Transaction,
  Utils,
  type CreateActionArgs,
  type SignActionArgs,
  type WalletInterface
} from '@bsv/sdk'
import { DIDClient } from '../index.js'

const prefix = Utils.toBase64([1, 2, 3])
const suffix = Utils.toBase64([4, 5, 6])
const serialNumber = Utils.toBase64(Utils.toArray('security-serial', 'utf8'))

class DIDWalletHarness {
  readonly key = PrivateKey.fromRandom()
  readonly crypto = new ProtoWallet(this.key)
  readonly subject = this.key.toPublicKey().toString()
  readonly createAction = jest.fn(async (args: CreateActionArgs) => {
    const partial = new Transaction()
    const walletSource = new Transaction()
    walletSource.addOutput({ satoshis: 2, lockingScript: Script.fromASM('OP_1') })
    partial.addInput({
      sourceTransaction: walletSource,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_0')
    })
    for (const requested of args.inputs ?? []) {
      const [sourceTXID, outputIndex] = requested.outpoint.split('.')
      partial.addInput({
        sourceTransaction: Transaction.fromBEEF(args.inputBEEF!, sourceTXID),
        sourceOutputIndex: Number(outputIndex),
        unlockingScript: Script.fromASM('OP_0')
      })
    }
    for (const output of args.outputs ?? []) {
      partial.addOutput({
        satoshis: output.satoshis,
        lockingScript: Script.fromHex(output.lockingScript)
      })
    }
    this.partial = partial
    return {
      signableTransaction: {
        reference: 'c2VjdXJpdHktZGlk',
        tx: partial.toAtomicBEEF(true)
      }
    }
  })
  readonly signAction = jest.fn(async (args: SignActionArgs) => {
    const signed = Transaction.fromAtomicBEEF(this.partial!.toAtomicBEEF(true))
    for (const [index, spend] of Object.entries(args.spends)) {
      signed.inputs[Number(index)].unlockingScript = Script.fromHex(spend.unlockingScript)
    }
    this.signed = signed
    return { tx: signed.toAtomicBEEF(true), txid: signed.id('hex') }
  })
  readonly abortAction = jest.fn(async () => ({ aborted: true as const }))
  readonly getNetwork = jest.fn(async () => ({ network: 'mainnet' as const }))

  partial?: Transaction
  signed?: Transaction
  listResult?: any

  async getPublicKey(args: any) {
    return await this.crypto.getPublicKey(args)
  }

  async createSignature(args: any) {
    return await this.crypto.createSignature(args)
  }

  async verifySignature(args: any) {
    return await this.crypto.verifySignature(args)
  }

  async listOutputs() {
    return this.listResult
  }
}

async function sourceFixture(wallet: DIDWalletHarness, subject = wallet.subject) {
  const lockingScript = await new PushDrop(wallet as unknown as WalletInterface).lock(
    [Utils.toArray(serialNumber, 'base64')],
    [2, 'did token'],
    `${prefix} ${suffix}`,
    subject,
    true
  )
  const source = new Transaction()
  source.addOutput({ satoshis: 1, lockingScript })
  const outpoint = `${source.id('hex')}.0`
  return {
    source,
    outpoint,
    walletOutput: {
      outpoint,
      satoshis: 1,
      spendable: true,
      lockingScript: lockingScript.toHex(),
      customInstructions: JSON.stringify({ derivationPrefix: prefix, derivationSuffix: suffix }),
      tags: [`did-token-subject-${subject}`, `did-token-serialNumber-${serialNumber}`]
    }
  }
}

describe('DIDClient security boundaries', () => {
  afterEach(() => jest.restoreAllMocks())

  it('creates an issuer-owned token with bounded metadata and authenticates it before broadcast', async () => {
    const wallet = new DIDWalletHarness()
    const verifySignature = jest.spyOn(wallet, 'verifySignature')
    const broadcast = jest
      .spyOn(TopicBroadcaster.prototype, 'broadcast')
      .mockImplementation(async tx => ({
        status: 'success',
        txid: tx.id('hex'),
        message: 'accepted'
      }))

    await expect(
      new DIDClient({
        wallet: wallet as unknown as WalletInterface,
        acceptDelayedBroadcast: true
      }).createDID(serialNumber, wallet.subject, {
        derivationPrefix: prefix,
        derivationSuffix: suffix
      })
    ).resolves.toMatchObject({ status: 'success' })

    expect(verifySignature).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: [2, 'did token'],
        keyID: `${prefix} ${suffix}`,
        counterparty: wallet.subject,
        forSelf: true
      })
    )
    expect(wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            basket: 'did',
            tags: [`did-token-subject-${wallet.subject}`, `did-token-serialNumber-${serialNumber}`],
            customInstructions: JSON.stringify({
              derivationPrefix: prefix,
              derivationSuffix: suffix
            })
          })
        ],
        options: expect.objectContaining({
          acceptDelayedBroadcast: true,
          randomizeOutputs: false
        })
      }),
      undefined
    )
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('generates paired derivation metadata and rejects incomplete or substituted creation data', async () => {
    const generatedWallet = new DIDWalletHarness()
    jest.spyOn(TopicBroadcaster.prototype, 'broadcast').mockImplementation(async tx => ({
      status: 'success',
      txid: tx.id('hex'),
      message: 'accepted'
    }))
    await expect(
      new DIDClient({ wallet: generatedWallet as unknown as WalletInterface }).createDID(
        serialNumber,
        generatedWallet.subject
      )
    ).resolves.toMatchObject({ status: 'success' })
    const generatedInstructions = JSON.parse(
      generatedWallet.createAction.mock.calls[0][0].outputs?.[0].customInstructions ?? ''
    ) as Record<string, string>
    expect(generatedInstructions.derivationPrefix).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(generatedInstructions.derivationSuffix).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)

    const invalidWallet = new DIDWalletHarness()
    const invalidClient = new DIDClient({ wallet: invalidWallet as unknown as WalletInterface })
    await expect(
      invalidClient.createDID(serialNumber, invalidWallet.subject, { derivationPrefix: prefix })
    ).rejects.toThrow('Both DID derivation parameters')
    await expect(
      invalidClient.createDID(serialNumber, 'not-a-public-key' as never)
    ).rejects.toThrow('compressed public key')
    expect(invalidWallet.createAction).not.toHaveBeenCalled()

    const substitutedWallet = new DIDWalletHarness()
    const originalGetPublicKey = substitutedWallet.getPublicKey.bind(substitutedWallet)
    const attacker = PrivateKey.fromRandom().toPublicKey().toString()
    jest
      .spyOn(substitutedWallet, 'getPublicKey')
      .mockImplementationOnce(originalGetPublicKey)
      .mockResolvedValueOnce({ publicKey: attacker })
    await expect(
      new DIDClient({ wallet: substitutedWallet as unknown as WalletInterface }).createDID(
        serialNumber,
        substitutedWallet.subject,
        { derivationPrefix: prefix, derivationSuffix: suffix }
      )
    ).rejects.toThrow('substituted locking key')
    expect(substitutedWallet.createAction).not.toHaveBeenCalled()

    const invalidSignatureWallet = new DIDWalletHarness()
    jest
      .spyOn(invalidSignatureWallet, 'verifySignature')
      .mockResolvedValue({ valid: false } as never)
    await expect(
      new DIDClient({ wallet: invalidSignatureWallet as unknown as WalletInterface }).createDID(
        serialNumber,
        invalidSignatureWallet.subject,
        { derivationPrefix: prefix, derivationSuffix: suffix }
      )
    ).rejects.toThrow('invalid DID token signature')
    expect(invalidSignatureWallet.createAction).not.toHaveBeenCalled()
  })

  it('rejects an overlay acknowledgement bound to a different transaction', async () => {
    const wallet = new DIDWalletHarness()
    jest.spyOn(TopicBroadcaster.prototype, 'broadcast').mockResolvedValue({
      status: 'success',
      txid: '00'.repeat(32),
      message: 'substituted'
    })

    await expect(
      new DIDClient({ wallet: wallet as unknown as WalletInterface }).createDID(
        serialNumber,
        wallet.subject,
        { derivationPrefix: prefix, derivationSuffix: suffix }
      )
    ).rejects.toThrow('acknowledged a different transaction ID')
  })

  it('signs the requested DID input at its actual wallet-selected index', async () => {
    const wallet = new DIDWalletHarness()
    const fixture = await sourceFixture(wallet)
    wallet.listResult = {
      totalOutputs: 1,
      outputs: [fixture.walletOutput],
      BEEF: fixture.source.toBEEF()
    }
    jest.spyOn(TopicBroadcaster.prototype, 'broadcast').mockImplementation(async tx => ({
      status: 'success',
      txid: tx.id('hex'),
      message: 'accepted'
    }))

    await expect(
      new DIDClient({ wallet: wallet as unknown as WalletInterface }).revokeDID({ serialNumber })
    ).resolves.toMatchObject({ status: 'success' })
    expect(wallet.signAction.mock.calls[0][0].spends).toHaveProperty('1')
    expect(wallet.signed?.inputs[1].unlockingScript?.chunks).toHaveLength(1)
  })

  it('rejects wallet metadata that relabels the token serial', async () => {
    const wallet = new DIDWalletHarness()
    const fixture = await sourceFixture(wallet)
    fixture.walletOutput.tags[1] = `did-token-serialNumber-${Utils.toBase64([9])}`
    wallet.listResult = {
      totalOutputs: 1,
      outputs: [fixture.walletOutput],
      BEEF: fixture.source.toBEEF()
    }

    await expect(
      new DIDClient({ wallet: wallet as unknown as WalletInterface }).revokeDID({ serialNumber })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_INVALID_DID_TOKEN' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('fails closed on malformed, ambiguous, or incomplete wallet results', async () => {
    const malformedWallet = new DIDWalletHarness()
    malformedWallet.listResult = { totalOutputs: 0, outputs: 'not-an-array' }
    await expect(
      new DIDClient({ wallet: malformedWallet as unknown as WalletInterface }).revokeDID({
        serialNumber
      })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_INVALID_WALLET_RESULT' })

    const ambiguousWallet = new DIDWalletHarness()
    ambiguousWallet.listResult = {
      totalOutputs: 2,
      outputs: [
        { outpoint: `${'1'.repeat(64)}.0`, satoshis: 1 },
        { outpoint: `${'2'.repeat(64)}.0`, satoshis: 1 }
      ]
    }
    await expect(
      new DIDClient({ wallet: ambiguousWallet as unknown as WalletInterface }).revokeDID({
        serialNumber
      })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_AMBIGUOUS_DID' })

    const missingInstructionsWallet = new DIDWalletHarness()
    missingInstructionsWallet.listResult = {
      totalOutputs: 1,
      outputs: [
        {
          outpoint: `${'1'.repeat(64)}.0`,
          satoshis: 1,
          tags: [`did-token-subject-${missingInstructionsWallet.subject}`]
        }
      ]
    }
    await expect(
      new DIDClient({ wallet: missingInstructionsWallet as unknown as WalletInterface }).revokeDID({
        serialNumber
      })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_MISSING_INSTRUCTIONS' })

    const noBeefWallet = new DIDWalletHarness()
    const noBeefFixture = await sourceFixture(noBeefWallet)
    noBeefWallet.listResult = { totalOutputs: 1, outputs: [noBeefFixture.walletOutput] }
    await expect(
      new DIDClient({ wallet: noBeefWallet as unknown as WalletInterface }).revokeDID({
        serialNumber
      })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_NO_BEEF' })
  })

  it('rejects hostile wallet BEEF, tags, derivation data, and source bindings before signing', async () => {
    type Fixture = Awaited<ReturnType<typeof sourceFixture>>
    const attempt = async (
      mutate: (fixture: Fixture, wallet: DIDWalletHarness) => void,
      request: { serialNumber?: string; outpoint?: string } = { serialNumber },
      beef?: number[]
    ) => {
      const wallet = new DIDWalletHarness()
      const fixture = await sourceFixture(wallet)
      mutate(fixture, wallet)
      wallet.listResult = {
        totalOutputs: 1,
        outputs: [fixture.walletOutput],
        BEEF: beef ?? fixture.source.toBEEF()
      }
      const result = await new DIDClient({
        wallet: wallet as unknown as WalletInterface
      }).revokeDID(request)
      expect(wallet.createAction).not.toHaveBeenCalled()
      return result
    }

    const invalidCases: Array<(fixture: Fixture, wallet: DIDWalletHarness) => void> = [
      fixture => {
        fixture.walletOutput.spendable = false
      },
      fixture => {
        fixture.walletOutput.satoshis = 2
      },
      fixture => {
        fixture.walletOutput.lockingScript = '00'
      },
      fixture => {
        fixture.walletOutput.tags = [
          ...fixture.walletOutput.tags,
          `did-token-subject-${fixture.walletOutput.tags[0].slice('did-token-subject-'.length)}`
        ]
      },
      fixture => {
        const sparse = Array.from({ length: 3 }) as string[]
        sparse[0] = fixture.walletOutput.tags[0]
        sparse[2] = fixture.walletOutput.tags[1]
        fixture.walletOutput.tags = sparse
      },
      fixture => {
        fixture.walletOutput.tags = [
          fixture.walletOutput.tags[0],
          fixture.walletOutput.tags[1],
          `did-token-serialNumber-${Utils.toBase64([9])}`
        ]
      },
      fixture => {
        fixture.walletOutput.tags = [
          fixture.walletOutput.tags[0],
          fixture.walletOutput.tags[1],
          ...Array.from({ length: 63 }, (_, index) => `unrelated-${index}`)
        ]
      },
      fixture => {
        fixture.walletOutput.customInstructions = '0'
      },
      fixture => {
        fixture.walletOutput.customInstructions = '[]'
      },
      fixture => {
        fixture.walletOutput.customInstructions = '{}'
      },
      fixture => {
        fixture.walletOutput.customInstructions = JSON.stringify({
          derivationPrefix: ` ${prefix}`,
          derivationSuffix: suffix
        })
      }
    ]

    for (const mutate of invalidCases) {
      await expect(attempt(mutate)).resolves.toMatchObject({
        status: 'error',
        code: 'ERR_INVALID_DID_TOKEN'
      })
    }

    const sparseBeef = [0, 1, 2]
    delete sparseBeef[1]
    await expect(attempt(() => {}, { serialNumber }, sparseBeef)).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_INVALID_DID_TOKEN'
    })

    await expect(attempt(() => {}, { serialNumber }, [])).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_INVALID_DID_TOKEN'
    })

    await expect(
      attempt((_fixture, wallet) => {
        jest
          .spyOn(wallet, 'getPublicKey')
          .mockResolvedValue({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() })
      })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_INVALID_DID_TOKEN' })

    await expect(
      attempt(() => {}, { serialNumber, outpoint: `${'f'.repeat(64)}.0` })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_INVALID_DID_TOKEN' })

    await expect(attempt(() => {}, { serialNumber: Utils.toBase64([99]) })).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_INVALID_DID_TOKEN'
    })
  })

  it('validates identifier syntax and safely skips malformed wallet outpoints', async () => {
    const wallet = new DIDWalletHarness()
    const client = new DIDClient({ wallet: wallet as unknown as WalletInterface })
    await expect(
      client.revokeDID({ outpoint: `${'a'.repeat(64)}.4294967296` })
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_INVALID_IDENTIFIER' })
    await expect(client.revokeDID({ serialNumber: '*' })).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_INVALID_IDENTIFIER'
    })

    wallet.listResult = {
      totalOutputs: 2,
      outputs: [
        { outpoint: 'malformed', satoshis: 1 },
        { outpoint: `${'b'.repeat(64)}.0`, satoshis: 1 }
      ]
    }
    await expect(client.revokeDID({ outpoint: `${'c'.repeat(64)}.0` })).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_DID_NOT_FOUND'
    })
  })

  it('keeps a distinct-subject token revocable by its issuing wallet', async () => {
    const wallet = new DIDWalletHarness()
    const subject = PrivateKey.fromRandom().toPublicKey().toString()
    const fixture = await sourceFixture(wallet, subject)
    wallet.listResult = {
      totalOutputs: 1,
      outputs: [fixture.walletOutput],
      BEEF: fixture.source.toBEEF()
    }
    jest.spyOn(TopicBroadcaster.prototype, 'broadcast').mockImplementation(async tx => ({
      status: 'success',
      txid: tx.id('hex'),
      message: 'accepted'
    }))

    await expect(
      new DIDClient({ wallet: wallet as unknown as WalletInterface }).revokeDID({ serialNumber })
    ).resolves.toMatchObject({ status: 'success' })
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
  })

  it('binds lookup answers to the requested serial and exact BEEF subject', async () => {
    const wallet = new DIDWalletHarness()
    const fixture = await sourceFixture(wallet)
    const resolver = {
      query: jest.fn(async () => ({
        type: 'output-list',
        outputs: [
          {
            beef: fixture.source.toAtomicBEEF(true),
            outputIndex: 0,
            txid: fixture.source.id('hex')
          }
        ]
      }))
    }
    const client = new DIDClient({ wallet: wallet as unknown as WalletInterface })

    await expect(client.findDID({ serialNumber }, { resolver: resolver as any })).resolves.toEqual([
      expect.objectContaining({
        txid: fixture.source.id('hex'),
        outputIndex: 0,
        serialNumber
      })
    ])
    await expect(
      client.findDID({ serialNumber: Utils.toBase64([99]) }, { resolver: resolver as any })
    ).rejects.toThrow('different serial')
  })

  it('rejects malformed query objects and bounded filter violations before resolver access', async () => {
    const wallet = new DIDWalletHarness()
    const resolver = { query: jest.fn() }
    const client = new DIDClient({ wallet: wallet as unknown as WalletInterface })
    const inherited = Object.create({ limit: 1 }) as Record<string, unknown>
    const accessor = {}
    let invoked = 0
    Object.defineProperty(accessor, 'limit', {
      enumerable: true,
      get() {
        invoked += 1
        return 1
      }
    })

    const rejected: unknown[] = [null, [], inherited, accessor, { unexpected: true }]
    for (const query of rejected) {
      await expect(
        client.findDID(query as never, { resolver: resolver as never })
      ).rejects.toThrow()
    }
    expect(invoked).toBe(0)

    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { skip: -1 },
      { skip: 100_001 },
      { sortOrder: 'sideways' },
      { startDate: '2026-02-30' },
      { endDate: 'not-a-date' },
      { startDate: '2026-02-02', endDate: '2026-02-01' }
    ]) {
      await expect(
        client.findDID(query as never, { resolver: resolver as never })
      ).rejects.toThrow()
    }
    expect(resolver.query).not.toHaveBeenCalled()
  })

  it('rejects oversized, malformed, mismatched, and duplicate resolver outputs', async () => {
    const wallet = new DIDWalletHarness()
    const fixture = await sourceFixture(wallet)
    const client = new DIDClient({ wallet: wallet as unknown as WalletInterface })
    const validOutput = {
      beef: fixture.source.toAtomicBEEF(true),
      outputIndex: 0,
      txid: fixture.source.id('hex')
    }
    const find = async (outputs: unknown[], query: Record<string, unknown> = {}) =>
      await client.findDID(query as never, {
        resolver: {
          query: jest.fn(async () => ({ type: 'output-list', outputs }))
        } as never
      })

    await expect(find(Array.from({ length: 101 }, () => validOutput))).rejects.toThrow('too many')
    for (const malformed of [
      null,
      { ...validOutput, outputIndex: -1 },
      { ...validOutput, beef: [] }
    ]) {
      await expect(find([malformed])).rejects.toThrow()
    }
    await expect(find([{ ...validOutput, txid: '0'.repeat(64) }])).rejects.toThrow(
      'transaction ID hint'
    )
    await expect(find([{ ...validOutput, outputIndex: 1 }])).rejects.toThrow('out of range')
    await expect(
      find([validOutput], { outpoint: `${fixture.source.id('hex')}.1` })
    ).rejects.toThrow('different outpoint')
    await expect(find([validOutput, validOutput], { limit: 2 })).rejects.toThrow(
      'duplicate outpoint'
    )

    await expect(
      client.findDID(
        { outpoint: fixture.outpoint },
        {
          includeBeef: false,
          resolver: {
            query: jest.fn(async () => ({ type: 'output-list', outputs: [validOutput] }))
          } as never
        }
      )
    ).resolves.toEqual([{ txid: fixture.source.id('hex'), outputIndex: 0, serialNumber }])
  })
})
