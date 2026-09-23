import { toArray, toBase64, toUTF8 } from '../../primitives/utils.js'
import {
  WalletInterface,
  WalletCounterparty,
  Base64String,
  OriginatorDomainNameStringUnder250Bytes
} from '../../wallet/Wallet.interfaces.js'

/**
 * Verifies that a challenge token was derived from the wallet.
 *
 * A successful result does not establish freshness, expiry, single use, or
 * asymmetric proof of key ownership. Use the complete BRC-103 handshake or a
 * signed, expiring payload for authentication.
 * @param nonce - A nonce to verify as a base64 string.
 * @param wallet
 * @param counterparty - The counterparty to the nonce creation. Defaults to 'self'.
 * @returns The status of the validation
 */
export async function verifyNonce(
  nonce: Base64String,
  wallet: WalletInterface,
  counterparty: WalletCounterparty = 'self',
  originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<boolean> {
  if (
    typeof nonce !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(nonce)
  ) {
    return false
  }

  let buffer: number[]
  try {
    buffer = toArray(nonce, 'base64')
  } catch {
    return false
  }
  if (buffer.length !== 48 || toBase64(buffer) !== nonce) return false

  // Split the nonce buffer
  const data = buffer.slice(0, 16)
  const hmac = buffer.slice(16)

  // Calculate the HMAC
  const { valid } = await wallet.verifyHmac(
    {
      data,
      hmac,
      protocolID: [2, 'server hmac'],
      keyID: toUTF8(data),
      counterparty
    },
    originator
  )

  return valid === true
}
