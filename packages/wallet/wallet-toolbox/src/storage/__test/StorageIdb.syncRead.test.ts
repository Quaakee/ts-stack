import { randomUUID } from 'node:crypto'
import { deleteDB, openDB } from 'idb'
import 'fake-indexeddb/auto'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { getSyncChunk } from '../methods/getSyncChunk'
import { readSyncItemsIdb, syncIdbStores } from '../methods/readSyncItemsIdb'
import { upgradeAllStoresV1 } from '../idbHelpers'

const owner = '02' + '11'.repeat(32)
const peer = '03' + '22'.repeat(32)
const oldTime = new Date('2026-01-01')
const since = new Date('2026-01-02')
const txid = (id: number): string => id.toString(16).padStart(64, '0')
const makeStorage = (): StorageIdb => {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions('main'))
  storage.dbName = `sync-source-${randomUUID()}`
  return storage
}

async function seed(storage: StorageIdb): Promise<void> {
  await storage.migrate('Synthetic source paging', peer)
  const trx = storage.db!.transaction(['users', ...Object.values(syncIdbStores)], 'readwrite')
  await trx
    .objectStore('users')
    .put({ userId: 1, identityKey: owner, activeStorage: peer, created_at: oldTime, updated_at: oldTime })
  for (let id = 1; id <= 4; id++) {
    const userId = id === 2 ? 2 : 1
    const time = { created_at: oldTime, updated_at: id === 1 ? new Date('2026-01-03') : id === 3 ? since : oldTime }
    const actualTxid = txid(id === 4 ? 3 : id)
    await trx
      .objectStore('transactions')
      .put({
        ...time,
        transactionId: id,
        userId,
        provenTxId: id === 4 ? 3 : id,
        txid: actualTxid,
        reference: `ref-${id}`,
        status: 'completed',
        isOutgoing: true,
        satoshis: 0,
        description: '',
        rawTx: [1, 2, id]
      })
    await trx
      .objectStore('proven_txs')
      .put({
        ...time,
        provenTxId: id,
        txid: txid(id),
        height: id,
        index: 0,
        rawTx: [1, 2, id],
        merklePath: [3, 4, id],
        blockHash: 'ab'.repeat(32),
        merkleRoot: 'cd'.repeat(32)
      })
    await trx
      .objectStore('proven_tx_reqs')
      .put({
        ...time,
        provenTxReqId: id,
        txid: txid(id),
        status: 'completed',
        attempts: 0,
        notified: false,
        history: '{}',
        notify: '{}',
        rawTx: [5, 6, id],
        inputBEEF: [7, 8, id]
      })
    await trx
      .objectStore('output_baskets')
      .put({
        ...time,
        basketId: id,
        userId,
        name: `basket-${id}`,
        isDeleted: id === 3,
        numberOfDesiredUTXOs: 0,
        minimumDesiredUTXOValue: 0
      })
    await trx
      .objectStore('output_tags')
      .put({ ...time, outputTagId: id, userId, tag: `tag-${id}`, isDeleted: id === 3 })
    await trx
      .objectStore('tx_labels')
      .put({ ...time, txLabelId: id, userId, label: `label-${id}`, isDeleted: id === 3 })
    await trx
      .objectStore('outputs')
      .put({
        ...time,
        outputId: id,
        userId,
        transactionId: id,
        basketId: id,
        vout: id,
        txid: actualTxid,
        spendable: true,
        change: false,
        satoshis: 0,
        type: 'P2PKH',
        providedBy: 'you',
        purpose: '',
        outputDescription: '',
        lockingScript: [81]
      })
    await trx.objectStore('tx_labels_map').put({ ...time, txLabelId: id, transactionId: 1, isDeleted: id === 3 })
    await trx.objectStore('output_tags_map').put({ ...time, outputTagId: id, outputId: 1, isDeleted: id === 3 })
    await trx
      .objectStore('certificates')
      .put({
        ...time,
        certificateId: id,
        userId,
        type: `type-${id}`,
        serialNumber: `serial-${id}`,
        certifier: peer,
        subject: owner,
        revocationOutpoint: '00'.repeat(32) + '.0',
        signature: '00',
        isDeleted: id === 3
      })
    await trx
      .objectStore('certificate_fields')
      .put({ ...time, certificateId: id, userId, fieldName: 'a', fieldValue: 'value', masterKey: 'key' })
    await trx
      .objectStore('certificate_fields')
      .put({ ...time, certificateId: id, userId, fieldName: 'b', fieldValue: 'value', masterKey: 'key' })
    await trx
      .objectStore('commissions')
      .put({
        ...time,
        commissionId: id,
        userId,
        transactionId: id,
        satoshis: 0,
        keyOffset: 'offset',
        isRedeemed: false,
        lockingScript: [81]
      })
  }
  await trx.done
}

