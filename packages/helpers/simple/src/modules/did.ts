import {
  PublicKey,
  PrivateKey,
  P2PKH,
  Script,
  OP,
  Random,
  Beef,
  completeBoundAction,
  createPublicHTTPSFetch,
  snapshotWalletResultRequest,
  validateWalletArgs,
  validateWalletResult
} from '@bsv/sdk'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import { validateDIDDocument, validateDIDResolutionResult } from '../core/did-validation'
import { WalletCore } from '../core/WalletCore'
import {
  DIDDocument,
  DIDVerificationMethod,
  DIDParseResult,
  DIDDocumentV2,
  DIDVerificationMethodV2,
  DIDService,
  DIDCreateOptions,
  DIDCreateResult,
  DIDResolutionResult,
  DIDChainState,
  DIDUpdateOptions
} from '../core/types'
import { DIDError } from '../core/errors'
import { processWocSegments, type WocChainState } from './did-woc'

// ============================================================================
// Constants
// ============================================================================

const BSVDID_MARKER = 'BSVDID'
const DID_PREFIX = 'did:bsv:'
const DID_CONTEXT = 'https://www.w3.org/ns/did/v1'
const VERIFICATION_KEY_TYPE = 'JsonWebKey2020'
const LEGACY_KEY_TYPE = 'EcdsaSecp256k1VerificationKey2019'

// ============================================================================
// Utility Functions
// ============================================================================

function base64url(bytes: number[]): string {
  let encoded = toBase64(bytes).split('+').join('-').split('/').join('_')
  while (encoded.endsWith('=')) {
    encoded = encoded.slice(0, -1)
  }
  return encoded
}

function pubKeyToJwk(compressedHex: string): { kty: string; crv: string; x: string; y: string } {
  const pubKey = PublicKey.fromString(compressedHex)
  const xBytes = pubKey.getX().toArray('be', 32)
  const yBytes = pubKey.getY().toArray('be', 32)
  return {
    kty: 'EC',
    crv: 'secp256k1',
    x: base64url(xBytes),
    y: base64url(yBytes)
  }
}

function buildOpReturn(identityCode: string, payload: string): Script {
  return new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(toArray(BSVDID_MARKER, 'utf8'))
    .writeBin(toArray(identityCode, 'utf8'))
    .writeBin(toArray(payload, 'utf8'))
}

function generateIdentityCode(): string {
  return toHex(Random(16))
}

function normalizeIdentityCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new DIDError('DID identity code must contain 1-128 URL-safe characters')
  }
  return value
}

type OwnDataRecord = Record<string, unknown>

function ownDataRecord(value: unknown, name: string): OwnDataRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain data object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`)
  }
  const snapshot = Object.create(null) as OwnDataRecord
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${name} must not contain symbol properties`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    const ownValue =
      descriptor == null ? undefined : Object.getOwnPropertyDescriptor(descriptor, 'value')
    if (ownValue == null) {
      throw new TypeError(`${name}.${key} must be a data property`)
    }
    snapshot[key] = ownValue.value
  }
  return snapshot
}

function optionalOwnDataRecord(value: unknown, name: string): OwnDataRecord | undefined {
  return value == null ? undefined : ownDataRecord(value, name)
}

