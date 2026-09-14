import 'fake-indexeddb/auto'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import knex from 'knex'
import {
  StorageKnex,
  StorageServer,
  StorageClient,
  StorageIdb,
  StorageProvider,
  WalletStorageManager,
  type Wallet
} from '../src/index'
import { PrivateKey, ProtoWallet, SimplifiedFetchTransport } from '@bsv/sdk'

const hash = (bytes: number[] | Uint8Array): string => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex')
interface Metrics {
  requestBytes: number
  responseBytes: number
  maxRequestBytes: number
  requests: number
}
let metrics: Metrics | undefined

function measureTransport() {
  const originalSend = SimplifiedFetchTransport.prototype.send
  const wrapped = new WeakSet()
  return jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport,
    message
  ) {
    if (!wrapped.has(this)) {
      wrapped.add(this)
      const originalFetch = this.fetchClient
      this.fetchClient = async (url, init) => {
        const response = await originalFetch(url, init)
        if (metrics) {
          const requestBytes =
            typeof init?.body === 'string'
              ? Buffer.byteLength(init.body)
              : init?.body instanceof Uint8Array
                ? init.body.byteLength
                : 0
          metrics.requestBytes += requestBytes
          metrics.responseBytes += Number(response.headers.get('content-length') ?? 0)
          metrics.maxRequestBytes = Math.max(metrics.maxRequestBytes, requestBytes)
          metrics.requests++
        }
        return response
      }
    }
    return await originalSend.call(this, message)
  })
}
async function local(): Promise<StorageIdb> {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  s.dbName = 'isolated-wire-comparison-' + randomUUID()
  await s.migrate('synthetic transport comparison', PrivateKey.fromRandom().toPublicKey().toString())
  await s.makeAvailable()
  return s
}
async function trial(binarySync: boolean) {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  const remote = new StorageKnex({
    chain: 'test',
    knex: db,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 1 }
  })
  const key = PrivateKey.fromRandom(),
    wallet = new ProtoWallet(key),
    identityKey = key.toPublicKey().toString()
  let server: StorageServer | undefined
  let client: StorageClient | undefined
  let source: StorageIdb | undefined
  let restored: StorageIdb | undefined
  try {
    await remote.migrate('synthetic transport comparison', PrivateKey.fromRandom().toPublicKey().toString())
    await remote.makeAvailable()
    source = await local()
    restored = await local()
    server = new StorageServer(remote, {
      wallet: wallet as unknown as Wallet,
      host: '127.0.0.1',
      port: 0,
      monetize: false,
      logRpcRequests: false,
      syncTransferInlineBytes: 262144
    })
    server.start()
    if (!server.server.listening) await once(server.server, 'listening')
    const address = server.server.address()
    if (address == null || typeof address === 'string') throw new Error('Synthetic fixture did not bind')
    client = new StorageClient(wallet, 'http://127.0.0.1:' + address.port, { binaryRequests: true, binarySync })
    await client.makeAvailable()
    const manager = new WalletStorageManager(identityKey, source)
    await manager.makeAvailable()
    const { user } = await source.findOrInsertUser(identityKey)
    const bytes = new Uint8Array(3840 * 1024).fill(173),
      now = new Date()
    await source.insertTransaction({
      transactionId: 0,
      userId: user.userId,
      created_at: now,
      updated_at: now,
      reference: 'synthetic',
      status: 'nosend',
      isOutgoing: true,
      satoshis: 0,
      description: 'Synthetic only, never broadcast',
      inputBEEF: Array.from(bytes),
      rawTx: [1, 2, 3]
    })
    const reader = new WalletStorageManager(identityKey, restored)
    await reader.makeAvailable()
    const measured: Metrics = { requestBytes: 0, responseBytes: 0, maxRequestBytes: 0, requests: 0 }
    metrics = measured
    const started = performance.now()
    await manager.syncToWriter({ identityKey }, client)
    const uploadedMs = performance.now() - started
    await reader.syncFromReader(identityKey, client)
    const result = {
      binarySync,
      recordBytes: bytes.length,
      ...measured,
      uploadMs: uploadedMs,
      roundTripMs: performance.now() - started
    }
    metrics = undefined
    const target = (await restored.findOrInsertUser(identityKey)).user
    const rows = await restored.findTransactions({ partial: { userId: target.userId, reference: 'synthetic' } })
    assert.equal(rows.length, 1)
    assert.equal(hash(rows[0].inputBEEF!), hash(bytes))
    const again = await reader.syncFromReader(identityKey, client)
    assert.equal(again.inserts, 0)
    assert.equal(again.updates, 0)
    return { ...result, restoredDigestMatches: true, repeatInserts: 0, repeatUpdates: 0 }
  } finally {
    metrics = undefined
    await client?.destroy()
    await server?.close()
    await remote.destroy()
    await source?.destroy()
    await restored?.destroy()
    await source?.dropAllData()
    await restored?.dropAllData()
  }
}
test('compares raw and base64 HTTP bodies with identical bounded parts', async () => {
  const transport = measureTransport()
  try {
    const results = []
    for (const binary of [false, true, true, false, false, true]) results.push(await trial(binary))
    const bodies = (mode: boolean) =>
      results.filter(r => r.binarySync === mode).map(r => r.requestBytes + r.responseBytes)
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
    expect(results.every(result => result.requests > 0 && result.restoredDigestMatches)).toBe(true)
    expect(mean(bodies(true))).toBeLessThan(mean(bodies(false)) * 0.8)
    console.log(
      JSON.stringify({
        scope: 'six synthetic loopback trials; identical 256 KiB parts; wall times are machine-dependent',
        bodyReductionPercent: 100 * (1 - mean(bodies(true)) / mean(bodies(false))),
        results
      })
    )
  } finally {
    transport.mockRestore()
  }
}, 120000)
