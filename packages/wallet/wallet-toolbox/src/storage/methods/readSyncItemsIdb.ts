import type { StorageIdb } from '../StorageIdb'
import type { FindForUserSincePagedArgs } from '../../sdk/WalletStorage.interfaces'

/** BRC-40 order remains the object store's primary-key order, including map keys. */
export const syncIdbStores: Record<string, string> = {
  provenTx: 'proven_txs',
  outputBasket: 'output_baskets',
  outputTag: 'output_tags',
  txLabel: 'tx_labels',
  transaction: 'transactions',
  output: 'outputs',
  txLabelMap: 'tx_labels_map',
  outputTagMap: 'output_tags_map',
  certificate: 'certificates',
  certificateField: 'certificate_fields',
  commission: 'commissions',
  provenTxReq: 'proven_tx_reqs'
}

interface OwnershipSelection {
  keys: IDBValidKey[]
  owned: IDBValidKey[]
  scanned: number
  inUse: boolean
}

// Reuse key joins only inside the same readonly snapshot. Readwrite transactions
// must always observe their own later mutations; no cache survives a sync page.
const selections = new WeakMap<object, Map<string, OwnershipSelection>>()

/**
 * Select identity/timestamp keys before loading binary-bearing rows. All joins,
 * filtering and page reads share a transaction; no cached offset survives writes.
 * Key metadata can scale with the wallet, but only the requested page's values
 * are materialized. Ownership lookups have at most 128 outstanding requests.
 */
export async function readSyncItemsIdb(
  storage: StorageIdb,
  name: string,
  args: FindForUserSincePagedArgs
): Promise<any[]> {
  const storeName = syncIdbStores[name]
  if (storeName == null) throw new Error('Unknown IndexedDB sync entity')
  const relationStore =
    name === 'txLabelMap'
      ? 'tx_labels'
      : name === 'outputTagMap'
        ? 'output_tags'
        : name === 'provenTx' || name === 'provenTxReq'
          ? 'transactions'
          : undefined
  const trx = storage.toDbTrx(
    [...new Set([storeName, ...(relationStore == null ? [] : [relationStore])])],
    'readonly',
    args.trx
  )
  // Store names are the existing SQL-compatible runtime names used by StorageIdb.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any = trx.objectStore(storeName)
  const offset = Math.max(0, Math.ceil(args.paged?.offset ?? 0))
  const limit = (args.paged?.limit ?? 0) > 0 ? Math.ceil(args.paged!.limit) : Number.POSITIVE_INFINITY
  let keys: IDBValidKey[]
  if (relationStore == null) {
    keys = await store.index('userId').getAllKeys(args.userId)
    if (args.since != null) {
      const changed = new Set<string>(
        (await store.index('updated_at').getAllKeys(IDBKeyRange.lowerBound(args.since))).map((key: IDBValidKey) =>
          JSON.stringify(key)
        )
      )
      keys = keys.filter(key => changed.has(JSON.stringify(key)))
    }
    keys = keys.slice(offset, offset + limit)
  } else {
    const cacheKey = JSON.stringify([name, args.userId, args.since])
    let cache = trx.mode === 'readonly' ? selections.get(trx) : undefined
    if (trx.mode === 'readonly' && cache == null) {
      cache = new Map()
      selections.set(trx, cache)
    }
    const cached = cache?.get(cacheKey)
    // Concurrent callers on one transaction must not append to the same prefix.
    const prior = cached?.inUse === true ? undefined : cached
    keys = prior?.keys ?? (
      args.since == null
        ? await store.getAllKeys()
        : await store.index('updated_at').getAllKeys(IDBKeyRange.lowerBound(args.since)))
    // Ownership can only remove keys. An exhausted upper bound needs no joins,
    // including when earlier entities are revisited on every later sync page.
    if (offset >= keys.length) {
      if (args.trx == null) await trx.done
      return []
    }
    // Timestamp index traversal is not BRC-40 primary-key order.
    if (prior == null && args.since != null) keys.sort((a, b) => indexedDB.cmp(a, b))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const related: any = trx.objectStore(relationStore)
    if (name === 'txLabelMap' || name === 'outputTagMap') {
      const owned = new Set(await related.index('userId').getAllKeys(args.userId))
      keys = keys.filter(key => owned.has((key as IDBValidKey[])[0])).slice(offset, offset + limit)
    } else {
      const selection = prior ?? { keys, owned: [], scanned: 0, inUse: false }
      selection.inUse = true
      cache?.set(cacheKey, selection)
      for (let start = selection.scanned; start < keys.length && selection.owned.length < offset + limit; start += 128) {
        const batch = keys.slice(start, start + 128)
        const owned = await Promise.all(
          batch.map(async key => {
            if (name === 'provenTx') {
              return (await related.index('provenTxId_userId').getKey([key, args.userId])) !== undefined
            }
            // A covering key cursor supplies the request txid without cloning its
            // raw transaction/BEEF merely to decide ownership or skip an offset.
            const cursor = await store.index('provenTxReqId_txid').openKeyCursor(IDBKeyRange.bound([key], [key, []]))
            return (
              cursor != null && (await related.index('txid_userId').getKey([cursor.key[1], args.userId])) !== undefined
            )
          })
        )
        for (let i = 0; i < batch.length; i++) if (owned[i]) selection.owned.push(batch[i])
        selection.scanned = start + batch.length
      }
      selection.inUse = false
      keys = selection.owned.slice(offset, offset + limit)
    }
  }
  const rows = await Promise.all(keys.map(async key => storage.validateEntity(await store.get(key))))
  if (args.trx == null) await trx.done
  // Reconstruct pruned fields inside the caller's snapshot when supplied.
  // Standalone reads retain the ordinary reader's post-transaction hydration.
  if (name === 'transaction') for (const row of rows) await storage.validateRawTransaction(row, args.trx)
  if (name === 'output') for (const row of rows) await storage.validateOutputScript(row, args.trx)
  return rows
}
