import { PublicKey } from '@bsv/sdk'
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import { DIDDocumentV2, DIDResolutionResult, DIDService, DIDVerificationMethodV2 } from './types'

const DID_CONTEXT = 'https://www.w3.org/ns/did/v1'
const DID_CONTENT_TYPE = 'application/did+ld+json'
const MAX_DID_METHODS = 32
const MAX_DID_SERVICES = 32
const MAX_DID_STRING_BYTES = 2048

type PlainRecord = Record<string, unknown>

function dataRecord(value: unknown): PlainRecord | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const result = Object.create(null) as PlainRecord
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor)) return undefined
    result[key] = descriptor.value
  }
  return result
}

function boundedString(value: unknown, name: string, maximum = MAX_DID_STRING_BYTES): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum
  ) {
    throw new TypeError(`Invalid ${name}`)
  }
  return value
}

function denseArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`Invalid ${name}`)
  const output: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || !('value' in descriptor)) throw new TypeError(`Invalid ${name}`)
    output.push(descriptor.value)
  }
  return output
}

function canonicalBase64Url(value: unknown, name: string): string {
  const encoded = boundedString(value, name, 43)
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new TypeError(`Invalid ${name}`)
  const base64 = `${encoded.split('-').join('+').split('_').join('/')}=`
  let bytes: number[]
  try {
    bytes = toArray(base64, 'base64')
  } catch {
    throw new TypeError(`Invalid ${name}`)
  }
  const canonical = toBase64(bytes).split('+').join('-').split('/').join('_').replace(/=+$/, '')
  if (bytes.length !== 32 || canonical !== encoded) throw new TypeError(`Invalid ${name}`)
  return encoded
}

function validateJwk(value: unknown): DIDVerificationMethodV2['publicKeyJwk'] {
  const jwk = dataRecord(value)
  if (jwk == null || jwk.kty !== 'EC' || jwk.crv !== 'secp256k1') {
    throw new TypeError('Invalid DID verification JWK')
  }
  const x = canonicalBase64Url(jwk.x, 'DID JWK x coordinate')
  const y = canonicalBase64Url(jwk.y, 'DID JWK y coordinate')
  const xBytes = toArray(`${x.split('-').join('+').split('_').join('/')}=`, 'base64')
  const yBytes = toArray(`${y.split('-').join('+').split('_').join('/')}=`, 'base64')
  const compressed = `${(yBytes[31] & 1) === 0 ? '02' : '03'}${toHex(xBytes)}`
  const point = PublicKey.fromString(compressed)
  if (toHex(point.getY().toArray('be', 32)) !== toHex(yBytes)) {
    throw new TypeError('Invalid DID verification JWK')
  }
  return { kty: 'EC', crv: 'secp256k1', x, y }
}

function validateMethod(value: unknown, did: string): DIDVerificationMethodV2 {
  const method = dataRecord(value)
  if (method == null) throw new TypeError('Invalid DID verification method')
  const id = boundedString(method.id, 'DID verification method identifier', 512)
  const controller = boundedString(method.controller, 'DID verification controller', 512)
  if (
    !id.startsWith(`${did}#`) ||
    !controller.startsWith('did:') ||
    method.type !== 'JsonWebKey2020'
  ) {
    throw new TypeError('Invalid DID verification method')
  }
  return { id, type: 'JsonWebKey2020', controller, publicKeyJwk: validateJwk(method.publicKeyJwk) }
}

type MethodRelationship = DIDDocumentV2['authentication'][number]

function validateMethodRelationship(value: unknown, did: string, name: string): MethodRelationship {
  return typeof value === 'string' ? boundedString(value, name, 512) : validateMethod(value, did)
}

function sameMethod(left: DIDVerificationMethodV2, right: DIDVerificationMethodV2): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.controller === right.controller &&
    left.publicKeyJwk.kty === right.publicKeyJwk.kty &&
    left.publicKeyJwk.crv === right.publicKeyJwk.crv &&
    left.publicKeyJwk.x === right.publicKeyJwk.x &&
    left.publicKeyJwk.y === right.publicKeyJwk.y
  )
}

function relationshipId(value: MethodRelationship): string {
  return typeof value === 'string' ? value : value.id
}

function validateService(value: unknown, did: string): DIDService {
  const service = dataRecord(value)
  if (service == null) throw new TypeError('Invalid DID service')
  const id = boundedString(service.id, 'DID service identifier', 512)
  const type = boundedString(service.type, 'DID service type', 128)
  const serviceEndpoint = boundedString(service.serviceEndpoint, 'DID service endpoint')
  let endpoint: URL
  try {
    endpoint = new URL(serviceEndpoint)
  } catch {
    throw new TypeError('Invalid DID service endpoint')
  }
  if (
    !id.startsWith(`${did}#`) ||
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    throw new TypeError('Invalid DID service')
  }
  return { id, type, serviceEndpoint: endpoint.toString() }
}

