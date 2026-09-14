import 'fake-indexeddb/auto'
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { PrivateKey, ProtoWallet, SimplifiedFetchTransport } from '@bsv/sdk'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { StorageServer } from '../remoting/StorageServer'
import { StorageClient } from '../remoting/StorageClient'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { syncTransferDigest } from '../remoting/SyncTransfer'

async function local(): Promise<StorageIdb> {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  s.dbName = `sync-large-${randomUUID()}`
  await s.migrate('synthetic large-record test', PrivateKey.fromRandom().toPublicKey().toString())
  await s.makeAvailable()
  return s
}

test('advertises a configured inline ceiling bounded by the HTTP response limit', async () => {
  const remote = await _tu.createSQLiteTestWallet({ databaseName: 'inlineCeiling', dropAll: true })
  try {
    for (const [configured, responseLimit, expected] of [[262144, 8388608, 262144], [262144, 65536, 32768]]) {
      const server = new StorageServer(remote.activeStorage, {
        port: 0, wallet: remote.wallet, monetize: false,
        syncTransferInlineBytes: configured, maxRpcResponseBytes: responseLimit
      })
      const capabilities = Reflect.get(server, 'syncTransfers').capabilities
      expect(capabilities.inlineBytes).toBe(expected)
      expect(capabilities.binaryTransport).toEqual({ version: 1, inlineBytes: expected })
    }
    const legacy = new StorageServer(remote.activeStorage, { port: 0, wallet: remote.wallet, monetize: false, syncBinaryTransport: false })
    const capabilities = Reflect.get(legacy, 'syncTransfers').capabilities
    expect(capabilities.version).toBe(1)
    expect(capabilities.binaryTransport).toBeUndefined()
  } finally {
    await remote.wallet.destroy()
  }
})