describe('IndexedDB source sync paging', () => {
  test.each(['instance', 'subclass'])('preserves %s reader customizations', async kind => {
    class CustomStorage extends StorageIdb {
      override async getProvenTxsForUser(): Promise<[]> {
        return []
      }
    }
    const storage =
      kind === 'subclass' ? new CustomStorage(StorageProvider.createStorageBaseOptions('main')) : makeStorage()
    storage.dbName = `custom-sync-source-${randomUUID()}`
    try {
      await seed(storage)
      if (kind === 'instance') storage.getProvenTxsForUser = async () => []
      const args = {
        identityKey: owner,
        fromStorageIdentityKey: peer,
        toStorageIdentityKey: owner,
        offsets: Object.keys(syncIdbStores).map(name => ({ name, offset: 0 })),
        maxItems: 1000,
        maxRoughSize: 10000000
      }
      const result = await storage.getSyncChunk(args)
      expect(result).toEqual(await getSyncChunk(storage, args))
      expect(result.provenTxs).toEqual([])
      expect(result.transactions?.length).toBeGreaterThan(0)
    } finally {
      await storage.destroy()
      await deleteDB(storage.dbName)
    }
  })

  test.each([undefined, since])('matches ordinary BRC-40 pages for all entities with since=%s', async watermark => {
    const storage = makeStorage()
    try {
      await seed(storage)
      for (const offset of [0, 1, 9])
        for (const maxItems of [1, 3, 1000]) {
          const args = {
            identityKey: owner,
            fromStorageIdentityKey: peer,
            toStorageIdentityKey: owner,
            since: watermark,
            offsets: Object.keys(syncIdbStores).map(name => ({ name, offset })),
            maxItems,
            maxRoughSize: 10000000
          }
          expect(await storage.getSyncChunk(args)).toEqual(await getSyncChunk(storage, args))
        }
      // Timestamp changes and a new owner reference are visible on the next read;
      // no in-memory key cache can stale or cross profile boundaries.
      await storage.updateProvenTx(4, { updated_at: since })
      await storage.updateTransaction(4, { provenTxId: 4, txid: txid(4) })
      expect(
        await readSyncItemsIdb(storage, 'provenTx', { userId: 1, since, paged: { offset: 0, limit: 10 } })
      ).toEqual(await storage.getProvenTxsForUser({ userId: 1, since, paged: { offset: 0, limit: 10 } }))
    } finally {
      await storage.destroy()
      await deleteDB(storage.dbName)
    }
  })

  test('reconstructs pruned raw transactions and output scripts as the ordinary reader does', async () => {
    const storage = makeStorage()
    try {
      await seed(storage)
      const trx = storage.db!.transaction(['transactions', 'outputs'], 'readwrite')
      const tx = await trx.objectStore('transactions').get(3)
      const output = await trx.objectStore('outputs').get(3)
      await trx.objectStore('transactions').put({ ...tx!, rawTx: undefined })
      await trx.objectStore('outputs').put({ ...output!, lockingScript: undefined, scriptOffset: 1, scriptLength: 1 })
      await trx.done
      const args = { userId: 1, paged: { offset: 0, limit: 10 } }
      const transactions = await readSyncItemsIdb(storage, 'transaction', args)
      expect(transactions).toEqual(await storage.findTransactions({ partial: { userId: 1 }, paged: args.paged }))
      expect(transactions.find(row => row.transactionId === 3).rawTx).toEqual([1, 2, 3])
      const outputs = await readSyncItemsIdb(storage, 'output', args)
      expect(outputs).toEqual(await storage.findOutputs({ partial: { userId: 1 }, paged: args.paged }))
      expect(outputs.find(row => row.outputId === 3).lockingScript).toEqual([2])
    } finally {
      await storage.destroy()
      await deleteDB(storage.dbName)
    }
  })

  test('late proof pages load only selected values, with duplicate and foreign-user references', async () => {
    const storage = makeStorage()
    await storage.migrate('Synthetic large key-only source', peer)
    try {
      const trx = storage.db!.transaction(['proven_txs', 'transactions'], 'readwrite')
      for (let id = 1; id <= 1000; id++) {
        const timestamps = { created_at: oldTime, updated_at: since }
        await trx
          .objectStore('proven_txs')
          .put({
            ...timestamps,
            provenTxId: id,
            txid: txid(id),
            height: id,
            index: 0,
            rawTx: Array.from({ length: 256 }, () => id % 256),
            merklePath: [1],
            blockHash: 'ab'.repeat(32),
            merkleRoot: 'cd'.repeat(32)
          })
        for (let duplicate = 0; duplicate < 2; duplicate++)
          await trx.objectStore('transactions').put({
            ...timestamps,
            transactionId: id * 2 + duplicate,
            provenTxId: id,
            txid: txid(id),
            userId: id % 3 === 0 ? 2 : 1,
            reference: `ref-${id}-${duplicate}`,
            status: 'completed',
            isOutgoing: true,
            satoshis: 0,
            description: '',
            rawTx: [1]
          })
      }
      await trx.done
      const args = { userId: 1, since, paged: { offset: 600, limit: 16 } }
      const expected = await storage.getProvenTxsForUser(args)
      const values = jest.spyOn(IDBObjectStore.prototype, 'get')
      const cursors = jest.spyOn(IDBObjectStore.prototype, 'openCursor')
      try {
        expect(await readSyncItemsIdb(storage, 'provenTx', args)).toEqual(expected)
        expect(values.mock.contexts.filter(store => store.name === 'proven_txs')).toHaveLength(16)
        expect(cursors.mock.contexts.filter(store => store.name === 'proven_txs')).toHaveLength(0)
      } finally {
        values.mockRestore()
        cursors.mockRestore()
      }
    } finally {
      await storage.destroy()
      await deleteDB(storage.dbName)
    }
  })

  test('version 6 upgrade backfills source indexes without changing existing bytes or duplicate txids', async () => {
    const storage = makeStorage()
    const db = await openDB(storage.dbName, 6, {
      upgrade(db) {
        upgradeAllStoresV1(db)
      }
    })
    const rows = [1, 2].map(id => ({
      transactionId: id,
      userId: 1,
      provenTxId: 10,
      txid: txid(10),
      reference: `legacy-${id}`,
      created_at: oldTime,
      updated_at: since,
      rawTx: new Uint8Array([1, 2, id])
    }))
    for (const row of rows) await db.put('transactions', row)
    db.close()
    try {
      expect(await storage.migrate('Synthetic v6 upgrade', peer)).toBe('7')
      expect(await storage.db!.getAll('transactions')).toEqual(rows)
      const check = storage.db!.transaction('transactions')
      expect(await check.store.index('provenTxId_userId').getAllKeys([10, 1])).toEqual([1, 2])
      expect(await check.store.index('updated_at').getAllKeys(IDBKeyRange.lowerBound(since))).toEqual([1, 2])
      await check.done
      await storage.destroy()
      await storage.makeAvailable()
      expect(await storage.db!.getAll('transactions')).toEqual(rows)
    } finally {
      await storage.destroy()
      await deleteDB(storage.dbName)
    }
  })
})