export function validateDIDDocument(value: unknown, did: string): DIDDocumentV2 {
  const document = dataRecord(value)
  if (document == null || document.id !== did)
    throw new TypeError('DID document does not match the requested DID')
  const contexts =
    typeof document['@context'] === 'string'
      ? [document['@context']]
      : denseArray(document['@context'], 'DID context', 8)
  if (!contexts.every(context => typeof context === 'string') || !contexts.includes(DID_CONTEXT)) {
    throw new TypeError('Invalid DID context')
  }
  const verificationMethod = denseArray(
    document.verificationMethod,
    'DID verification methods',
    MAX_DID_METHODS
  ).map(method => validateMethod(method, did))
  if (verificationMethod.length < 1) throw new TypeError('DID document has no verification method')
  const methodIds = new Set(verificationMethod.map(method => method.id))
  if (methodIds.size !== verificationMethod.length)
    throw new TypeError('Duplicate DID verification method')
  const methodsById = new Map(verificationMethod.map(method => [method.id, method]))
  const embeddedMethodsById = new Map<string, DIDVerificationMethodV2>()
  const authentication = denseArray(
    document.authentication,
    'DID authentication methods',
    MAX_DID_METHODS
  ).map(reference => validateMethodRelationship(reference, did, 'DID authentication reference'))
  const assertionMethod =
    document.assertionMethod == null
      ? undefined
      : denseArray(document.assertionMethod, 'DID assertion methods', MAX_DID_METHODS).map(
          reference => validateMethodRelationship(reference, did, 'DID assertion reference')
        )

  for (const relationship of [
    authentication,
    ...(assertionMethod == null ? [] : [assertionMethod])
  ]) {
    const ids = relationship.map(relationshipId)
    if (new Set(ids).size !== ids.length) {
      throw new TypeError('Duplicate DID verification relationship')
    }
    for (const entry of relationship) {
      if (typeof entry === 'string') {
        // Embedded methods authorize only the relationship that contains them.
        // String references must dereference through verificationMethod, never
        // through a method embedded in a different relationship.
        if (!methodsById.has(entry)) throw new TypeError('Invalid DID verification reference')
        continue
      }
      const existing = methodsById.get(entry.id) ?? embeddedMethodsById.get(entry.id)
      if (existing != null && !sameMethod(existing, entry)) {
        throw new TypeError('Conflicting DID verification method')
      }
      embeddedMethodsById.set(entry.id, entry)
    }
  }
  if (authentication.length < 1) {
    throw new TypeError('Invalid DID authentication method')
  }
  const service =
    document.service == null
      ? undefined
      : denseArray(document.service, 'DID services', MAX_DID_SERVICES).map(entry =>
          validateService(entry, did)
        )
  if (service != null && new Set(service.map(entry => entry.id)).size !== service.length) {
    throw new TypeError('Duplicate DID service')
  }
  const controller =
    document.controller == null
      ? undefined
      : boundedString(document.controller, 'DID controller', 512)
  if (controller != null && !controller.startsWith('did:'))
    throw new TypeError('Invalid DID controller')
  return {
    '@context': contexts.length === 1 ? (contexts[0] as string) : (contexts as string[]),
    id: did,
    ...(controller == null ? {} : { controller }),
    verificationMethod,
    authentication,
    ...(assertionMethod == null ? {} : { assertionMethod }),
    ...(service == null ? {} : { service })
  }
}

function optionalIsoDate(value: unknown, name: string): string | undefined {
  if (value == null) return undefined
  const encoded = boundedString(value, name, 32)
  const milliseconds = Date.parse(encoded)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== encoded) {
    throw new TypeError(`Invalid ${name}`)
  }
  return encoded
}

function optionalTxid(value: unknown, name: string): string | undefined {
  if (value == null) return undefined
  const encoded = boundedString(value, name, 64)
  if (!/^[0-9a-f]{64}$/.test(encoded)) throw new TypeError(`Invalid ${name}`)
  return encoded
}

export function validateDIDResolutionResult(value: unknown, did: string): DIDResolutionResult {
  const result = dataRecord(value)
  const documentMetadata = dataRecord(result?.didDocumentMetadata)
  const resolutionMetadata = dataRecord(result?.didResolutionMetadata)
  if (result == null || documentMetadata == null || resolutionMetadata == null) {
    throw new TypeError('Invalid DID resolution result')
  }
  const didDocument =
    result.didDocument == null ? null : validateDIDDocument(result.didDocument, did)
  const deactivated = documentMetadata.deactivated
  if (deactivated != null && typeof deactivated !== 'boolean')
    throw new TypeError('Invalid DID deactivation state')
  const error = resolutionMetadata.error
  if (error != null && !['notFound', 'notYetAvailable', 'internalError'].includes(String(error))) {
    throw new TypeError('Invalid DID resolution error')
  }
  const message =
    resolutionMetadata.message == null
      ? undefined
      : boundedString(resolutionMetadata.message, 'DID resolution message', 512)
  const contentType = resolutionMetadata.contentType
  if (contentType != null && contentType !== DID_CONTENT_TYPE)
    throw new TypeError('Invalid DID resolution content type')
  if (didDocument != null && error != null) throw new TypeError('Conflicting DID resolution result')
  return {
    didDocument,
    didDocumentMetadata: {
      ...(optionalIsoDate(documentMetadata.created, 'DID creation time') == null
        ? {}
        : { created: optionalIsoDate(documentMetadata.created, 'DID creation time') }),
      ...(optionalIsoDate(documentMetadata.updated, 'DID update time') == null
        ? {}
        : { updated: optionalIsoDate(documentMetadata.updated, 'DID update time') }),
      ...(deactivated == null ? {} : { deactivated }),
      ...(optionalTxid(documentMetadata.versionId, 'DID version') == null
        ? {}
        : { versionId: optionalTxid(documentMetadata.versionId, 'DID version') }),
      ...(optionalTxid(documentMetadata.nextVersionId, 'next DID version') == null
        ? {}
        : {
            nextVersionId: optionalTxid(documentMetadata.nextVersionId, 'next DID version')
          })
    },
    didResolutionMetadata: {
      ...(contentType == null ? {} : { contentType: DID_CONTENT_TYPE }),
      ...(error == null ? {} : { error: String(error) }),
      ...(message == null ? {} : { message })
    }
  }
}