test.each([[0, 7 * 1024 * 1024, true], [1000, 7 * 1024 * 1024, true], [0, 3 * 1024 * 1024 + 1024, true], [0, 3 * 1024 * 1024 + 1024, false]] as const)('copies a record through authenticated HTTP with %i ms latency, %i bytes and raw transport %s', async (requestLatencyMs, recordBytes, binarySync) => {
  const rawRequests: Array<{ contentType: string; bytes: number }> = []
  const browserTransports = new WeakSet<SimplifiedFetchTransport>()
  const originalSend = SimplifiedFetchTransport.prototype.send
  const delayedTransport = jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (message) {
    if (!browserTransports.has(this)) {
      browserTransports.add(this)
      const originalFetch = this.fetchClient
      this.fetchClient = async (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('Origin', 'https://wallet.example.test')
        const response = await originalFetch(input, { ...init, headers })
        expect(response.headers.get('access-control-allow-origin')).toBe('*')
        const exposed = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase().split(/,\s*/)
        // Model browser header visibility while retaining real HTTP and authentication.
        const visible = new Headers()
        response.headers.forEach((value, name) => {
          if (['content-type', 'content-length', 'cache-control'].includes(name) || exposed.includes(name)) visible.set(name, value)
        })
        return new Response(response.body, { status: response.status, headers: visible })
      }
    }
    if (message.messageType === 'general') {
      const request = this.deserializeRequestPayload(message.payload)
      if (request.urlPostfix.endsWith('/sync/v1')) rawRequests.push({ contentType: request.headers['content-type'], bytes: request.body?.length ?? 0 })
    }
    if (requestLatencyMs > 0) await new Promise(resolve => setTimeout(resolve, requestLatencyMs))
    return await originalSend.call(this, message)
  })
  const remote = await _tu.createSQLiteTestWallet({ databaseName: 'largeRecordHttp', dropAll: true })
  const source = await local()
  const restored = await local()
  const pricedBinaryMethods: string[] = []
  const priceRequest = async (request: Request): Promise<number> => {
    if (request.path.endsWith('/sync/v1')) {
      expect(typeof request.body.method).toBe('string')
      expect(Array.isArray(request.body.params)).toBe(true)
      pricedBinaryMethods.push(request.body.method)
    }
    return 0
  }
  let server = new StorageServer(remote.activeStorage, {
    port: 0,
    wallet: remote.wallet,
    monetize: true,
    logRpcRequests: false,
    calculateRequestPrice: priceRequest
  })
  let client: StorageClient | undefined
  try {
    server.start()
    if (!server.server.listening) await once(server.server, 'listening')
    const address = server.server.address()
    if (address == null || typeof address === 'string') throw new Error('fixture did not bind')
    client = new StorageClient(remote.wallet, `http://localhost:${address.port}`, { binaryRequests: true, binarySync })
    const identityKey = remote.identityKey
    const manager = new WalletStorageManager(identityKey, source)
    await manager.makeAvailable()
    const { user } = await source.findOrInsertUser(identityKey)
    // The smaller fixture crossed the old inline ceiling only after base64 expansion.
    // Synthetic storage bytes, never funded, signed or broadcast.
    const bytes = new Uint8Array(recordBytes).fill(173)
    const now = new Date()
    await source.insertTransaction({
      transactionId: 0,
      userId: user.userId,
      created_at: now,
      updated_at: now,
      reference: 'large-synthetic',
      status: 'nosend',
      isOutgoing: true,
      satoshis: 0,
      description: 'synthetic oversized record',
      inputBEEF: Array.from(bytes),
      rawTx: [1, 2, 3]
    })
    const rpc = Reflect.get(client, 'rpcCall').bind(client)
    let lostAck = false
    const attemptedOffsets: number[] = []
    jest.spyOn(client as never, 'rpcCall' as never).mockImplementation((async (method: string, params: any[]) => {
      const result = await rpc(method, params)
      if (method === 'writeSyncTransferPart') {
        attemptedOffsets.push(params[0].offset)
        if (!lostAck) {
          lostAck = true
          throw new Error('network error 503 synthetic lost part acknowledgement')
        }
      }
      return result
    }) as never)
    client.onSyncTransferProgress = progress => {
      if (progress.direction === 'write' && progress.bytes >= 2 * 256 * 1024) throw new Error('synthetic disconnect')
    }
    await expect(manager.syncToWriter({ identityKey }, client)).rejects.toThrow('synthetic disconnect')
    expect(attemptedOffsets.slice(0, 2)).toEqual([0, 0])
    const before = await client.getSyncCheckpoint(
      { identityKey },
      source.getSettings().storageIdentityKey,
      source.getSettings().storageName
    )
    expect(before!.offsets.find(row => row.name === 'transaction')?.offset).toBe(0)
    expect(await remote.activeStorage.knex('sync_transfer_parts')).toHaveLength(2)

    const staged = await remote.activeStorage.knex('sync_transfers').whereNotNull('transferId').first()
    const strangerKey = PrivateKey.fromRandom()
    const stranger = new StorageClient(new ProtoWallet(strangerKey), `http://localhost:${address.port}`, {
      binaryRequests: true
    })
    try {
      const strangerRpc = Reflect.get(stranger, 'rpcCall').bind(stranger)
      for (const syncTransferVersion of [0, 1]) {
        await expect(
          strangerRpc('getSyncChunk', [
            {
              identityKey,
              fromStorageIdentityKey: remote.activeStorage.getSettings().storageIdentityKey,
              toStorageIdentityKey: source.getSettings().storageIdentityKey,
              maxItems: 1,
              maxRoughSize: 8 * 1024 * 1024,
              offsets: before!.offsets,
              syncTransferVersion
            }
          ])
        ).rejects.toThrow('does not match authentication')
      }
      await expect(
        strangerRpc('readSyncTransferPart', [{ identityKey, transferId: staged.transferId, offset: 0 }])
      ).rejects.toThrow('match authentication')
      await expect(
        strangerRpc('beginReadSyncTransfer', [
          {
            identityKey: strangerKey.toPublicKey().toString(),
            args: { identityKey, fromStorageIdentityKey: remote.activeStorage.getSettings().storageIdentityKey }
          }
        ])
      ).rejects.toThrow('source must match authenticated storage')
      await expect(
        strangerRpc('readSyncTransferPart', [
          { identityKey: strangerKey.toPublicKey().toString(), transferId: staged.transferId, offset: 0 }
        ])
      ).rejects.toThrow('expired')
    } finally {
      await stranger.destroy()
    }

    // Restart both HTTP server and client while preserving the database and the record checkpoint.
    await client.destroy()
    await server.close()
    server = new StorageServer(remote.activeStorage, {
      port: 0,
      wallet: remote.wallet,
      monetize: true,
      logRpcRequests: false,
      calculateRequestPrice: priceRequest
    })
    server.start()
    if (!server.server.listening) await once(server.server, 'listening')
    const nextAddress = server.server.address()
    if (nextAddress == null || typeof nextAddress === 'string') throw new Error('fixture did not rebind')
    client = new StorageClient(remote.wallet, `http://localhost:${nextAddress.port}`, { binaryRequests: true, binarySync })
    const resumedProgress: number[] = []
    client.onSyncTransferProgress = progress => {
      if (progress.direction === 'write') resumedProgress.push(progress.bytes)
    }
    // The record commits, but its response is lost. Never replay a blind wallet mutation.
    const resumedRpc = Reflect.get(client, 'rpcCall').bind(client)
    let committed = false
    const commitSpy = jest.spyOn(client as never, 'rpcCall' as never).mockImplementation((async (
      method: string,
      params: any[]
    ) => {
      const result = await resumedRpc(method, params)
      if (method === 'commitSyncTransfer') {
        committed = true
        throw new Error('network error 503 synthetic lost commit acknowledgement')
      }
      return result
    }) as never)
    await expect(manager.syncToWriter({ identityKey }, client)).rejects.toThrow('lost commit acknowledgement')
    expect(committed).toBe(true)
    expect(resumedProgress[0]).toBe(2 * 256 * 1024)
    expect(commitSpy.mock.calls.filter(call => call[0] === 'commitSyncTransfer')).toHaveLength(1)
    commitSpy.mockRestore()
    const recovered = await manager.syncToWriter({ identityKey }, client)
    expect(recovered.inserts).toBe(0)
    expect(recovered.updates).toBe(0)
    const restoreManager = new WalletStorageManager(identityKey, restored)
    await restoreManager.makeAvailable()
    const receiveRpc = Reflect.get(client, 'rpcCall').bind(client)
    const rejectedInlineRequests: Array<{ maxItems: number }> = []
    let explicitReads = 0
    let corrupt = true
    const receiveSpy = jest.spyOn(client as never, 'rpcCall' as never).mockImplementation((async (
      method: string,
      params: any[]
    ) => {
      // A proxy can reject inline responses even when the provider supports staged reads.
      if (method === 'getSyncChunk') {
        rejectedInlineRequests.push({ maxItems: params[0].maxItems })
        throw new Error('WalletStorageClient rpcCall: network error 413 proxy response limit')
      }
      if (method === 'beginReadSyncTransfer') explicitReads++
      const value = await receiveRpc(method, params)
      if (method === 'readSyncTransferPart' && corrupt) {
        corrupt = false
        value.bytes[0] ^= 1
      }
      return value
    }) as never)
    await expect(restoreManager.syncFromReader(identityKey, client)).rejects.toThrow('integrity')
    expect(await restored.countTransactions({ partial: {} })).toBe(0)
    expect(rejectedInlineRequests.at(-1)?.maxItems).toBe(1)
    expect(explicitReads).toBe(1)
    receiveSpy.mockRestore()
    await restoreManager.syncFromReader(identityKey, client)
    const { user: target } = await restored.findOrInsertUser(identityKey)
    const rows = await restored.findTransactions({ partial: { userId: target.userId, reference: 'large-synthetic' } })
    expect(rows).toHaveLength(1)
    expect(syncTransferDigest(Uint8Array.from(rows[0].inputBEEF!))).toBe(syncTransferDigest(bytes))
    const again = await restoreManager.syncFromReader(identityKey, client)
    expect(again.inserts).toBe(0)
    expect(again.updates).toBe(0)
    expect(delayedTransport.mock.calls.length).toBeGreaterThan(20)
    expect(await remote.activeStorage.knex('sync_transfer_parts')).toHaveLength(0)
    if (binarySync) {
      expect(pricedBinaryMethods).toEqual(expect.arrayContaining(['getSyncChunk', 'writeSyncTransferPart', 'commitSyncTransfer']))
      expect(rawRequests.length).toBeGreaterThan(20)
    } else {
      expect(pricedBinaryMethods).toEqual([])
      expect(rawRequests).toEqual([])
    }
    expect(rawRequests.every(request => request.contentType === 'application/octet-stream' && request.bytes <= 256 * 1024 + 4096)).toBe(true)
  } finally {
    await client?.destroy()
    await server.close()
    await remote.wallet.destroy()
    await source.destroy()
    await restored.destroy()
    await source.dropAllData()
    await restored.dropAllData()
    delayedTransport.mockRestore()
  }
}, 180000)
