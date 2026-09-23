process.env.SERVER_PRIVATE_KEY = '55'.repeat(32)

const {
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Utils
} = require('@bsv/sdk')
const {
  advertisementTags,
  createAdvertisementMetadata,
  requireAdvertisementTags,
  verifyAdvertisementMetadata
} = require('../advertisementMetadata')

const serverWallet = new ProtoWallet(new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex'))
const uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
const hash = Array.from({ length: 32 }, (_, index) => index)
const objectIdentifier = '3mJr7AoUXx2Wqd'
const hostedFileLocation = `https://files.example/cdn/${objectIdentifier}`

async function fixture() {
  const identity = await serverWallet.getPublicKey({ identityKey: true })
  const script = await new PushDrop(serverWallet).lock(
    [
      Utils.toArray(identity.publicKey, 'hex'),
      hash,
      Utils.toArray(hostedFileLocation, 'utf8'),
      new Utils.Writer().writeVarIntNum(2_000_000_000).toArray(),
      new Utils.Writer().writeVarIntNum(100).toArray()
    ],
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )
  const signed = createAdvertisementMetadata({
    objectIdentifier,
    uploaderIdentityKey,
    hostedFileLocation,
    hash,
    expiryTime: 2_000_000_000,
    fileSize: 100,
    contentType: 'application/octet-stream'
  })
  return { script, signed }
}

test('accepts server-signed ownership metadata only when it matches the token', async () => {
  const { script, signed } = await fixture()
  await expect(verifyAdvertisementMetadata(signed.customInstructions, script)).resolves.toEqual(
    signed.metadata
  )
  expect(() => requireAdvertisementTags(advertisementTags(signed.metadata), signed.metadata)).not.toThrow()
})

test('rejects unsigned legacy metadata and edited owner fields', async () => {
  const { script, signed } = await fixture()
  await expect(verifyAdvertisementMetadata(undefined, script)).rejects.toThrow('metadata is missing')

  const envelope = JSON.parse(signed.customInstructions)
  envelope.metadata.uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
  await expect(verifyAdvertisementMetadata(JSON.stringify(envelope), script)).rejects.toThrow(
    'signature is invalid'
  )
})

test('rejects relabeled wallet tags after signature verification', async () => {
  const { signed } = await fixture()
  const tags = advertisementTags(signed.metadata).map(tag =>
    tag.startsWith('uploader_identity_key_')
      ? `uploader_identity_key_${PrivateKey.fromRandom().toPublicKey().toString()}`
      : tag
  )
  expect(() => requireAdvertisementTags(tags, signed.metadata)).toThrow('do not match')
})
