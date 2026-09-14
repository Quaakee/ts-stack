import type { WalletInterface } from '@bsv/sdk'
import { StorageClient } from '../StorageClient'
import { StorageClient as MobileClient } from '../StorageMobile'
import {
  decodeSyncTransfer,
  encodeSyncTransfer,
  syncTransferLength,
  SYNC_BINARY_ENCODING,
  SYNC_BINARY_HEADER
} from '../SyncTransfer'

const capabilities = {
  version: 1,
  maxBytes: 64 * 1024 * 1024,
  partBytes: 256 * 1024,
  inlineBytes: 4 * 1024 * 1024,
  binaryTransport: { version: 1, inlineBytes: 256 * 1024 }
}

function reply(
  id: number,
  result: unknown,
  headers: Record<string, string> = { [SYNC_BINARY_HEADER]: SYNC_BINARY_ENCODING }
) {
  return new Response(encodeSyncTransfer({ jsonrpc: '2.0', id, result }), { headers })
}

describe.each([
  ['full', StorageClient],
  ['mobile', MobileClient]
] as const)('%s binary sync exchange', (_name, Client) => {
  test('sends raw part bytes and reads the authenticated encoding marker', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test/rpc/')
    Reflect.set(client, 'settings', { syncTransfer: capabilities })
    const bytes = new Uint8Array(64 * 1024).fill(173)
    const fetch = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://storage.example.test/rpc/sync/v1')
      expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream' })
      expect(init.body).toBeInstanceOf(Uint8Array)
      const body = init.body as Uint8Array
      expect(body.length).toBeLessThan(bytes.length + 1024)
      const request = decodeSyncTransfer(body) as any
      expect(request.params[0].bytes).toEqual(bytes)
      // AuthFetch reconstructs signed headers; Content-Type is not required here.
      return reply(request.id, bytes.length)
    })
    Reflect.set(client, 'authClient', { fetch })
    await expect(
      Reflect.get(client, 'rpcCall').call(client, 'writeSyncTransferPart', [
        {
          identityKey: 'synthetic',
          transferId: 'a'.repeat(64),
          offset: 0,
          bytes
        }
      ])
    ).resolves.toBe(bytes.length)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test.each(['old provider', 'client opt-out', 'future provider', 'ordinary RPC'])(
    'retains JSON for %s',
    async mode => {
      const client = new Client({} as WalletInterface, 'https://storage.example.test', {
        binarySync: mode !== 'client opt-out'
      })
      const syncTransfer = {
        ...capabilities,
        binaryTransport:
          mode === 'old provider'
            ? undefined
            : { ...capabilities.binaryTransport, version: mode === 'future provider' ? 2 : 1 }
      }
      Reflect.set(client, 'settings', { syncTransfer })
      const fetch = jest.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://storage.example.test')
        expect(typeof init.body).toBe('string')
        const request = JSON.parse(init.body as string)
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }))
      })
      Reflect.set(client, 'authClient', { fetch })
      await expect(
        Reflect.get(client, 'rpcCall').call(client, mode === 'ordinary RPC' ? 'getSettings' : 'getSyncChunk', [{}])
      ).resolves.toEqual({ ok: true })
    }
  )

  test.each(['missing marker', 'wrong id', 'timeout'])('does not replay a write after %s', async fault => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    Reflect.set(client, 'settings', { syncTransfer: capabilities })
    const fetch = jest.fn(async (_url: string, init: RequestInit) => {
      if (fault === 'timeout') throw new Error('Timed out waiting for authenticated response.')
      const request = decodeSyncTransfer(init.body as Uint8Array) as any
      return reply(
        fault === 'wrong id' ? request.id + 1 : request.id,
        1024,
        fault === 'missing marker' ? {} : undefined
      )
    })
    Reflect.set(client, 'authClient', { fetch })
    await expect(Reflect.get(client, 'rpcCall').call(client, 'commitSyncTransfer', [{}])).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

test('frame sizing matches encoded UTF-8 metadata and raw binary fields', () => {
  const value = { label: 'backup 🔑', arrays: [[1, 2]], bytes: new Uint8Array(8192).fill(173) }
  const encoded = encodeSyncTransfer(value)
  expect(syncTransferLength(value)).toBe(encoded.length)
  expect(encoded.length).toBeLessThan(value.bytes.length + 512)
  expect(decodeSyncTransfer(encoded)).toEqual(value)
})
