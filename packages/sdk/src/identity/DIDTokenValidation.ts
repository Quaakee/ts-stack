import PublicKey from '../primitives/PublicKey.js'
import { toArray, toBase64 } from '../primitives/utils.js'
import type LockingScript from '../script/LockingScript.js'
import { decodeCanonicalPushDrop } from '../script/templates/PushDropValidation.js'
import type { Base64String, WalletProtocol } from '../wallet/Wallet.interfaces.js'

export const DID_TOKEN_PROTOCOL: WalletProtocol = [2, 'did token']
export const MAX_DID_SERIAL_BYTES = 256

export interface CanonicalDIDToken {
  serialBytes: number[]
  serialNumber: Base64String
  lockingPublicKey: PublicKey
  signature: number[]
}

/**
 * Preserve the historical DID client's Base64 decoding behavior while
 * returning the single canonical spelling of the resulting on-chain bytes.
 */
export function normalizeDIDSerialNumber(value: unknown): Base64String {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    throw new Error('DID serial number must be a bounded Base64 string')
  }
  const serialBytes = toArray(value, 'base64')
  if (serialBytes.length < 1 || serialBytes.length > MAX_DID_SERIAL_BYTES) {
    throw new Error(`DID serial number must contain 1-${MAX_DID_SERIAL_BYTES} bytes`)
  }
  return toBase64(serialBytes)
}

/**
 * Decode a canonical legacy DID token. The v1 wire token does not identify an
 * issuer or subject, so its counterparty-derived field signature cannot be
 * verified from public token bytes alone.
 */
export function decodeCanonicalDIDToken(lockingScript: LockingScript): CanonicalDIDToken {
  const { fields, lockingPublicKey } = decodeCanonicalPushDrop(lockingScript, {
    fieldCount: 2,
    maximumFieldBytes: MAX_DID_SERIAL_BYTES,
    maximumPayloadBytes: MAX_DID_SERIAL_BYTES + 80
  })
  const serialBytes = fields[0]
  if (serialBytes.length < 1 || serialBytes.length > MAX_DID_SERIAL_BYTES) {
    throw new Error('DID token contains an invalid serial number')
  }
  return {
    serialBytes,
    serialNumber: toBase64(serialBytes),
    lockingPublicKey,
    signature: fields[1]
  }
}
