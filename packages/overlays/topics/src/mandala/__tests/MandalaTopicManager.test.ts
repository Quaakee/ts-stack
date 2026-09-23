import { MandalaTopicManager } from '../MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload, MandalaLinkagePayload } from '../types.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import { MandalaToken, MandalaAdmin, ADMIN_PROTOCOL, MandalaActionDetails } from '@bsv/templates'
import {
  ProtoWallet,
  PrivateKey,
  Hash,
  Utils,
  WalletProtocol,
  Transaction,
  P2PKH,
  UnlockingScript
} from '@bsv/sdk'

const tokenProtocolID: WalletProtocol = [2, 'mandala token']
const keyID = 'tkn'
const assetId = `${'a'.repeat(64)}.0`

// A funded transaction whose single input spends a throwaway source tx; token,
// admin, and change outputs are appended per-test with explicit satoshi values.
const fundedTx = (): { tx: Transaction; priorOutpoint: string } => {
  const source = new Transaction()
  source.addOutput({
    satoshis: 1000,
    lockingScript: new P2PKH().lock(Hash.hash160(Utils.toArray('00', 'hex')))
  })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript()
  })
  return { tx, priorOutpoint: `${source.id('hex')}.0` }
}

describe('MandalaTopicManager 1-satoshi rule', () => {
  const sender = new ProtoWallet(PrivateKey.fromRandom())
  const receiver = new ProtoWallet(PrivateKey.fromRandom())
  const overlay = new ProtoWallet(PrivateKey.fromRandom())
  const issuer = new ProtoWallet(PrivateKey.fromRandom())
  const stateStore = {
    getAssetState: async (id: string) => defaultAssetState(id),
    getTokenRow: async () => null,
    // The funded input is this asset's recorded admin-auth output, so the
    // issue below is a legitimately chained action.
    isAdminOutpoint: async () => true
  }

  const manager = new MandalaTopicManager({
    verifierWallet: overlay as any,
    screeningProvider: new InMemoryScreeningProvider([]),
    adminWallet: issuer as any,
    adminProtocolID: ADMIN_PROTOCOL,
    stateStore
  })

  const ftLockAndLinkage = async (
    amount: number
  ): Promise<{ lockingScript: any; linkage: any }> => {
    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({
      protocolID: tokenProtocolID,
      keyID,
      counterparty: receiverKey
    })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    const lockingScript = new MandalaToken().lock(assetId, amount, pkh)
    const linkage = await sender.revealSpecificKeyLinkage({
      counterparty: receiverKey,
      verifier: verifierKey,
      protocolID: tokenProtocolID,
      keyID
    })
    return { lockingScript, linkage }
  }

  it('admits a 1-sat token + 1-sat admin issue, ignoring a non-1-sat change output', async () => {
    const { tx, priorOutpoint } = fundedTx()
    const { lockingScript, linkage } = await ftLockAndLinkage(100)
    const details: MandalaActionDetails = { kind: 'issue', assetId, amount: 100, priorOutpoint }
    const adminScript = await MandalaAdmin.lock({ wallet: issuer as any, data: details })
    tx.addOutput({ satoshis: 1, lockingScript })
    tx.addOutput({ satoshis: 1, lockingScript: adminScript })
    // Ordinary wallet change is a bare P2PKH — decodes as MandalaAdmin but is
    // never admitted; the 1-sat rule must NOT apply to it.
    tx.addOutput({
      satoshis: 997,
      lockingScript: new P2PKH().lock(Hash.hash160(Utils.toArray('01', 'hex')))
    })

    const payload: MandalaLinkagePayload = {
      inputs: [],
      outputs: [{ index: 0, linkage: linkage as any }],
      admin: [{ index: 1, actionDetails: details }]
    }
    // previousCoins names input 0: the admin-auth coin this action spends.
    const result = await manager.identifyAdmissibleOutputs(
      tx.toBEEF(),
      [0],
      encodeLinkagePayload(payload)
    )
    expect(result.outputsToAdmit).toEqual([0, 1])
  })

  it('rejects a token output carrying more than 1 satoshi', async () => {
    const { tx } = fundedTx()
    const { lockingScript, linkage } = await ftLockAndLinkage(100)
    tx.addOutput({ satoshis: 2, lockingScript })
    const payload: MandalaLinkagePayload = {
      inputs: [],
      outputs: [{ index: 0, linkage: linkage as any }]
    }
    await expect(
      manager.identifyAdmissibleOutputs(tx.toBEEF(), [], encodeLinkagePayload(payload))
    ).rejects.toThrow('token output 0 must carry exactly 1 satoshi')
  })

  it('rejects a verified admin output carrying more than 1 satoshi', async () => {
    const { tx, priorOutpoint } = fundedTx()
    const details: MandalaActionDetails = { kind: 'register', priorOutpoint }
    const adminScript = await MandalaAdmin.lock({ wallet: issuer as any, data: details })
    tx.addOutput({ satoshis: 2, lockingScript: adminScript })
    const payload: MandalaLinkagePayload = {
      inputs: [],
      outputs: [],
      admin: [{ index: 0, actionDetails: details }]
    }
    await expect(
      manager.identifyAdmissibleOutputs(tx.toBEEF(), [], encodeLinkagePayload(payload))
    ).rejects.toThrow('admin output 0 must carry exactly 1 satoshi')
  })

  it('rejects non-exact administrative issuance amounts', async () => {
    const { tx, priorOutpoint } = fundedTx()
    const details: MandalaActionDetails = {
      kind: 'issue',
      assetId,
      amount: Number.MAX_SAFE_INTEGER + 1,
      priorOutpoint
    }
    tx.addOutput({
      satoshis: 1,
      lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details })
    })
    await expect(
      manager.identifyAdmissibleOutputs(
        tx.toBEEF(),
        [0],
        encodeLinkagePayload({
          inputs: [],
          outputs: [],
          admin: [{ index: 0, actionDetails: details }]
        })
      )
    ).rejects.toThrow('positive safe integer')
  })

  it('screens the administrative identity on issuance', async () => {
    const { publicKey: issuerIdentity } = await issuer.getPublicKey({ identityKey: true })
    const screenedManager = new MandalaTopicManager({
      verifierWallet: overlay as any,
      screeningProvider: new InMemoryScreeningProvider([issuerIdentity]),
      adminWallet: issuer as any,
      adminProtocolID: ADMIN_PROTOCOL,
      stateStore
    })
    const { tx, priorOutpoint } = fundedTx()
    const { lockingScript, linkage } = await ftLockAndLinkage(100)
    const details: MandalaActionDetails = { kind: 'issue', assetId, amount: 100, priorOutpoint }
    tx.addOutput({ satoshis: 1, lockingScript })
    tx.addOutput({
      satoshis: 1,
      lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details })
    })

    await expect(
      screenedManager.identifyAdmissibleOutputs(
        tx.toBEEF(),
        [0],
        encodeLinkagePayload({
          inputs: [],
          outputs: [{ index: 0, linkage: linkage as any }],
          admin: [{ index: 1, actionDetails: details }]
        })
      )
    ).rejects.toThrow('sanctioned')
  })

  it('rejects aggregate token totals outside the exact-integer range', () => {
    expect(() =>
      (manager as any).conservationHolds(
        [
          { index: 0, assetId, amount: Number.MAX_SAFE_INTEGER, identityKey: '02' },
          { index: 1, assetId, amount: 1, identityKey: '03' }
        ],
        [],
        new Transaction(),
        new Map()
      )
    ).toThrow('exact-integer range')
  })

  it('compares administrative identities and outpoints case-insensitively', async () => {
    const blocked = defaultAssetState(assetId)
    blocked.blockedIdentities = ['02AB']
    expect((manager as any).accessModeRejects(blocked, ['02ab'])).toBe(true)

    const allowlisted = defaultAssetState(assetId)
    allowlisted.accessMode = 'allowlist'
    allowlisted.allowedIdentities = ['03CD']
    expect((manager as any).accessModeRejects(allowlisted, ['03cd'])).toBe(false)

    const frozen = defaultAssetState(assetId)
    frozen.frozenOutpoints = [{ outpoint: 'ABCD.0', amount: 10, owner: '02ef' }]
    expect(
      (manager as any).reissueGuardFails(frozen, new Transaction(), assetId, {
        kind: 'reissue',
        assetId,
        outpoint: 'abcd.0',
        amount: 10,
        recipient: '02ef'
      })
    ).toBe(false)
  })

  it('does not treat an unaccompanied token burn as conserved', () => {
    const source = new Transaction()
    source.addOutput({
      satoshis: 1,
      lockingScript: new MandalaToken().lock(assetId, 10, Array(20).fill(1))
    })
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript()
    })
    expect((manager as any).conservationHolds([], [0], tx, new Map())).toBe(false)
  })
})