function denseOwnArray(value: unknown, name: string, maximum = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${name} must be a bounded dense array`)
  }
  const snapshot: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const ownValue =
      descriptor == null ? undefined : Object.getOwnPropertyDescriptor(descriptor, 'value')
    if (ownValue == null) {
      throw new TypeError(`${name} must be a bounded dense array`)
    }
    snapshot.push(ownValue.value)
  }
  return snapshot
}

function denseOwnBytes(value: unknown, name: string): number[] {
  return denseOwnArray(value, name, 64 * 1024 * 1024).map((byte, index) => {
    if (!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255) {
      throw new TypeError(`${name}[${index}] must be a byte`)
    }
    return byte as number
  })
}

function snapshotServices(value: unknown, name: string): DIDService[] | undefined {
  if (value == null) return undefined
  return denseOwnArray(value, name, 32).map((service, index) => {
    const record = ownDataRecord(service, `${name}[${index}]`)
    return {
      id: record.id,
      type: record.type,
      serviceEndpoint: record.serviceEndpoint
    } as DIDService
  })
}

function snapshotStringArray(value: unknown, name: string, maximum: number): string[] | undefined {
  if (value == null) return undefined
  return denseOwnArray(value, name, maximum).map((entry, index) => {
    if (typeof entry !== 'string') throw new TypeError(`${name}[${index}] must be a string`)
    return entry
  })
}

function snapshotDIDCreateOptions(value: DIDCreateOptions | undefined): DIDCreateOptions {
  const record = value == null ? Object.create(null) : ownDataRecord(value, 'DID create options')
  return Object.assign(Object.create(null), {
    identityCode: record.identityCode,
    satoshis: record.satoshis,
    basket: record.basket,
    controllerKey: record.controllerKey,
    services: snapshotServices(record.services, 'DID create services')
  }) as DIDCreateOptions
}

function snapshotDIDUpdateOptions(value: DIDUpdateOptions): DIDUpdateOptions {
  const record = ownDataRecord(value, 'DID update options')
  return Object.assign(Object.create(null), {
    did: record.did,
    services: snapshotServices(record.services, 'DID update services'),
    additionalKeys: snapshotStringArray(record.additionalKeys, 'DID additional keys', 32)
  }) as DIDUpdateOptions
}

interface SafeWalletOutput {
  outpoint?: string
  customInstructions?: string
}

interface SafeListOutputsResult {
  outputs: SafeWalletOutput[]
  BEEF?: number[]
}

async function listOutputsOwnData(
  client: any,
  args: Record<string, unknown>
): Promise<SafeListOutputsResult> {
  const result = ownDataRecord(await client.listOutputs(args), 'Wallet listOutputs result')
  const rawOutputs = result.outputs == null ? [] : denseOwnArray(result.outputs, 'Wallet outputs')
  const outputs = rawOutputs.map((output, index) => {
    const record = ownDataRecord(output, `Wallet outputs[${index}]`)
    const outpoint = record.outpoint
    const customInstructions = record.customInstructions
    if (outpoint != null && typeof outpoint !== 'string') {
      throw new TypeError(`Wallet outputs[${index}].outpoint must be a string`)
    }
    if (customInstructions != null && typeof customInstructions !== 'string') {
      throw new TypeError(`Wallet outputs[${index}].customInstructions must be a string`)
    }
    return {
      ...(outpoint == null ? {} : { outpoint }),
      ...(customInstructions == null ? {} : { customInstructions })
    }
  })
  return {
    outputs,
    ...(result.BEEF == null ? {} : { BEEF: denseOwnBytes(result.BEEF, 'Wallet BEEF') })
  }
}

async function getPublicKeyOwnData(client: any, args: Record<string, unknown>): Promise<string> {
  validateWalletArgs('getPublicKey', args)
  const request = snapshotWalletResultRequest('getPublicKey', args)
  const result = validateWalletResult('getPublicKey', await client.getPublicKey(args), request)
  return ownDataRecord(result, 'Wallet getPublicKey result').publicKey as string
}

async function createActionOwnData(client: any, args: Record<string, unknown>): Promise<string> {
  validateWalletArgs('createAction', args)
  const request = snapshotWalletResultRequest('createAction', args)
  const result = validateWalletResult('createAction', await client.createAction(args), request)
  return ownDataRecord(result, 'Wallet createAction result').txid as string
}

/** Bind fragment-relative service IDs without invoking attacker-controlled accessors. */
function bindRelativeServiceIds(
  services: DIDService[] | undefined,
  did: string
): DIDService[] | undefined {
  if (services == null) return undefined
  if (!Array.isArray(services)) return services
  return services.map((service, index) => {
    const record = ownDataRecord(service, `DID services[${index}]`)
    const id = record.id
    if (typeof id !== 'string' || !id.startsWith('#')) return service
    return {
      id: `${did}${id}`,
      type: record.type,
      serviceEndpoint: record.serviceEndpoint
    } as DIDService
  })
}

function readPushLength(
  bytes: number[],
  opcodeIndex: number
): { length: number; dataStart: number } | null {
  const opcode = bytes[opcodeIndex]
  const firstLengthByte = opcodeIndex + 1
  if (opcode >= 0x01 && opcode <= 0x4b) {
    return { length: opcode, dataStart: firstLengthByte }
  }
  if (opcode === OP.OP_PUSHDATA1 && firstLengthByte < bytes.length) {
    return { length: bytes[firstLengthByte], dataStart: firstLengthByte + 1 }
  }
  if (opcode === OP.OP_PUSHDATA2 && firstLengthByte + 1 < bytes.length) {
    return {
      length: bytes[firstLengthByte] | (bytes[firstLengthByte + 1] << 8),
      dataStart: firstLengthByte + 2
    }
  }
  if (opcode === OP.OP_PUSHDATA4 && firstLengthByte + 3 < bytes.length) {
    return {
      length:
        (bytes[firstLengthByte] |
          (bytes[firstLengthByte + 1] << 8) |
          (bytes[firstLengthByte + 2] << 16) |
          (bytes[firstLengthByte + 3] << 24)) >>>
        0,
      dataStart: firstLengthByte + 4
    }
  }
  return null
}

function parseOpReturnSegments(scriptHex: string): string[] {
  try {
    const bytes = Script.fromHex(scriptHex).toBinary()
    let opcodeIndex = 0
    while (opcodeIndex < bytes.length && bytes[opcodeIndex] !== OP.OP_RETURN) {
      const push = readPushLength(bytes, opcodeIndex)
      if (push == null) {
        opcodeIndex++
      } else {
        const nextOpcode = push.dataStart + push.length
        if (nextOpcode > bytes.length) return []
        opcodeIndex = nextOpcode
      }
    }
    if (opcodeIndex >= bytes.length - 1) return []
    opcodeIndex++

    const segments: string[] = []
    while (opcodeIndex < bytes.length) {
      const push = readPushLength(bytes, opcodeIndex)
      if (push == null || push.dataStart + push.length > bytes.length) return []
      const data = bytes.slice(push.dataStart, push.dataStart + push.length)
      segments.push(new TextDecoder().decode(new Uint8Array(data)))
      opcodeIndex = push.dataStart + push.length
    }
    return segments
  } catch {
    return []
  }
}

// ============================================================================
// Resolution helper functions (module-private)
// ============================================================================

const DID_CONTENT_TYPE = 'application/did+ld+json'
const WOC_API = 'https://api.whatsonchain.com/v1/bsv/main'
const WOC_RATE_LIMIT_MS = 350
const WOC_MAX_HOPS = 100
const DID_RESPONSE_MAX_BYTES = 2 * 1024 * 1024
const DID_REQUEST_TIMEOUT_MS = 15_000

interface DIDHttpResult {
  status: number
  body: unknown
}

function normalizeResolverUrl(value: string): URL {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    value !== value.trim()
  ) {
    throw new TypeError('Invalid DID resolver URL')
  }
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('DID resolver URL must be credential-free HTTPS without query or fragment')
  }
  return url
}

async function readDIDJson(response: Response): Promise<unknown> {
  const declared = response.headers?.get('content-length')
  if (
    declared != null &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > DID_RESPONSE_MAX_BYTES)
  ) {
    throw new Error('DID resolver response exceeds the configured limit')
  }
  const reader = response.body?.getReader()
  let text = ''
  if (reader == null) {
    text = await response.text()
    if (new TextEncoder().encode(text).byteLength > DID_RESPONSE_MAX_BYTES) {
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
        if (total > DID_RESPONSE_MAX_BYTES) {
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

async function fetchDIDJson(url: URL, trustedFetch?: typeof fetch): Promise<DIDHttpResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DID_REQUEST_TIMEOUT_MS)
  try {
    const fetchClient = trustedFetch ?? createPublicHTTPSFetch(url.origin)
    const response = await fetchClient(url.toString(), {
      redirect: 'error',
      signal: controller.signal
    })
    return { status: response.status, body: await readDIDJson(response) }
  } finally {
    clearTimeout(timeout)
  }
}

/** Return a DIDResolutionResult for a legacy pubkey-based DID. */
function resolveLegacyDID(identityKey: string): DIDResolutionResult {
  const legacyDoc = DID.fromIdentityKey(identityKey) // NOSONAR — legacy DID resolution requires deprecated API
  return {
    didDocument: {
      '@context': DID_CONTEXT,
      id: legacyDoc.id,
      controller: legacyDoc.controller,
      verificationMethod: legacyDoc.verificationMethod.map(vm => ({
        id: vm.id,
        type: vm.type,
        controller: vm.controller,
        publicKeyJwk: pubKeyToJwk(vm.publicKeyHex)
      })),
      authentication: legacyDoc.authentication
    },
    didDocumentMetadata: {},
    didResolutionMetadata: { contentType: DID_CONTENT_TYPE }
  }
}

/** Try a proxy resolver; return result or null if unavailable / no match. */
async function tryProxyResolver(
  didString: string,
  proxyUrl: string | undefined,
  trustedFetch?: typeof fetch
): Promise<DIDResolutionResult | null> {
  if (proxyUrl == null || proxyUrl === '') return null
  try {
    const url = normalizeResolverUrl(proxyUrl)
    url.searchParams.set('did', didString)
    const response = await fetchDIDJson(url, trustedFetch)
    if (response.status !== 200) return null
    const result = validateDIDResolutionResult(response.body, didString)
    if (result.didDocument != null || result.didDocumentMetadata.deactivated === true) {
      return result
    }
  } catch {
    // Proxy unavailable — fall through
  }
  return null
}

/** Try the universal resolver directly; return result or null if unavailable. */
async function tryDirectResolver(
  didString: string,
  resolverUrl: string | undefined,
  trustedFetch?: typeof fetch
): Promise<DIDResolutionResult | null> {
  if (resolverUrl == null || resolverUrl === '') return null
  try {
    const base = normalizeResolverUrl(resolverUrl)
    const url = new URL(
      `1.0/identifiers/${encodeURIComponent(didString)}`,
      `${base.toString().replace(/\/*$/, '')}/`
    )
    const response = await fetchDIDJson(url, trustedFetch)
    if (response.status === 200) {
      const data = response.body
      const record = optionalOwnDataRecord(data, 'DID resolver response')
      const hasEnvelope =
        record != null && Object.prototype.hasOwnProperty.call(record, 'didDocument')
      const documentMetadata = hasEnvelope
        ? optionalOwnDataRecord(record.didDocumentMetadata, 'DID document metadata')
        : undefined
      const resolutionMetadata = hasEnvelope
        ? optionalOwnDataRecord(record.didResolutionMetadata, 'DID resolution metadata')
        : undefined
      return validateDIDResolutionResult(
        {
          didDocument: hasEnvelope ? record.didDocument : data,
          didDocumentMetadata: documentMetadata ?? Object.create(null),
          didResolutionMetadata: {
            ...resolutionMetadata,
            contentType: DID_CONTENT_TYPE
          }
        },
        didString
      )
    }
    if (response.status === 410) {
      const data = optionalOwnDataRecord(response.body, 'DID resolver response')
      const documentMetadata = optionalOwnDataRecord(
        data?.didDocumentMetadata,
        'DID document metadata'
      )
      const resolutionMetadata = optionalOwnDataRecord(
        data?.didResolutionMetadata,
        'DID resolution metadata'
      )
      return validateDIDResolutionResult(
        {
          didDocument:
            data != null && Object.prototype.hasOwnProperty.call(data, 'didDocument')
              ? data.didDocument
              : null,
          didDocumentMetadata: { ...documentMetadata, deactivated: true },
          didResolutionMetadata: {
            ...resolutionMetadata,
            contentType: DID_CONTENT_TYPE
          }
        },
        didString
      )
    }
  } catch {
    // Resolver unavailable — fall through
  }
  return null
}

/** Find the latest chain-state custom-instructions entry for a given DID. */
function parsedChainInstructions(output: SafeWalletOutput): OwnDataRecord | null {
  if (output.customInstructions == null) return null
  try {
    return ownDataRecord(JSON.parse(output.customInstructions), 'DID chain instructions')
  } catch {
    return null
  }
}

function findLatestChainStateForDID(
  outputs: SafeWalletOutput[],
  didString: string
): OwnDataRecord | null {
  let latestCI: OwnDataRecord | null = null
  for (const output of outputs) {
    const ci = parsedChainInstructions(output)
    if (ci?.did !== didString) continue
    latestCI = ci
  }
  return latestCI
}

/** Find the active chain state and its outpoint for a given DID. */
function findActiveChainState(
  outputs: SafeWalletOutput[],
  didString: string
): { chainCI: OwnDataRecord; chainOutpoint: string } | null {
  for (const output of outputs) {
    const ci = parsedChainInstructions(output)
    if (ci?.did === didString && ci.status === 'active' && typeof output.outpoint === 'string') {
      return { chainCI: ci, chainOutpoint: output.outpoint }
    }
  }
  return null
}

/** Build a DIDResolutionResult for a deactivated DID from stored CI. */
function buildDeactivatedResolutionResult(
  ci: OwnDataRecord,
  didString: string
): DIDResolutionResult {
  const identifier = DID.parse(didString).identifier
  if (identifier.length !== 64 || ci.issuanceTxid !== identifier) {
    throw new DIDError('Stored DID state does not match the requested DID')
  }
  if (ci.subjectKey != null && typeof ci.subjectKey !== 'string') {
    throw new DIDError('Stored DID subject key is invalid')
  }
  const doc =
    ci.subjectKey == null
      ? null
      : DID.buildDocument(ci.issuanceTxid as string, ci.subjectKey, didString)
  return validateDIDResolutionResult(
    {
      didDocument: doc,
      didDocumentMetadata: { deactivated: true },
      didResolutionMetadata: { contentType: DID_CONTENT_TYPE }
    },
    didString
  )
}

/** Build a DIDResolutionResult for an active DID from stored CI. */
function buildActiveResolutionResult(ci: OwnDataRecord, didString: string): DIDResolutionResult {
  const identifier = DID.parse(didString).identifier
  if (identifier.length !== 64 || ci.issuanceTxid !== identifier) {
    throw new DIDError('Stored DID state does not match the requested DID')
  }
  if (typeof ci.subjectKey !== 'string') throw new DIDError('Stored DID subject key is invalid')
  const document = DID.buildDocument(
    ci.issuanceTxid as string,
    ci.subjectKey as string,
    didString,
    snapshotServices(ci.services, 'Stored DID services')
  )
  if (ci.additionalKeys != null) {
    appendAdditionalKeys(
      document,
      snapshotStringArray(ci.additionalKeys, 'Stored DID additional keys', 32)!,
      didString
    )
  }
  return validateDIDResolutionResult(
    {
      didDocument: document,
      didDocumentMetadata: {},
      didResolutionMetadata: { contentType: DID_CONTENT_TYPE }
    },
    didString
  )
}

/** Append additional verification-method keys to a DID document (mutates document). */
function appendAdditionalKeys(
  document: DIDDocumentV2,
  additionalKeys: string[],
  did: string
): void {
  for (let i = 0; i < additionalKeys.length; i++) {
    document.verificationMethod.push({
      id: `${did}#key-${i + 2}`,
      type: VERIFICATION_KEY_TYPE,
      controller: did,
      publicKeyJwk: pubKeyToJwk(additionalKeys[i])
    })
  }
}

/**
 * Rate-limiter for WoC API calls.
 * Returns a fetch-like function that throttles to at most one call per WOC_RATE_LIMIT_MS.
 */
function makeWocFetcher(trustedFetch?: typeof fetch): (url: string) => Promise<DIDHttpResult> {
  let lastCall = 0
  return async (url: string): Promise<DIDHttpResult> => {
    const elapsed = Date.now() - lastCall
    if (lastCall > 0 && elapsed < WOC_RATE_LIMIT_MS) {
      await new Promise(resolve => setTimeout(resolve, WOC_RATE_LIMIT_MS - elapsed))
    }
    lastCall = Date.now()
    return await fetchDIDJson(new URL(url), trustedFetch)
  }
}

/** Extract BSVDID OP_RETURN segments from a WoC transaction's vout array. */
function extractBsvdidSegments(vout: unknown[]): string[] {
  for (const [index, value] of vout.entries()) {
    const out = ownDataRecord(value, `WoC outputs[${index}]`)
    const script = optionalOwnDataRecord(out.scriptPubKey, `WoC outputs[${index}].scriptPubKey`)
    const hex = script?.hex
    if (hex != null && typeof hex !== 'string') return []
    if (hex == null || hex === '') continue
    const s = parseOpReturnSegments(hex)
    if (s.length >= 3 && s[0] === BSVDID_MARKER) return s
  }
  return []
}

/** Follow the WoC spend index to find the next txid spending output 0. */
async function fetchNextTxidViaSpend(
  currentTxid: string,
  wocFetch: (url: string) => Promise<DIDHttpResult>
): Promise<string | null> {
  try {
    const resp = await wocFetch(`${WOC_API}/tx/${currentTxid}/out/0/spend`)
    if (resp.status === 200) {
      const result = optionalOwnDataRecord(resp.body, 'WoC spend response')
      const txid = result?.txid
      return typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid) ? txid : null
    }
  } catch {
    /* fall through */
  }
  return null
}

/** Resolve a DID by following the UTXO chain on WhatsOnChain (extracted logic). */
async function resolveChainOnWoC(
  txid: string,
  trustedFetch?: typeof fetch
): Promise<DIDResolutionResult> {
  const notFound: DIDResolutionResult = {
    didDocument: null,
    didDocumentMetadata: {},
    didResolutionMetadata: { error: 'notFound', message: 'DID not found on chain' }
  }

  const wocFetch = makeWocFetcher(trustedFetch)
  const visited = new Set<string>()
  const state: WocChainState = {
    did: DID.fromTxid(txid),
    identityCode: undefined,
    lastDocument: null,
    lastDocTxid: undefined,
    created: undefined,
    updated: undefined,
    foundIssuance: false
  }

  let currentTxid = txid

  for (let hop = 0; hop < WOC_MAX_HOPS; hop++) {
    if (visited.has(currentTxid)) break
    visited.add(currentTxid)

    const txResp = await wocFetch(`${WOC_API}/tx/${currentTxid}`)
    if (txResp.status !== 200) return notFound
    let txData: OwnDataRecord
    let vout: unknown[]
    try {
      txData = ownDataRecord(txResp.body, 'WoC transaction')
      vout = denseOwnArray(txData.vout, 'WoC transaction outputs')
    } catch {
      return notFound
    }
    if (txData.txid !== currentTxid) return notFound
    if (hop > 0) {
      const previousTxid = [...visited][visited.size - 2]
      let inputs: OwnDataRecord[]
      try {
        inputs = denseOwnArray(txData.vin, 'WoC transaction inputs').map((input, index) =>
          ownDataRecord(input, `WoC transaction inputs[${index}]`)
        )
      } catch {
        return notFound
      }
      if (!inputs.some(input => input.txid === previousTxid && input.vout === 0)) return notFound
    }

    if (
      state.created == null &&
      Number.isSafeInteger(txData.time) &&
      (txData.time as number) >= 0
    ) {
      const created = new Date((txData.time as number) * 1000)
      if (Number.isFinite(created.getTime())) state.created = created.toISOString()
    }

    const segments = extractBsvdidSegments(vout)
    const earlyExit = processWocSegments(segments, txData, currentTxid, state)
    if (earlyExit != null) return earlyExit

    // Follow the chain to the next spending tx
    const nextTxid = await fetchNextTxidViaSpend(currentTxid, wocFetch)
    if (nextTxid == null) break
    currentTxid = nextTxid
  }

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

  if (state.foundIssuance) {
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

  return notFound
}

// ============================================================================
// DID Utility Class (standalone — no wallet dependency)
// ============================================================================

export class DID {
  // eslint-disable-line @typescript-eslint/no-extraneous-class
  /**
   * Parse a did:bsv: string and extract the identifier (txid).
   */
  static parse(didString: string): DIDParseResult {
    if (didString === '' || !didString.startsWith(DID_PREFIX)) {
      throw new DIDError(`Invalid DID: must start with "${DID_PREFIX}"`)
    }

    const identifier = didString.slice(DID_PREFIX.length)
    // Accept both legacy 66-char pubkey and new 64-char txid
    if (/^[0-9a-f]{64}$/.test(identifier)) {
      return { method: 'bsv', identifier }
    }
    if (/^(?:02|03)[0-9a-fA-F]{64}$/.test(identifier)) {
      // Legacy pubkey-based DID. Return one canonical encoding so equivalent
      // keys cannot acquire distinct DID strings in caches or policy maps.
      try {
        const canonical = PublicKey.fromString(identifier).toString()
        return { method: 'bsv', identifier: canonical }
      } catch {
        throw new DIDError('Invalid DID: legacy identifier is not a secp256k1 public key')
      }
    }
    throw new DIDError(
      'Invalid DID: identifier must be a 64-character lowercase hex txid or 66-character hex public key'
    )
  }

  /**
   * Validate a did:bsv: string format.
   */
  static isValid(didString: string): boolean {
    try {
      DID.parse(didString)
      return true
    } catch {
      return false
    }
  }

  /**
   * Create a DID string from a transaction ID.
   */
  static fromTxid(txid: string): string {
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      throw new DIDError('Invalid txid: must be 64 lowercase hex characters')
    }
    return `${DID_PREFIX}${txid}`
  }

  /**
   * Build a W3C DID Document (V2 spec-compliant, JsonWebKey2020).
   */
  static buildDocument(
    txid: string,
    subjectPubKeyHex: string,
    controllerDID?: string,
    services?: DIDService[]
  ): DIDDocumentV2 {
    const did = DID.fromTxid(txid)
    const jwk = pubKeyToJwk(subjectPubKeyHex)

    const verificationMethod: DIDVerificationMethodV2 = {
      id: `${did}#subject-key`,
      type: VERIFICATION_KEY_TYPE,
      controller: did,
      publicKeyJwk: jwk
    }

    const doc: DIDDocumentV2 = {
      '@context': DID_CONTEXT,
      id: did,
      verificationMethod: [verificationMethod],
      authentication: [`${did}#subject-key`]
    }

    if (controllerDID != null && controllerDID !== '') {
      doc.controller = controllerDID
    }

    if (services != null && services.length > 0) {
      doc.service = services
    }

    return validateDIDDocument(doc, did)
  }

  /**
   * @deprecated Use DID.buildDocument() for spec-compliant documents.
   * Generate a legacy DID Document from an identity key (compressed public key hex).
   */
  static fromIdentityKey(identityKey: string): DIDDocument {
    let canonical: string
    try {
      canonical = PublicKey.fromString(identityKey).toString()
    } catch {
      throw new DIDError('Invalid identity key: must be a 66-character hex compressed public key')
    }
    if (!/^(?:02|03)[0-9a-f]{64}$/.test(canonical)) {
      throw new DIDError('Invalid identity key: must be a 66-character hex compressed public key')
    }

    const did = `${DID_PREFIX}${canonical}`
    const keyId = `${did}#key-1`

    const verificationMethod: DIDVerificationMethod = {
      id: keyId,
      type: LEGACY_KEY_TYPE,
      controller: did,
      publicKeyHex: canonical
    }

    return {
      '@context': [DID_CONTEXT],
      id: did,
      controller: did,
      verificationMethod: [verificationMethod],
      authentication: [keyId],
      assertionMethod: [keyId]
    }
  }

  /**
   * Get the legacy certificate type used by previously persisted DID
   * certificates. Retained so existing records remain discoverable.
   */
  static getCertificateType(): string {
    return toBase64(toArray('did:bsv', 'utf8'))
  }

  /**
   * Get the canonical 32-byte certificate type used for new DID persistence.
   */
  static getCanonicalCertificateType(): string {
    return toBase64(sha256(toArray('did:bsv', 'utf8')))
  }
}

// ============================================================================
// Wallet-integrated DID methods
// ============================================================================

async function spendChainOutput(params: {
  client: any
  basket: string
  currentOutpoint: string
  chainKeyHex: string
  description: string
  newOutputs: Array<{
    lockingScript: string
    satoshis: number
    outputDescription: string
    basket?: string
    customInstructions?: string
    tags?: string[]
  }>
}): Promise<{ txid: string; tx: any }> {
  const { client, basket, currentOutpoint, chainKeyHex, description, newOutputs } = params
  const chainKey = PrivateKey.fromHex(chainKeyHex)

  // Get BEEF for the chain UTXO
  const result = await listOutputsOwnData(client, {
    basket,
    include: 'entire transactions',
    includeCustomInstructions: true
  })

  if (result.BEEF == null) {
    throw new DIDError('Wallet did not return the chain transaction BEEF')
  }

  const beef = new Beef()
  beef.mergeBeef(result.BEEF)
  const inputBEEF = beef.toBinary()

  const signed = await completeBoundAction(
    client,
    {
      description,
      inputBEEF,
      inputs: [
        {
          outpoint: currentOutpoint,
          unlockingScriptLength: 108, // P2PKH: sig 73 + push 1 + pubkey 33 + push 1
          inputDescription: 'DID chain UTXO'
        }
      ],
      outputs: newOutputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    } as any,
    {
      inputSigners: {
        [currentOutpoint]: async (transaction, inputIndex) =>
          await new P2PKH().unlock(chainKey, 'all', false).sign(transaction, inputIndex)
      }
    }
  )

  return {
    txid: signed.id('hex'),
    tx: signed.toAtomicBEEF()
  }
}

export function createDIDMethods(core: WalletCore): ReturnType<typeof _buildDIDMethods> {
  return _buildDIDMethods(core)
}

function _buildDIDMethods(core: WalletCore): {
  createDID: (options?: DIDCreateOptions) => Promise<DIDCreateResult>
  resolveDID: (didString: string) => Promise<DIDResolutionResult>
  _resolveFromBasket: (didString: string) => Promise<DIDResolutionResult | null>
  _resolveViaWhatsOnChain: (txid: string) => Promise<DIDResolutionResult>
  updateDID: (options: DIDUpdateOptions) => Promise<DIDCreateResult>
  deactivateDID: (didString: string) => Promise<{ txid: string }>
  listDIDs: () => Promise<DIDChainState[]>
  getDID: () => DIDDocument
  registerDID: (options: { persist?: boolean }) => Promise<DIDDocument>
} {
  /**
   * Build a P2PKH locking script for a tracking output (goes into basket).
   * Locked to the wallet's own identity key so it's recognized as spendable.
   */
  function buildTrackingScript(): string {
    const identityKey = core.getIdentityKey()
    const address = PublicKey.fromString(identityKey).toAddress()
    return new P2PKH().lock(address).toHex()
  }

  return {
    /**
     * Create a spec-compliant did:bsv DID with UTXO chain linking.
     *
     * TX0 (issuance): P2PKH chain UTXO (out 0) + OP_RETURN marker (out 1).
     *   The txid becomes the DID identifier.
     * TX1 (document): Spends TX0 out 0, creates new chain UTXO (out 0) +
     *   OP_RETURN with DID Document (out 1).
     *
     * This produces a followable output-0-spend chain that external resolvers
     * (WhatsOnChain, Teranode Universal Resolver) can discover.
     */
    async createDID(options?: DIDCreateOptions): Promise<DIDCreateResult> {
      try {
        const client = core.getClient()
        const safeOptions = snapshotDIDCreateOptions(options)
        const basket = safeOptions.basket ?? core.defaults.didBasket
        const identityCode = normalizeIdentityCode(
          safeOptions.identityCode ?? generateIdentityCode()
        )
        const protocolID = core.defaults.didProtocolID

        // Generate chain key — random PrivateKey for UTXO chain linking
        const chainKey = PrivateKey.fromRandom()
        const chainKeyHex = chainKey.toHex()
        const chainAddress = chainKey.toPublicKey().toAddress()

        // Derive subject key
        const subjectKey = await getPublicKeyOwnData(client, {
          protocolID,
          keyID: `${identityCode}-subject`,
          counterparty: 'anyone'
        })
        // Validate document inputs before creating the issuance transaction so
        // malformed service/controller data cannot leave an orphaned chain UTXO.
        const provisionalDID = `did:bsv:${'0'.repeat(64)}`
        DID.buildDocument(
          '0'.repeat(64),
          subjectKey,
          provisionalDID,
          bindRelativeServiceIds(safeOptions.services, provisionalDID)
        )

        // === TX0: Issuance (chain UTXO + OP_RETURN marker) ===
        const chainLockingScript = new P2PKH().lock(chainAddress).toHex()
        const opReturnIssuance = buildOpReturn(identityCode, '1')

        const issuanceTxid = await createActionOwnData(client, {
          description: `DID issuance (${identityCode})`,
          outputs: [
            {
              lockingScript: chainLockingScript,
              satoshis: 1,
              outputDescription: 'DID chain UTXO',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-issuance',
                identityCode,
                chainKeyHex,
                subjectKey,
                status: 'pending'
              }),
              tags: ['did', 'did-chain']
            },
            {
              lockingScript: opReturnIssuance.toHex(),
              satoshis: 0,
              outputDescription: 'DID issuance marker'
            }
          ],
          options: {
            randomizeOutputs: false,
            acceptDelayedBroadcast: false,
            returnTXIDOnly: true
          }
        })

        const did = DID.fromTxid(issuanceTxid)

        // Build document now that we know the DID
        const services = bindRelativeServiceIds(safeOptions.services, did)
        const document = DID.buildDocument(
          issuanceTxid,
          subjectKey,
          did, // self-sovereign: controller = self
          services
        )

        // === TX1: Document (spend issuance out 0 via signableTransaction) ===
        const issuanceOutpoint = `${issuanceTxid}.0`

        // Ensure issuance output is tracked in basket (retry up to 3x)
        let found = false
        for (let attempt = 0; attempt < 3; attempt++) {
          const listResult = await listOutputsOwnData(client, {
            basket,
            include: 'locking scripts',
            includeCustomInstructions: true
          })
          found = listResult.outputs.some(output => output.outpoint === issuanceOutpoint)
          if (found) break
          await new Promise(resolve => setTimeout(resolve, 500))
        }

        if (!found) {
          // eslint-disable-line @typescript-eslint/strict-boolean-expressions
          throw new DIDError('Issuance output not found in basket after retries')
        }

        const documentJson = JSON.stringify(document)
        const opReturnDocument = buildOpReturn(identityCode, documentJson)

        await spendChainOutput({
          client,
          basket,
          currentOutpoint: issuanceOutpoint,
          chainKeyHex,
          description: `DID document for ${did}`,
          newOutputs: [
            {
              lockingScript: new P2PKH().lock(chainAddress).toHex(),
              satoshis: 1,
              outputDescription: 'DID chain UTXO',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-document',
                did,
                identityCode,
                chainKeyHex,
                subjectKey,
                issuanceTxid,
                services,
                status: 'active'
              }),
              tags: ['did', 'did-chain']
            },
            {
              lockingScript: opReturnDocument.toHex(),
              satoshis: 0,
              outputDescription: 'DID Document'
            }
          ]
        })

        return {
          did,
          txid: issuanceTxid,
          identityCode,
          document
        }
      } catch (error) {
        if (error instanceof DIDError) throw error
        throw new DIDError(`DID creation failed: ${(error as Error).message}`)
      }
    },

    /**
     * Resolve a did:bsv DID to its DID Document.
     * Tries the configured authoritative resolver/proxy first, then the
     * authoritative WhatsOnChain transaction/spend view. Returned data is
     * bounded and structurally bound to the requested DID, but the current
     * response contract carries no cryptographic chain/freshness proof. Do
     * not use a remotely resolved key as sole authentication evidence.
     */
    async resolveDID(didString: string): Promise<DIDResolutionResult> {
      const parsed = DID.parse(didString)

      // Legacy pubkey-based DID — return legacy document immediately
      if (parsed.identifier.length === 66) {
        return resolveLegacyDID(parsed.identifier)
      }

      // Check local basket first — fastest resolution for our own DIDs
      try {
        const localResult = await this._resolveFromBasket(didString)
        if (localResult != null) return localResult
      } catch {
        // Fall through to external resolvers
      }

      // Try server-side proxy (bypasses CORS for browser clients)
      const proxyResult = await tryProxyResolver(
        didString,
        core.defaults.didProxyUrl,
        core.defaults.didFetch
      )
      if (proxyResult != null) return proxyResult

      // Try direct universal resolver (server-side SDK usage)
      const resolverResult = await tryDirectResolver(
        didString,
        core.defaults.didResolverUrl,
        core.defaults.didFetch
      )
      if (resolverResult != null) return resolverResult

      // WhatsOnChain direct fallback (server-side only — CORS-blocked in browsers)
      return await this._resolveViaWhatsOnChain(parsed.identifier)
    },

    /**
     * Resolve a DID from the local basket (for DIDs we own).
     * @internal
     */
    async _resolveFromBasket(didString: string): Promise<DIDResolutionResult | null> {
      const client = core.getClient()
      const basket = core.defaults.didBasket

      const listResult = await listOutputsOwnData(client, {
        basket,
        include: 'locking scripts',
        includeCustomInstructions: true
      })

      const latestCI = findLatestChainStateForDID(listResult.outputs, didString)

      if (latestCI == null) return null

      if (latestCI.status === 'deactivated') {
        return buildDeactivatedResolutionResult(latestCI, didString)
      }

      if (latestCI.subjectKey != null && latestCI.issuanceTxid != null) {
        return buildActiveResolutionResult(latestCI, didString)
      }

      return null
    },

    /**
     * Resolve a DID by following the UTXO chain on WhatsOnChain.
     * @internal
     */
    async _resolveViaWhatsOnChain(txid: string): Promise<DIDResolutionResult> {
      try {
        return await resolveChainOnWoC(txid, core.defaults.didFetch)
      } catch {
        return {
          didDocument: null,
          didDocumentMetadata: {},
          didResolutionMetadata: {
            error: 'internalError',
            message: 'WhatsOnChain resolution failed'
          }
        }
      }
    },

    /**
     * Update a DID document by spending the current chain UTXO.
     * Creates a new chain UTXO (out 0) + OP_RETURN with updated document (out 1).
     */
    async updateDID(options: DIDUpdateOptions): Promise<DIDCreateResult> {
      try {
        const safeOptions = snapshotDIDUpdateOptions(options)
        const client = core.getClient()
        DID.parse(safeOptions.did)
        const basket = core.defaults.didBasket

        const listResult = await listOutputsOwnData(client, {
          basket,
          include: 'locking scripts',
          includeCustomInstructions: true
        })

        const activeState = findActiveChainState(listResult.outputs, safeOptions.did)
        if (activeState == null) {
          throw new DIDError(`No active chain state found for ${safeOptions.did}`)
        }
        const { chainCI, chainOutpoint } = activeState
        const { identityCode, subjectKey, issuanceTxid, chainKeyHex } = chainCI
        if (typeof chainKeyHex !== 'string' || chainKeyHex === '') {
          throw new DIDError('Chain key not found in output metadata — cannot spend chain UTXO')
        }
        if (
          typeof identityCode !== 'string' ||
          typeof subjectKey !== 'string' ||
          typeof issuanceTxid !== 'string'
        ) {
          throw new DIDError('Stored DID state is incomplete')
        }

        const chainKey = PrivateKey.fromHex(chainKeyHex)
        const chainAddress = chainKey.toPublicKey().toAddress()

        const document = DID.buildDocument(
          issuanceTxid,
          subjectKey,
          safeOptions.did,
          safeOptions.services
        )
        if (safeOptions.additionalKeys != null) {
          appendAdditionalKeys(document, safeOptions.additionalKeys, safeOptions.did)
        }

        await spendChainOutput({
          client,
          basket,
          currentOutpoint: chainOutpoint,
          chainKeyHex,
          description: `DID update for ${safeOptions.did}`,
          newOutputs: [
            {
              lockingScript: new P2PKH().lock(chainAddress).toHex(),
              satoshis: 1,
              outputDescription: 'DID chain UTXO (updated)',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-update',
                did: safeOptions.did,
                identityCode,
                chainKeyHex,
                subjectKey,
                issuanceTxid,
                services: safeOptions.services,
                additionalKeys: safeOptions.additionalKeys,
                status: 'active'
              }),
              tags: ['did', 'did-chain']
            },
            {
              lockingScript: buildOpReturn(identityCode, JSON.stringify(document)).toHex(),
              satoshis: 0,
              outputDescription: 'DID Document (updated)'
            }
          ]
        })

        return { did: safeOptions.did, txid: issuanceTxid, identityCode, document }
      } catch (error) {
        if (error instanceof DIDError) throw error
        throw new DIDError(`DID update failed: ${(error as Error).message}`)
      }
    },

    /**
     * Deactivate (revoke) a DID by spending the chain UTXO.
     * Out 0: OP_RETURN revocation marker (chain terminates).
     * Out 1: P2PKH to wallet identity key (local bookkeeping).
     */
    async deactivateDID(didString: string): Promise<{ txid: string }> {
      try {
        const client = core.getClient()
        DID.parse(didString)
        const basket = core.defaults.didBasket

        const listResult = await listOutputsOwnData(client, {
          basket,
          include: 'locking scripts',
          includeCustomInstructions: true
        })

        const activeState = findActiveChainState(listResult.outputs, didString)
        if (activeState == null) {
          throw new DIDError(`No active chain state found for ${didString}`)
        }
        const { chainCI, chainOutpoint } = activeState
        const { identityCode, chainKeyHex } = chainCI
        if (
          typeof identityCode !== 'string' ||
          typeof chainKeyHex !== 'string' ||
          chainKeyHex === ''
        ) {
          throw new DIDError('Chain key not found in output metadata — cannot spend chain UTXO')
        }

        const result = await spendChainOutput({
          client,
          basket,
          currentOutpoint: chainOutpoint,
          chainKeyHex,
          description: `DID revocation for ${didString}`,
          newOutputs: [
            {
              lockingScript: buildOpReturn(identityCode, '3').toHex(),
              satoshis: 0,
              outputDescription: 'DID revocation marker'
            },
            {
              lockingScript: buildTrackingScript(),
              satoshis: 1,
              outputDescription: 'DID chain tracker (deactivated)',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-revocation',
                did: didString,
                identityCode,
                subjectKey: chainCI.subjectKey,
                issuanceTxid: chainCI.issuanceTxid,
                status: 'deactivated'
              }),
              tags: ['did', 'did-chain']
            }
          ]
        })

        return { txid: result.txid }
      } catch (error) {
        if (error instanceof DIDError) throw error
        throw new DIDError(`DID deactivation failed: ${(error as Error).message}`)
      }
    },

    /**
     * List all DIDs owned by this wallet.
     */
    async listDIDs(): Promise<DIDChainState[]> {
      try {
        const client = core.getClient()
        const basket = core.defaults.didBasket

        const listResult = await listOutputsOwnData(client, {
          basket,
          include: 'locking scripts',
          includeCustomInstructions: true
        })

        const didMap = new Map<string, DIDChainState>()

        for (const output of listResult.outputs) {
          const ci = parsedChainInstructions(output)
          if (ci == null) continue
          try {
            if (typeof ci.did !== 'string' || typeof ci.identityCode !== 'string') continue

            // Skip pending issuance outputs (consumed by document TX)
            if (ci.status === 'pending') continue

            const issuanceTxid =
              typeof ci.issuanceTxid === 'string' ? ci.issuanceTxid : ci.did.replace('did:bsv:', '')
            if (typeof output.outpoint !== 'string' || !/^[0-9a-f]{64}$/.test(issuanceTxid)) {
              continue
            }
            const created = typeof ci.created === 'string' ? ci.created : new Date().toISOString()
            const updated = typeof ci.updated === 'string' ? ci.updated : new Date().toISOString()

            // Always overwrite with the latest entry (later outputs = newer state)
            didMap.set(ci.did, {
              did: ci.did,
              identityCode: ci.identityCode,
              issuanceTxid,
              currentOutpoint: output.outpoint,
              status: ci.status === 'deactivated' ? 'deactivated' : 'active',
              created,
              updated
            })
          } catch {}
        }

        return Array.from(didMap.values())
      } catch (error) {
        throw new DIDError(`Failed to list DIDs: ${(error as Error).message}`)
      }
    },

    /**
     * @deprecated Use createDID() for spec-compliant DIDs.
     * Get this wallet's legacy DID Document (identity-key based).
     */
    getDID(): DIDDocument {
      return DID.fromIdentityKey(core.getIdentityKey()) // NOSONAR — deprecated method intentionally uses deprecated API
    },

    /**
     * @deprecated Use createDID() for spec-compliant DIDs.
     * Register a legacy DID as a BSV certificate.
     */
    async registerDID(options?: { persist?: boolean }): Promise<DIDDocument> {
      const { Certifier } = await import('./certification')
      const identityKey = core.getIdentityKey()
      const didDoc = DID.fromIdentityKey(identityKey) // NOSONAR — deprecated method intentionally uses deprecated API
      const safeOptions =
        options == null ? Object.create(null) : ownDataRecord(options, 'DID registration options')

      if (safeOptions.persist !== false) {
        try {
          const certifier = await Certifier.create({
            certificateType: DID.getCanonicalCertificateType()
          })

          await certifier.certify(core, {
            didId: didDoc.id,
            didType: 'identity',
            version: '1.0',
            created: new Date().toISOString(),
            isDID: 'true'
          })
        } catch (error) {
          throw new DIDError(`DID registration failed: ${(error as Error).message}`)
        }
      }

      return didDoc
    }
  }
}
