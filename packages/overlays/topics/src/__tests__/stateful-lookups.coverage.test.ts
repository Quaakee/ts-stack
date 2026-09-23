import { jest } from '@jest/globals'
import { LockingScript, Transaction } from '@bsv/sdk'
import type { Db } from 'mongodb'
import { KVStoreLookupService } from '../kvstore/KVStoreLookupService.js'
import {
  createMandalaLookupService,
  MandalaLookupService
} from '../mandala/MandalaLookupService.js'

const txid = 'ab'.repeat(32)
const assetId = `${'cd'.repeat(32)}.1`

function mandalaStorage(methods: Record<string, jest.Mock> = {}): Record<string, jest.Mock> {
  return {
    findAdminHistoryByAssetId: jest.fn(async () => []),
    getTokenRow: jest.fn(async () => null),
    putAssetState: jest.fn(),
    takeToken: jest.fn(async () => null),
    adjustBalance: jest.fn(),
    deleteMetadata: jest.fn(),
    findByOutpoint: jest.fn(async () => [{ txid, outputIndex: 2 }]),
    ...methods
  }
}

describe('stateful lookup coverage', () => {
  it('rebuilds frozen Mandala state from authoritative token ownership', async () => {
    const storage = mandalaStorage({
      findAdminHistoryByAssetId: jest.fn(async () => [
        { actionDetails: { kind: 'freezeOutput', outpoint: `${txid}.2` } }
      ]),
      getTokenRow: jest.fn(async () => ({ amount: 7, identityKey: 'OwnerKey' }))
    })
    const service = new MandalaLookupService({
      storage: storage as never,
      verifierWallet: {} as never
    })

    await expect(service.rebuildState(assetId)).resolves.toMatchObject({
      assetId,
      frozenOutpoints: [{ outpoint: `${txid}.2`, amount: 7, owner: 'ownerkey' }]
    })
    expect(storage.getTokenRow).toHaveBeenCalledWith(txid, 2)
    expect(storage.putAssetState).toHaveBeenCalledTimes(1)
  })

  it('uses empty freeze metadata when the referenced Mandala token is absent', async () => {
    const storage = mandalaStorage({
      findAdminHistoryByAssetId: jest.fn(async () => [
        { actionDetails: { kind: 'freezeOutput', outpoint: `${txid}.2` } }
      ])
    })
    const service = new MandalaLookupService({
      storage: storage as never,
      verifierWallet: {} as never
    })

    await expect(service.rebuildState(assetId)).resolves.toMatchObject({
      frozenOutpoints: [{ outpoint: `${txid}.2`, amount: 0, owner: '' }]
    })
  })

  it('debits an evicted Mandala token exactly once and always removes metadata', async () => {
    const storage = mandalaStorage({
      takeToken: jest
        .fn()
        .mockResolvedValueOnce({ identityKey: 'owner', amount: 7 })
        .mockResolvedValueOnce({ identityKey: '', amount: 8 })
        .mockResolvedValueOnce(null)
    })
    const service = new MandalaLookupService({
      storage: storage as never,
      verifierWallet: {} as never
    })

    await service.outputEvicted(txid, 0)
    await service.outputEvicted(txid, 1)
    await service.outputEvicted(txid, 2)

    expect(storage.adjustBalance).toHaveBeenCalledTimes(1)
    expect(storage.adjustBalance).toHaveBeenCalledWith('owner', -7)
    expect(storage.deleteMetadata).toHaveBeenCalledTimes(3)
  })

  it('routes a canonical Mandala outpoint and exercises both factory storage paths', async () => {
    const storage = mandalaStorage()
    const service = new MandalaLookupService({
      storage: storage as never,
      verifierWallet: {} as never
    })

    await expect(
      service.lookup({ service: 'ls_mandala', query: { txid, outputIndex: 2 } })
    ).resolves.toEqual([{ txid, outputIndex: 2 }])
    expect(storage.findByOutpoint).toHaveBeenCalledWith(txid, 2)

    const db = { collection: jest.fn(() => ({})) } as unknown as Db
    expect(createMandalaLookupService({} as never, storage as never)(db)).toBeInstanceOf(
      MandalaLookupService
    )
    expect(createMandalaLookupService({} as never)(db)).toBeInstanceOf(MandalaLookupService)
  })

  it('rejects an invalid KVStore tag mode before storage access', async () => {
    const findWithFilters = jest.fn()
    const service = new KVStoreLookupService({ findWithFilters } as never)

    await expect(
      service.lookup({ service: 'ls_kvstore', query: { key: 'name', tagQueryMode: 'none' } })
    ).rejects.toThrow('tagQueryMode must be all or any')
    expect(findWithFilters).not.toHaveBeenCalled()
  })

  it('exposes a fail-closed KVStore history selector only when requested', async () => {
    const findWithFilters = jest.fn(async () => [
      {
        txid,
        outputIndex: 0,
        key: 'name',
        protocolID: JSON.stringify([1, 'kvstore protocol'])
      }
    ])
    const service = new KVStoreLookupService({ findWithFilters } as never)

    const [result] = (await service.lookup({
      service: 'ls_kvstore',
      query: { key: 'name', history: true }
    })) as Array<{
      history?: (beef: number[], outputIndex: number, depth: number) => Promise<boolean>
    }>
    expect(result.history).toEqual(expect.any(Function))
    await expect(result.history?.([0, 1], 0, 0)).resolves.toBe(false)

    const transaction = new Transaction()
    transaction.addOutput({ satoshis: 1, lockingScript: new LockingScript([]) })
    await expect(result.history?.(transaction.toBEEF(), 1, 0)).resolves.toBe(false)
    await expect(result.history?.(transaction.toBEEF(), 0, 0)).resolves.toBe(false)
  })
})
