import {
  fetchBoundedJson,
  normalizeRelayUrl,
  parseRpcMessage,
  parseWireEnvelope,
  validateSessionInfo
} from '../src/shared/validation.js'
import { base64urlToBytes } from '../src/shared/encoding.js'

const SESSION_ID = 'A'.repeat(43)
const RPC_ID = '00000000-0000-4000-8000-000000000001'

describe('wallet relay untrusted-data boundaries', () => {
  it('accepts only canonical unpadded base64url', () => {
    expect(base64urlToBytes('AQID')).toEqual([1, 2, 3])
    for (const encoded of ['', 'A', 'AQI=', 'AQI+', 'AQI/', 'AB']) {
      expect(() => base64urlToBytes(encoded)).toThrow(/canonical base64url/)
    }
  })

  it('requires exact RPC request and response framing', () => {
    expect(parseRpcMessage({ id: RPC_ID, seq: 1, result: { ok: true } })).toEqual({
      id: RPC_ID,
      seq: 1,
      result: { ok: true }
    })
    expect(() =>
      parseRpcMessage({ id: RPC_ID, seq: 1, result: {}, error: { code: 1, message: 'x' } })
    ).toThrow(/exactly one/)
    expect(() => parseRpcMessage({ id: RPC_ID, seq: 1, result: {}, method: 'confused' })).toThrow()
    expect(() => parseRpcMessage({ id: 'predictable', seq: 1, result: {} })).toThrow(/RPC ID/)
    expect(() => parseRpcMessage({ id: RPC_ID, seq: 0, result: {} })).toThrow(/positive/)
    expect(() => parseRpcMessage({ id: RPC_ID, seq: 1, result: {}, extra: true })).toThrow(
      /exact protocol object/
    )
  })

  it('binds a wire envelope to its connected topic and rejects surplus fields', () => {
    expect(parseWireEnvelope({ topic: SESSION_ID, ciphertext: 'AQID' }, SESSION_ID)).toEqual({
      topic: SESSION_ID,
      ciphertext: 'AQID'
    })
    expect(() =>
      parseWireEnvelope({ topic: 'B'.repeat(43), ciphertext: 'AQID' }, SESSION_ID)
    ).toThrow(/connected session topic/)
    expect(() =>
      parseWireEnvelope({ topic: SESSION_ID, ciphertext: 'AQID', plaintext: 'steal' }, SESSION_ID)
    ).toThrow(/exact protocol object/)
  })

  it('requires service session responses to carry canonical bearer identifiers', () => {
    expect(validateSessionInfo({ sessionId: SESSION_ID, status: 'pending' })).toEqual({
      sessionId: SESSION_ID,
      status: 'pending'
    })
    expect(() => validateSessionInfo({ sessionId: 'guessable', status: 'pending' })).toThrow(
      /sessionId/
    )
    expect(() => validateSessionInfo({ sessionId: SESSION_ID, status: 'invented' })).toThrow(
      /supported session status/
    )
  })

  it('rejects executable pairing links and non-PNG session artwork', () => {
    for (const scheme of ['javascript', 'vbscript']) {
      expect(() =>
        validateSessionInfo({
          sessionId: SESSION_ID,
          status: 'pending',
          pairingUri: `${scheme}://pair?topic=owned`
        })
      ).toThrow(/non-web wallet deep-link scheme/)
    }
    expect(() =>
      validateSessionInfo({
        sessionId: SESSION_ID,
        status: 'pending',
        qrDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
      })
    ).toThrow(/PNG data URL/)
    expect(() =>
      validateSessionInfo({
        sessionId: SESSION_ID,
        status: 'pending',
        qrDataUrl: 'data:image/png;base64,PHN2Zz48L3N2Zz4='
      })
    ).toThrow(/PNG data URL/)
  })

  it('requires encrypted relay transport except on loopback', () => {
    expect(normalizeRelayUrl('wss://relay.example/ws')).toBe('wss://relay.example/ws')
    expect(normalizeRelayUrl('ws://localhost:3000')).toBe('ws://localhost:3000')
    expect(() => normalizeRelayUrl('ws://relay.example')).toThrow(/WSS/)
    expect(() => normalizeRelayUrl('wss://user:secret@relay.example')).toThrow(/credential-free/)
    expect(() => normalizeRelayUrl('wss://relay.example?next=evil')).toThrow(/query/)
  })

  it('bounds response bodies, rejects invalid UTF-8, and disables redirects', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
    try {
      fetchMock.mockResolvedValueOnce(new Response('x'.repeat(33)))
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response', { maxBytes: 32 })
      ).rejects.toThrow(/32-byte limit/)

      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])))
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response')
      ).rejects.toThrow(/valid UTF-8/)

      expect(fetchMock).toHaveBeenCalledWith(
        'https://relay.example/status',
        expect.objectContaining({ redirect: 'error', signal: expect.anything() })
      )
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('safely supports non-streaming fetch implementations only with bounded lengths', async () => {
    const encoded = new TextEncoder().encode('{"status":"pending"}')
    const nonStreamingResponse = {
      headers: new Headers({ 'content-length': String(encoded.length) }),
      body: null,
      arrayBuffer: async () => encoded.buffer
    } as Response
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(nonStreamingResponse)
    try {
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response')
      ).resolves.toMatchObject({ value: { status: 'pending' } })

      fetchMock.mockResolvedValueOnce({ ...nonStreamingResponse, headers: new Headers() })
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response')
      ).rejects.toThrow(/could not be read within/)
    } finally {
      fetchMock.mockRestore()
    }
  })
})
