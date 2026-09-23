import PrivateKey from '../../primitives/PrivateKey.js'
import * as Utils from '../../primitives/utils.js'
import PushDrop from '../../script/templates/PushDrop.js'
import ProtoWallet from '../../wallet/ProtoWallet.js'
import {
  decodeCanonicalDIDToken,
  DID_TOKEN_PROTOCOL,
  normalizeDIDSerialNumber
} from '../DIDTokenValidation.js'

describe('DID token validation', () => {
  it('accepts a canonical wallet-signed token', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const subject = PrivateKey.fromRandom().toPublicKey().toString()
    const serialNumber = Utils.toBase64(Utils.toArray('serial-123', 'utf8'))
    const serialBytes = Utils.toArray(serialNumber, 'base64')
    const script = await new PushDrop(issuer as any).lock(
      [serialBytes],
      DID_TOKEN_PROTOCOL,
      'prefix suffix',
      subject
    )

    expect(decodeCanonicalDIDToken(script)).toMatchObject({ serialNumber })
  })

  it('preserves the opaque signature and rejects non-canonical trailing script', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const subject = PrivateKey.fromRandom().toPublicKey().toString()
    const script = await new PushDrop(issuer as any).lock(
      [[1, 2, 3]],
      DID_TOKEN_PROTOCOL,
      'prefix suffix',
      subject
    )
    const changedSignature = [...script.chunks[3].data!]
    changedSignature[changedSignature.length - 1] ^= 1
    script.chunks[3].data = changedSignature
    expect(decodeCanonicalDIDToken(script).signature).toEqual(changedSignature)

    const canonical = await new PushDrop(issuer as any).lock(
      [[1, 2, 3]],
      DID_TOKEN_PROTOCOL,
      'other prefix',
      subject
    )
    canonical.chunks.push({ op: 0x61 })
    expect(() => decodeCanonicalDIDToken(canonical)).toThrow('canonical PushDrop')
  })

  it('normalizes historical Base64 spellings and bounds decoded bytes', () => {
    expect(normalizeDIDSerialNumber('c2VyaWFs')).toBe('c2VyaWFs')
    expect(() => normalizeDIDSerialNumber('A'.repeat(1025))).toThrow('bounded')
    expect(() => normalizeDIDSerialNumber('')).toThrow('bounded')
  })
})
