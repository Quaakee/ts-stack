import { DIDStorageManager } from './DIDStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { decodeCanonicalDIDToken } from '@bsv/sdk'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireBase64,
  requireLookupQuery,
  requireOutpoint
} from '../shared/queryValidation.js'

export class DIDLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: DIDStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_did') return

    // Revalidate at the persistence boundary; callers can invoke a lookup
    // service independently of a colocated topic manager.
    const { serialNumber } = decodeCanonicalDIDToken(lockingScript)

    await this.storageManager.storeRecord(txid, outputIndex, serialNumber)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_did') return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_did', [
      'serialNumber',
      'outpoint',
      'limit',
      'skip',
      'sortOrder',
      'startDate',
      'endDate'
    ])
    const serialNumber = requireBase64(
      readString(query, 'serialNumber', { maxBytes: 344 }),
      'serialNumber'
    )
    const outpoint = requireOutpoint(readString(query, 'outpoint', { maxBytes: 75 }))

    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const sortOrder = readSortOrder(query)
    const startDate = readDate(query, 'startDate')
    const endDate = readDate(query, 'endDate')
    if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
      throw new Error('Invalid lookup query: startDate must not follow endDate')
    }
    return await this.storageManager.findRecords(
      {
        serialNumber,
        txid: outpoint?.txid,
        outputIndex: outpoint?.outputIndex,
        startDate,
        endDate
      },
      limit,
      skip,
      sortOrder
    )
  }

  async getDocumentation(): Promise<string> {
    return 'DID Lookup Service: finds canonical legacy DID tokens by serial number or outpoint. The v1 wire format does not establish issuer or subject authority.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'DID Lookup Service',
      shortDescription: 'DID resolution made easy.'
    }
  }
}

function create(db: Db): DIDLookupService {
  return new DIDLookupService(new DIDStorageManager(db))
}
export default create
