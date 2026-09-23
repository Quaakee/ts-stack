import { Hash, LockingScript, PrivateKey, ProtoWallet, PushDrop, Transaction } from '@bsv/sdk'
import { OverlayUMPTokenInteractor, UMPToken, UMPTokenLookupError } from '../CWIStyleWalletManager'

function token(outpoint: `${string}.${number}`, presentationHash: number[]): UMPToken {
  const field = Array(32).fill(1) as number[]
  return {
    passwordSalt: field,
    passwordPresentationPrimary: field,
    passwordRecoveryPrimary: field,
    presentationRecoveryPrimary: field,
    passwordPrimaryPrivileged: field,
    presentationRecoveryPrivileged: field,
    presentationHash,
    recoveryHash: Array(32).fill(2) as number[],
    presentationKeyEncrypted: field,
    passwordKeyEncrypted: field,
    recoveryKeyEncrypted: field,
    currentOutpoint: outpoint
  }
}

function resolution() {
  return {
    answer: { type: 'output-list' as const, outputs: [] },
    progress: {
      type: 'output-list' as const,
      outputs: [],
      txIds: [],
      isFinal: true,
      hostCount: 2,
      completedHosts: 2,
      successfulHosts: 2,
      emptyHosts: 0,
      failedHosts: 0,
      rejectedHosts: 0,
      freeformHosts: 0
    }
  }
}

describe('WAB-administered UMP pin fallback', () => {
  const presentationKey = Array(32).fill(7) as number[]
  const presentationHash = Hash.sha256(presentationKey)
  const firstOutpoint = `${'a'.repeat(64)}.0` as const
  const secondOutpoint = `${'b'.repeat(64)}.1` as const

  function interactor() {
    const resolver = { queryDetailed: jest.fn(async () => resolution()) }
    const subject = new OverlayUMPTokenInteractor(resolver as any, {} as any)
    const first = token(firstOutpoint, presentationHash)
    const second = token(secondOutpoint, presentationHash)
    jest.spyOn(subject as any, 'parseLookupAnswers').mockReturnValue([first, second])
    return { subject, first, second }
  }

  it('uses the pin only after normal lineage resolution remains ambiguous', async () => {
    const { subject, second } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(undefined)

    await expect(subject.findByPresentationKeyHash(presentationHash, { pinnedOutpoint: secondOutpoint })).resolves.toBe(
      second
    )
  })

  it('keeps the normal lineage winner even when the WAB pin names another candidate', async () => {
    const { subject, first } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(first)

    await expect(subject.findByPresentationKeyHash(presentationHash, { pinnedOutpoint: secondOutpoint })).resolves.toBe(
      first
    )
  })

  it('does not accept a pin that is absent from the verified matching candidates', async () => {
    const { subject } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(undefined)

    await expect(
      subject.findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: `${'c'.repeat(64)}.0`
      })
    ).rejects.toMatchObject<Partial<UMPTokenLookupError>>({ reason: 'token-ambiguous' })
  })

  it('builds and broadcasts a finalized UMP token through the shared action path', async () => {
    const { subject, first } = interactor()
    const completed = new Transaction(
      1,
      [],
      [
        { satoshis: 2, lockingScript: LockingScript.fromHex('00') },
        { satoshis: 1, lockingScript: LockingScript.fromHex('51') }
      ],
      0
    )
    const finalizedOutpoint = `${completed.id('hex')}.1`
    const broadcast = jest.fn(async () => ({
      status: 'success' as const,
      txid: completed.id('hex'),
      message: 'published'
    }))
    Object.assign(subject as any, { broadcaster: { broadcast } })
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue({ toHex: () => '51' } as any)
    const fields = jest.spyOn(subject as any, 'tokenFields').mockReturnValue([])
    const oldInput = jest.spyOn(subject as any, 'resolveOldInput').mockResolvedValue({
      resolvedOldToken: undefined,
      inputToken: undefined
    })
    const complete = jest.spyOn(subject as any, 'completeUMPAction').mockResolvedValue(completed)

    await expect(subject.buildAndSend({} as any, 'admin.example', first)).resolves.toBe(finalizedOutpoint)
    expect(fields).toHaveBeenCalledWith(first)
    expect(oldInput).toHaveBeenCalledWith(undefined)
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inputs: [],
        outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'New UMP token output' }]
      }),
      expect.anything(),
      'admin.example'
    )
    expect(broadcast).toHaveBeenCalledWith(completed)
    lock.mockRestore()
  })

  it('refuses ambiguous token outputs and mismatched broadcast identities', async () => {
    const { subject } = interactor()
    const duplicate = new Transaction(
      1,
      [],
      [
        { satoshis: 1, lockingScript: LockingScript.fromHex('51') },
        { satoshis: 1, lockingScript: LockingScript.fromHex('51') }
      ],
      0
    )
    const broadcast = jest.fn()
    Object.assign(subject as any, { broadcaster: { broadcast } })
    await expect((subject as any).broadcastUMPTransaction(duplicate, '51', 'create')).rejects.toThrow(
      'exactly one requested token output'
    )
    expect(broadcast).not.toHaveBeenCalled()

    const unique = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }], 0)
    broadcast.mockResolvedValue({ status: 'success', txid: 'f'.repeat(64), message: 'substituted' })
    await expect((subject as any).broadcastUMPTransaction(unique, '51', 'create')).rejects.toThrow(
      'transaction ID mismatch'
    )
  })

  it('will not sign renewal of a canonical token owned by another wallet', async () => {
    const { subject } = interactor()
    const attackerWallet = new ProtoWallet(PrivateKey.fromRandom())
    const localWallet = new ProtoWallet(PrivateKey.fromRandom())
    const forgedToken = token(`${'0'.repeat(64)}.0`, presentationHash)
    const fields = (subject as any).tokenFields(forgedToken)
    const lockingScript = await new PushDrop(attackerWallet).lock(
      fields,
      [2, 'admin user management token'],
      '1',
      'self',
      true,
      true
    )
    const source = new Transaction(1, [], [{ satoshis: 1, lockingScript }], 0)
    forgedToken.currentOutpoint = `${source.id('hex')}.0`

    await expect(
      (subject as any).assertOwnedUMPInput(localWallet, 'admin.example', forgedToken, {
        beef: source.toBEEF(),
        outputIndex: 0
      })
    ).rejects.toThrow('not controlled by this wallet')
  })
})
