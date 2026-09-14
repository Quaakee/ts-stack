import { Base64String, PubKeyHex, HexString } from '@bsv/sdk'
import { ProvenTxReqStatus, SyncStatus, TransactionStatus } from '../../sdk'
import {
  TableCertificate,
  TableCertificateField,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSyncState,
  TableSettings,
  TableTransaction,
  TableTxLabel,
  TableTxLabelMap,
  TableUser
} from './tables'
import { TableActionBatch, TableActionBatchBlob, TableActionBatchOutput } from './tables/TableActionBatch'

export interface StorageIdbSchema {
  action_batches: {
    key: number
    value: TableActionBatch
    indexes: {
      userId: number
      userId_batchId: [number, string]
      expiresAt: Date
    }
  }
  action_batch_outputs: {
    key: number
    value: TableActionBatchOutput
    indexes: {
      actionBatchId: number
    }
  }
  action_batch_blobs: {
    key: [number, string]
    value: TableActionBatchBlob
    indexes: {
      actionBatchId: number
    }
  }
  certificates: {
    key: number
    value: TableCertificate
    indexes: {
      updated_at: Date
      userId: number
      userId_type_certifier_serialNumber: [number, Base64String, PubKeyHex, Base64String]
    }
  }
  certificateFields: {
    key: number
    value: TableCertificateField
    indexes: {
      updated_at: Date
      userId: number
      certificateId: number
    }
  }
  commissions: {
    key: number
    value: TableCommission
    indexes: {
      updated_at: Date
      userId: number
      transactionId: number
    }
  }
  monitorEvents: {
    key: number
    value: TableMonitorEvent
  }
  outputs: {
    key: number
    value: TableOutput
    indexes: {
      updated_at: Date
      userId: number
      userId_basketId: [number, number]
      txid_vout_userId: [string, number, number]
      transactionId: number
      basketId: number
      spentBy: string
      transactionId_vout_userId: [number, number, number]
    }
  }
  outputBaskets: {
    key: number
    value: TableOutputBasket
    indexes: {
      updated_at: Date
      userId: number
      name_userId: [string, number]
    }
  }
  outputTags: {
    key: number
    value: TableOutputTag
    indexes: {
      updated_at: Date
      userId: number
      tag_userId: [string, number]
    }
  }
  outputTagMaps: {
    key: number
    value: TableOutputTagMap
    indexes: {
      updated_at: Date
      outputTagId: number
      outputId: number
    }
  }
  provenTxs: {
    key: number
    value: TableProvenTx
    indexes: {
      updated_at: Date
      txid: HexString
    }
  }
  provenTxReqs: {
    key: number
    value: TableProvenTxReq
    indexes: {
      updated_at: Date
      provenTxId: number
      txid: HexString
      provenTxReqId_txid: [number, string]
      status: ProvenTxReqStatus
      batch: string
    }
  }
  syncStates: {
    key: number
    value: TableSyncState
    indexes: {
      userId: number
      refNum: string
      status: SyncStatus
    }
  }
  settings: {
    key: number
    value: TableSettings
    indexes: Record<string, never>
  }
  transactions: {
    key: number
    value: TableTransaction
    indexes: {
      updated_at: Date
      userId: number
      txid_userId: [string, number]
      provenTxId: number
      provenTxId_userId: [number, number]
      reference: string
      status: TransactionStatus
      noSendExpiryState: string
      noSendExpiryReclaimTxid: string
    }
  }
  txLabels: {
    key: number
    value: TableTxLabel
    indexes: {
      updated_at: Date
      userId: number
      label_userId: [string, number]
    }
  }
  txLabelMaps: {
    key: number
    value: TableTxLabelMap
    indexes: {
      updated_at: Date
      transactionId: number
      txLabelId: number
    }
  }
  users: {
    key: number
    value: TableUser
    indexes: {
      identityKey: string
    }
  }
}
