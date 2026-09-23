import { toHex, toUTF8Strict } from '@bsv/sdk/primitives/utils'
import {
  decodeCanonicalPushDrop,
  LockingScript,
  ProtoWallet,
  PublicKey,
  type WalletProtocol
} from '@bsv/sdk'
export type DiscoveryProtocol = 'SHIP' | 'SLAP'

export interface VerifiedDiscoveryAdvertisement {
  protocol: DiscoveryProtocol
  identityKey: string
  domain: string
  topicOrService: string
}

const MAX_DISCOVERY_FIELD_BYTES = 4096
const MAX_DISCOVERY_PAYLOAD_BYTES = 8192
const namePattern: Record<DiscoveryProtocol, RegExp> = {
  SHIP: /^(?=.{1,50}$)tm_[a-z]+(?:_[a-z]+)*$/,
  SLAP: /^(?=.{1,50}$)ls_[a-z]+(?:_[a-z]+)*$/
}

function walletProtocol(protocol: DiscoveryProtocol): WalletProtocol {
  return [2, protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability']
}

/** Decode and authenticate one canonical SHIP or SLAP PushDrop advertisement. */
export async function decodeAndVerifyDiscoveryAdvertisement(
  lockingScript: LockingScript,
  expectedProtocol: DiscoveryProtocol
): Promise<VerifiedDiscoveryAdvertisement> {
  const decoded = decodeCanonicalPushDrop(lockingScript, {
    fieldCount: 5,
    maximumFieldBytes: MAX_DISCOVERY_FIELD_BYTES,
    maximumPayloadBytes: MAX_DISCOVERY_PAYLOAD_BYTES
  })
  const protocol = toUTF8Strict(decoded.fields[0])
  if (protocol !== expectedProtocol) throw new Error('Discovery advertisement protocol mismatch')
  const identityKey = toHex(decoded.fields[1])
  if (
    !/^(?:02|03)[0-9a-f]{64}$/.test(identityKey) ||
    PublicKey.fromString(identityKey).toString() !== identityKey
  ) {
    throw new Error('Discovery advertisement identity key is invalid')
  }
  const domain = toUTF8Strict(decoded.fields[2])
  if (
    new TextEncoder().encode(domain).byteLength < 1 ||
    new TextEncoder().encode(domain).byteLength > 4096
  ) {
    throw new Error('Discovery advertisement domain is invalid')
  }
  const topicOrService = toUTF8Strict(decoded.fields[3])
  if (!namePattern[expectedProtocol].test(topicOrService)) {
    throw new Error('Discovery advertisement name is invalid')
  }

  const protocolID = walletProtocol(expectedProtocol)
  const wallet = new ProtoWallet('anyone')
  const { valid } = await wallet.verifySignature({
    data: decoded.fields.slice(0, -1).flat(),
    signature: decoded.fields.at(-1)!,
    counterparty: identityKey,
    protocolID,
    keyID: '1'
  })
  if (valid !== true) throw new Error('Discovery advertisement signature is invalid')
  const { publicKey: expectedLockingKey } = await wallet.getPublicKey({
    counterparty: identityKey,
    protocolID,
    keyID: '1'
  })
  if (expectedLockingKey !== decoded.lockingPublicKey.toString()) {
    throw new Error('Discovery advertisement locking key is not linked to its identity')
  }

  return { protocol: expectedProtocol, identityKey, domain, topicOrService }
}
