import { Collection, Db, Filter } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { DIDRecord } from './types.js'
import { Base64String } from '@bsv/sdk'
import { LookupFormula } from '@bsv/overlay'

export class DIDStorageManager {
  private readonly records: Collection<DIDRecord>

  private readonly indexes = new CollectionIndexes('DIDStorageManager', () => [
    {
      label: 'txid_outputIndex_unique',
      collection: this.records,
      keys: { txid: 1, outputIndex: 1 },
      options: { unique: true }
    },
    {
      label: 'serialNumber_createdAt',
      collection: this.records,
      keys: { serialNumber: 1, createdAt: -1 }
    }
  ])

  constructor(private readonly db: Db) {
    this.records = db.collection<DIDRecord>('didRecords')
  }

  private async ensureIndexes(): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord(txid: string, outputIndex: number, serialNumber: Base64String): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne(
      { txid, outputIndex },
      { $set: { serialNumber }, $setOnInsert: { txid, outputIndex, createdAt: new Date() } },
      { upsert: true }
    )
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findRecords(
    query: {
      serialNumber?: Base64String
      txid?: string
      outputIndex?: number
      startDate?: Date
      endDate?: Date
    },
    limit: number,
    skip: number,
    sortOrder: 'asc' | 'desc'
  ): Promise<LookupFormula> {
    await this.ensureIndexes()
    const filter: Filter<DIDRecord> = {}
    if (query.serialNumber !== undefined) filter.serialNumber = query.serialNumber
    if (query.txid !== undefined) filter.txid = query.txid
    if (query.outputIndex !== undefined) filter.outputIndex = query.outputIndex
    if (query.startDate !== undefined || query.endDate !== undefined) {
      filter.createdAt = {
        ...(query.startDate === undefined ? {} : { $gte: query.startDate }),
        ...(query.endDate === undefined ? {} : { $lte: query.endDate })
      }
    }
    const direction = sortOrder === 'asc' ? 1 : -1
    const results = await this.records
      .find(filter)
      .sort({ createdAt: direction, txid: direction, outputIndex: direction })
      .skip(skip)
      .limit(limit)
      .project({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map((record: any) => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
