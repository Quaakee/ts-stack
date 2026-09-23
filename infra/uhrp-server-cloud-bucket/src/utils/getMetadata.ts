// /utils/getMetadata.ts
import { Storage } from '@google-cloud/storage'
import { PublicKey, StorageUtils } from '@bsv/sdk'
import { normalizeUhrpPagination } from '../resourceLimits'
import { listVerifiedAdvertisements } from './storedAdvertisements'

const storage = new Storage()
const { GCP_BUCKET_NAME } = process.env

interface FileMetadata {
  objectIdentifier: string
  name: string
  size: string
  contentType: string
  expiryTime: number  // minutes since the Unix epoch
}

/**
 * Finds the 'objectIdentifier' by scanning the 'uhrp advertisements' basket
 * for a matching `uhrp_url_{uhrpUrl}` tag, then fetches GCS metadata.
 *
 * @param uhrpUrl The UHRP URL
 * @returns {Promise<FileMetadata>} An object containing file info.
 * @throws If no matching advertisement is found or GCS metadata fails.
 */
export async function getMetadata(uhrpUrl: string, uploaderIdentityKey: string, limit?: number, offset?: number): Promise<FileMetadata> {
  if (typeof uhrpUrl !== 'string' || uhrpUrl.length < 1 || uhrpUrl.length > 256) throw new Error('Invalid UHRP URL')
  const canonicalUrl = StorageUtils.getURLForHash(StorageUtils.getHashFromURL(uhrpUrl))
  if (typeof uploaderIdentityKey !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/i.test(uploaderIdentityKey)) {
    throw new Error('Invalid uploader identity key')
  }
  const identityKey = PublicKey.fromString(uploaderIdentityKey).toString().toLowerCase()
  const pagination = normalizeUhrpPagination(limit, offset)
  const { advertisements } = await listVerifiedAdvertisements({
    uhrpUrl: canonicalUrl,
    uploaderIdentityKey: identityKey,
    ...pagination
  })
  const selected = advertisements.reduce<typeof advertisements[number] | undefined>(
    (farthest, candidate) => farthest == null || candidate.metadata.expiryTime > farthest.metadata.expiryTime ? candidate : farthest,
    undefined
  )
  if (selected == null) {
    throw new Error(`No authenticated advertisement found for uhrpUrl: ${canonicalUrl}`)
  }
  if (Date.now() > selected.metadata.expiryTime * 1000) {
    throw new Error(`Advertisement for uhrpUrl: ${canonicalUrl} has expired`)
  }

  const file = storage.bucket(GCP_BUCKET_NAME!).file(`cdn/${selected.metadata.objectIdentifier}`)
  const [gcsMetadata] = await file.getMetadata()
  const gcsSize = typeof gcsMetadata.size === 'string' ? Number(gcsMetadata.size) : gcsMetadata.size
  if (!Number.isSafeInteger(gcsSize) || gcsSize !== selected.metadata.fileSize) {
    throw new Error('GCS object size does not match the authenticated advertisement')
  }

  return {
    objectIdentifier: selected.metadata.objectIdentifier,
    name: gcsMetadata.name ?? `cdn/${selected.metadata.objectIdentifier}`,
    size: String(selected.metadata.fileSize),
    contentType: selected.metadata.contentType,
    expiryTime: selected.metadata.expiryTime
  }
}
