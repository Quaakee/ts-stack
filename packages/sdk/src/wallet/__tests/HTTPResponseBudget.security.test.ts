import { validateHTTPWalletJSONResponse } from '../WalletResultValidation.js'
import { MAX_WALLET_WIRE_FRAME_BYTES } from '../substrates/WalletWire.js'

describe('private HTTP snapshot resource accounting', () => {
  it('rechecks aggregate bytes added by historical normalization', () => {
    // The first walk validates but cannot classify this record because of its
    // safe non-enumerable field. Historical normalization subsequently creates
    // a byte array, which must be charged alongside the reused large buffer.
    const plaintext = Object.defineProperty({ 0: 7 }, 'note', { value: 9 })
    const payload = new Uint8Array(MAX_WALLET_WIRE_FRAME_BYTES)
    expect(() =>
      validateHTTPWalletJSONResponse('decrypt', { plaintext, payload }, undefined, { ok: true })
    ).toThrow(
      `Invalid HTTPWalletJSON decrypt response result byte arrays: expected at most ${MAX_WALLET_WIRE_FRAME_BYTES} total bytes`
    )
  }, 30_000)

  it('does not waive ordinary object graph limits around bytes', () => {
    const payload = [7, 8]
    const nested = Array.from({ length: 1_000_001 }, () => null)
    expect(() =>
      validateHTTPWalletJSONResponse('decrypt', { plaintext: payload, nested }, undefined, {
        ok: true
      })
    ).toThrow('at most 1000000 entries')
  })
})
