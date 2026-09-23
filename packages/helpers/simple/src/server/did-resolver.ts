/**
 * DID Resolution Proxy — server-side did:bsv resolver.
 *
 * 1. Try the configured authoritative universal resolver first
 * 2. On failure, fall back to the configured authoritative WoC chain view
 *
 * The current resolver response contains no cryptographic transaction,
 * inclusion, or freshness evidence. The service validates shape, requested-DID
 * binding, and reported output-0 linkage, but callers must not treat a remote
 * answer as independent proof against a compromised resolver/provider.
 *
 * Core class (DIDResolverService) is framework-agnostic.
 * createDIDResolverHandler() returns Next.js App Router compatible { GET }.
 */

import { createPublicHTTPSFetch } from '@bsv/sdk'
import { snapshotPlainDataRecord } from '../core/certificate-validation'
import { validateDIDResolutionResult } from '../core/did-validation'
import { DIDResolverConfig, DIDResolutionResult } from '../core/types'
import { processWocSegments, type WocChainState } from '../modules/did-woc'
import {
  HandlerRequest,
  HandlerResponse,
  getSearchParams,
  jsonResponse,
  toNextHandlers
} from './handler-types'

const DEFAULT_RESOLVER_URL = 'https://bsvdid-universal-resolver.nchain.systems'
const DEFAULT_WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const BSVDID_MARKER = 'BSVDID'
const DID_CONTENT_TYPE = 'application/did+ld+json'
const MAX_RESOLVER_RESPONSE_BYTES = 2 * 1024 * 1024

interface ResolverResponse {
  status: number
  body: unknown
}

type ResolverFetch = (url: string, headers?: Record<string, string>) => Promise<ResolverResponse>

function denseOwnArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new TypeError(`Invalid ${name}`)
  const output: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
      throw new TypeError(`Invalid ${name}`)
    }
    output.push(descriptor.value)
  }
  return output
}

function snapshotResolverConfig(config?: DIDResolverConfig): DIDResolverConfig {
  if (config == null) return Object.create(null) as DIDResolverConfig
  const record = snapshotPlainDataRecord(config)
  if (record == null) throw new TypeError('Invalid DID resolver configuration')
  if (record.fetch != null && typeof record.fetch !== 'function') {
    throw new TypeError('Invalid DID resolver transport')
  }
  return Object.assign(Object.create(null) as DIDResolverConfig, {
    ...(record.resolverUrl === undefined ? {} : { resolverUrl: record.resolverUrl as string }),
    ...(record.wocBaseUrl === undefined ? {} : { wocBaseUrl: record.wocBaseUrl as string }),
    ...(record.resolverTimeout === undefined
      ? {}
      : { resolverTimeout: record.resolverTimeout as number }),
    ...(record.maxHops === undefined ? {} : { maxHops: record.maxHops as number }),
    ...(record.fetch === undefined ? {} : { fetch: record.fetch as typeof fetch })
  })
}

