import http from 'node:http'
import { WebSocket } from 'ws'
import { DESKTOP_TOKEN_PROTOCOL_PREFIX, DESKTOP_WS_PROTOCOL } from '../src/types.js'
import { WebSocketRelay } from '../src/server/WebSocketRelay.js'

const TOPIC_A = 'A'.repeat(43)
const TOPIC_B = 'B'.repeat(43)

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

function stop(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  )
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

describe('WebSocketRelay boundary and authority enforcement', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    'rejects unsafe topic capacity %s',
    maxTopics => {
      const server = http.createServer()
      expect(() => new WebSocketRelay(server, { noServer: true, maxTopics })).toThrow(
        'maxTopics must be an integer'
      )
    }
  )

  it('selects only the stable desktop protocol and never echoes a bearer protocol', () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { noServer: true })
    const select = (relay as any).wss.options.handleProtocols as (
      protocols: Set<string>
    ) => string | false

    expect(select(new Set([DESKTOP_WS_PROTOCOL, `${DESKTOP_TOKEN_PROTOCOL_PREFIX}secret`]))).toBe(
      DESKTOP_WS_PROTOCOL
    )
    expect(select(new Set([`${DESKTOP_TOKEN_PROTOCOL_PREFIX}secret`]))).toBe(false)
    expect(select(new Set(['legacy-protocol']))).toBe('legacy-protocol')
    expect(select(new Set())).toBe(false)
    relay.close()
  })

  it('bounds buffered traffic, expires abandoned topics, and enforces the topic cap', () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { noServer: true, maxTopics: 1 })
    const envelope = { topic: TOPIC_A, ciphertext: 'AQID' }

    relay.sendToMobile(TOPIC_A, envelope)
    relay.sendToDesktop(TOPIC_A, envelope)
    for (let index = 0; index < 55; index++) relay.sendToMobile(TOPIC_A, envelope)
    expect((relay as any).topics.get(TOPIC_A).buffer).toHaveLength(50)
    expect(() => relay.sendToMobile(TOPIC_B, { ...envelope, topic: TOPIC_B })).toThrow(
      'topic limit'
    )

    ;(relay as any).topics.get(TOPIC_A).buffer.forEach((item: { expiresAt: number }) => {
      item.expiresAt = 0
    })
    ;(relay as any).runHeartbeat()
    expect((relay as any).topics.has(TOPIC_A)).toBe(false)

    expect(() =>
      relay.sendToDesktop(TOPIC_A, { topic: TOPIC_A, ciphertext: 'A'.repeat(65_536) })
    ).toThrow('exceeds 64 KiB')
    relay.close()
  })

  it('fails closed when validators throw and rejects sends after shutdown', () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { noServer: true })
    relay.onValidateTopic(() => {
      throw new Error('lookup failed')
    })
    relay.onValidateDesktopToken(() => {
      throw new Error('token store failed')
    })

    expect((relay as any).isTopicValid(TOPIC_A)).toBe(false)
    expect((relay as any).isDesktopTokenValid(TOPIC_A, 'token')).toBe(false)
    relay.close()
    relay.close()
    expect(() => relay.sendToMobile(TOPIC_A, { topic: TOPIC_A, ciphertext: 'AQID' })).toThrow(
      'relay is closed'
    )

    const socket = { destroy: jest.fn() }
    relay.handleUpgrade({} as never, socket as never, Buffer.alloc(0))
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects conflicting query and subprotocol tokens', async () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server)
    relay.onValidateTopic(() => true)
    relay.onValidateDesktopToken(() => true)
    const port = await listen(server)
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop&token=query-token`,
      [DESKTOP_WS_PROTOCOL, `${DESKTOP_TOKEN_PROTOCOL_PREFIX}protocol-token`]
    )
    const closeResult = closed(socket)

    await opened(socket)
    await expect(closeResult).resolves.toEqual({
      code: 1008,
      reason: 'Conflicting desktop tokens'
    })

    relay.close()
    await stop(server)
  })

  it('preserves one mobile authority and rejects excess live topics', async () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { maxTopics: 1 })
    relay.onValidateTopic(() => true)
    const port = await listen(server)
    const first = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    await opened(first)

    const duplicate = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const duplicateClose = closed(duplicate)
    await opened(duplicate)
    await expect(duplicateClose).resolves.toEqual({
      code: 1008,
      reason: 'A mobile connection is already active'
    })

    const excess = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_B}&role=mobile`)
    const excessClose = closed(excess)
    await opened(excess)
    await expect(excessClose).resolves.toEqual({
      code: 1013,
      reason: 'Relay topic limit reached'
    })

    first.close()
    relay.close()
    await stop(server)
  })

  it('contains mobile setup callback failures and replaces only authenticated desktops', async () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server)
    relay.onValidateTopic(() => true)
    relay.onMobileConnect(() => {
      throw new Error('auth state unavailable')
    })
    const port = await listen(server)
    const mobile = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const mobileClose = closed(mobile)
    await opened(mobile)
    await expect(mobileClose).resolves.toEqual({
      code: 1011,
      reason: 'Mobile connection setup failed'
    })

    const firstDesktop = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(firstDesktop)
    const firstClose = closed(firstDesktop)
    const replacement = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(replacement)
    await expect(firstClose).resolves.toEqual({
      code: 1008,
      reason: 'Replaced by a newer authenticated desktop connection'
    })

    replacement.close()
    relay.close()
    await stop(server)
  })
})