function normalizeRemoteBase(value: string, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    value !== value.trim()
  ) {
    throw new TypeError(`Invalid ${name}`)
  }
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(`${name} must be credential-free HTTPS without query or fragment`)
  }
  return url.toString().replace(/\/*$/, '')
}

async function readBoundedResolverJson(response: Response): Promise<unknown> {
  const declared = response.headers?.get('content-length')
  if (
    declared != null &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_RESOLVER_RESPONSE_BYTES)
  ) {
    throw new Error('DID resolver response exceeds the configured limit')
  }
  const reader = response.body?.getReader()
  let text = ''
  if (reader == null) {
    text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_RESOLVER_RESPONSE_BYTES) {
      throw new Error('DID resolver response exceeds the configured limit')
    }
  } else {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESOLVER_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('DID resolver response exceeds the configured limit')
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  }
  return JSON.parse(text) as unknown
}

// ============================================================================
// OP_RETURN parser
// ============================================================================

function hexToBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.substring(i, i + 2), 16))
  }
  return bytes
}

interface PushLength {
  length: number
  dataStart: number
}

function readPushLength(bytes: number[], opcodeIndex: number): PushLength | null {
  const op = bytes[opcodeIndex]
  const firstLengthByte = opcodeIndex + 1

  if (op >= 0x01 && op <= 0x4b) {
    return { length: op, dataStart: firstLengthByte }
  }
  if (op === 0x4c && firstLengthByte < bytes.length) {
    return { length: bytes[firstLengthByte], dataStart: firstLengthByte + 1 }
  }
  if (op === 0x4d && firstLengthByte + 1 < bytes.length) {
    return {
      length: bytes[firstLengthByte] | (bytes[firstLengthByte + 1] << 8),
      dataStart: firstLengthByte + 2
    }
  }
  if (op === 0x4e && firstLengthByte + 3 < bytes.length) {
    return {
      length:
        bytes[firstLengthByte] |
        (bytes[firstLengthByte + 1] << 8) |
        (bytes[firstLengthByte + 2] << 16) |
        (bytes[firstLengthByte + 3] << 24),
      dataStart: firstLengthByte + 4
    }
  }
  return null
}

function parseOpReturnSegments(hexScript: string): string[] {
  try {
    const bytes = hexToBytes(hexScript)
    const segments: string[] = []
    const opReturnIndex = bytes.indexOf(0x6a)
    if (opReturnIndex < 0 || opReturnIndex + 1 >= bytes.length) return []

    // Read data pushes
    let opcodeIndex = opReturnIndex + 1
    while (opcodeIndex < bytes.length) {
      const push = readPushLength(bytes, opcodeIndex)
      if (push == null || push.dataStart + push.length > bytes.length) break
      const data = bytes.slice(push.dataStart, push.dataStart + push.length)
      opcodeIndex = push.dataStart + push.length
      segments.push(new TextDecoder().decode(new Uint8Array(data)))
    }

    return segments
  } catch {
    return []
  }
}

function notFoundResult(): DIDResolutionResult {
  return {
    didDocument: null,
    didDocumentMetadata: {},
    didResolutionMetadata: { error: 'notFound', message: 'DID not found on chain' }
  }
}

function extractBsvdidSegments(vout: unknown[]): string[] {
  for (const value of vout) {
    const output = snapshotPlainDataRecord(value)
    const script = snapshotPlainDataRecord(output?.scriptPubKey)
    const hex = script?.hex
    if (typeof hex !== 'string') continue
    if (hex === '') continue
    const segments = parseOpReturnSegments(hex)
    if (segments.length >= 3 && segments[0] === BSVDID_MARKER) return segments
  }
  return []
}

async function fetchNextTxidViaSpend(
  wocBaseUrl: string,
  currentTxid: string,
  fetchJson: ResolverFetch
): Promise<string | null> {
  try {
    const response = await fetchJson(`${wocBaseUrl}/tx/${currentTxid}/out/0/spend`)
    if (response.status !== 200) return null
    const body = snapshotPlainDataRecord(response.body)
    if (body == null) return null
    const txid = body.txid
    return typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid) ? txid : null
  } catch {
    return null
  }
}

function finalChainResult(state: WocChainState): DIDResolutionResult | null {
  if (state.lastDocument != null) {
    return {
      didDocument: state.lastDocument,
      didDocumentMetadata: {
        created: state.created,
        updated: state.updated,
        versionId: state.lastDocTxid
      },
      didResolutionMetadata: { contentType: DID_CONTENT_TYPE }
    }
  }

  if (!state.foundIssuance) return null
  return {
    didDocument: null,
    didDocumentMetadata: { created: state.created },
    didResolutionMetadata: {
      error: 'notYetAvailable',
      message:
        'DID issuance found on chain but document transaction has not propagated yet. Try again shortly.'
    }
  }
}

// ============================================================================
// DIDResolverService core class
// ============================================================================

export class DIDResolverService {
  private readonly resolverUrl: string
  private readonly wocBaseUrl: string
  private readonly resolverTimeout: number
  private readonly maxHops: number
  private readonly trustedFetch?: typeof fetch

  constructor(config?: DIDResolverConfig) {
    const ownedConfig = snapshotResolverConfig(config)
    this.resolverUrl = normalizeRemoteBase(
      ownedConfig.resolverUrl ?? DEFAULT_RESOLVER_URL,
      'DID resolver URL'
    )
    this.wocBaseUrl = normalizeRemoteBase(ownedConfig.wocBaseUrl ?? DEFAULT_WOC_BASE, 'WoC URL')
    this.resolverTimeout = ownedConfig.resolverTimeout ?? 10_000
    this.maxHops = ownedConfig.maxHops ?? 100
    this.trustedFetch = ownedConfig.fetch
    if (
      !Number.isSafeInteger(this.resolverTimeout) ||
      this.resolverTimeout < 250 ||
      this.resolverTimeout > 60_000
    ) {
      throw new TypeError('resolverTimeout must be a safe integer between 250 and 60000')
    }
    if (!Number.isSafeInteger(this.maxHops) || this.maxHops < 1 || this.maxHops > 100) {
      throw new TypeError('maxHops must be a safe integer between 1 and 100')
    }
  }

  private readonly fetchJson: ResolverFetch = async (url, headers) => {
    const target = new URL(url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.resolverTimeout)
    try {
      const fetchClient = this.trustedFetch ?? createPublicHTTPSFetch(target.origin)
      const response = await fetchClient(target.toString(), {
        ...(headers == null ? {} : { headers }),
        redirect: 'error',
        signal: controller.signal
      })
      return { status: response.status, body: await readBoundedResolverJson(response) }
    } finally {
      clearTimeout(timeout)
    }
  }

  async resolve(did: string): Promise<DIDResolutionResult> {
    const txidMatch = /^did:bsv:([0-9a-f]{64})$/.exec(did)
    if (txidMatch == null) return notFoundResult()

    // Try nChain Universal Resolver
    try {
      const response = await this.fetchJson(
        `${this.resolverUrl}/1.0/identifiers/${encodeURIComponent(did)}`,
        { Accept: 'application/did+ld+json' }
      )

      if (response.status === 200) {
        const data = snapshotPlainDataRecord(response.body)
        if (data == null) throw new TypeError('Invalid DID resolver response')
        const hasEnvelope = Object.getOwnPropertyDescriptor(data, 'didDocument') != null
        const envelope = hasEnvelope
          ? data
          : { didDocument: data, didDocumentMetadata: {}, didResolutionMetadata: {} }
        const metadata =
          snapshotPlainDataRecord(envelope.didResolutionMetadata) ?? Object.create(null)
        return validateDIDResolutionResult(
          {
            ...envelope,
            didResolutionMetadata: {
              contentType: DID_CONTENT_TYPE,
              ...metadata
            }
          },
          did
        )
      }

      if (response.status === 410) {
        const data = snapshotPlainDataRecord(response.body)
        const documentMetadata = snapshotPlainDataRecord(data?.didDocumentMetadata)
        const resolutionMetadata = snapshotPlainDataRecord(data?.didResolutionMetadata)
        return validateDIDResolutionResult(
          {
            didDocument: data?.didDocument ?? null,
            didDocumentMetadata: { ...documentMetadata, deactivated: true },
            didResolutionMetadata: {
              ...resolutionMetadata,
              contentType: DID_CONTENT_TYPE
            }
          },
          did
        )
      }
    } catch {
      // nChain timeout/error — fall through to WoC
    }

    // WoC chain-following fallback
    try {
      return await this.resolveViaWoC(txidMatch[1])
    } catch {
      return {
        didDocument: null,
        didDocumentMetadata: {},
        didResolutionMetadata: {
          error: 'internalError',
          message: 'DID resolution failed'
        }
      }
    }
  }

  private async resolveViaWoC(txid: string): Promise<DIDResolutionResult> {
    let currentTxid = txid
    const visited = new Set<string>()
    const state: WocChainState = {
      did: `did:bsv:${txid}`,
      identityCode: undefined,
      lastDocument: null,
      lastDocTxid: undefined,
      created: undefined,
      updated: undefined,
      foundIssuance: false
    }

    for (let hop = 0; hop < this.maxHops; hop++) {
      if (visited.has(currentTxid)) break
      visited.add(currentTxid)

      const txResp = await this.fetchJson(`${this.wocBaseUrl}/tx/${currentTxid}`)
      if (txResp.status !== 200) return notFoundResult()
      const txData = snapshotPlainDataRecord(txResp.body)
      if (txData == null || txData.txid !== currentTxid) return notFoundResult()
      const vout = denseOwnArray(txData.vout, 'WoC transaction outputs')
      if (hop > 0) {
        const previousTxid = [...visited][visited.size - 2]
        const vin = denseOwnArray(txData.vin, 'WoC transaction inputs')
        if (
          !vin.some(value => {
            const input = snapshotPlainDataRecord(value)
            return input?.txid === previousTxid && input.vout === 0
          })
        ) {
          return notFoundResult()
        }
      }

      state.created ??=
        typeof txData.time === 'number' && Number.isFinite(txData.time)
          ? new Date(txData.time * 1000).toISOString()
          : undefined

      const segments = extractBsvdidSegments(vout)
      const earlyExit = processWocSegments(segments, txData, currentTxid, state)
      if (earlyExit != null) return earlyExit

      const nextTxid = await fetchNextTxidViaSpend(this.wocBaseUrl, currentTxid, this.fetchJson)
      if (nextTxid == null) break
      currentTxid = nextTxid
    }

    return finalChainResult(state) ?? notFoundResult()
  }
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createDIDResolverHandler(
  config?: DIDResolverConfig
): ReturnType<typeof toNextHandlers> {
  const resolver = new DIDResolverService(config)

  const coreHandlers = {
    async GET(req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const did = params.get('did')

      if (did == null || did === '') {
        return jsonResponse({ error: 'Missing "did" query parameter' }, 400)
      }

      try {
        const result = await resolver.resolve(did)
        let status = 200
        if (result.didResolutionMetadata.error === 'notFound') {
          status = 404
        } else if (result.didResolutionMetadata.error === 'internalError') {
          status = 502
        }
        return jsonResponse(result, status)
      } catch {
        return jsonResponse(
          {
            didDocument: null,
            didDocumentMetadata: {},
            didResolutionMetadata: {
              error: 'internalError',
              message: 'DID resolution failed'
            }
          },
          502
        )
      }
    }
  }

  return toNextHandlers(coreHandlers)
}
