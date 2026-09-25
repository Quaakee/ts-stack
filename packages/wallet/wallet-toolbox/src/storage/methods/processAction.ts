// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
  Beef,
  Transaction as BsvTransaction,
  SendWithResult,
  SendWithResultStatus,
  WalletLoggerInterface,
  TelemetrySpan
} from '@bsv/sdk'
import {
  admitExactResumes,
  commitExactResumes,
  ExactResumeCandidate,
  isExactResume,
  lockExactResumeBinding,
  planExactResumes
} from './resumeFailedSendWith'
import { aggregateActionResults } from '../../utility/aggregateResults'
import { StorageProvider } from '../StorageProvider'
import {
  AuthId,
  ReviewActionResult,
  StorageProcessActionArgs,
  StorageProcessActionResults
} from '../../sdk/WalletStorage.interfaces'
import { stampLog } from '../../utility/stampLog'
import {
  randomBytesBase64,
  verifyId,
  verifyInteger,
  verifyOne,
  verifyOneOrNone,
  verifyTruthy
} from '../../utility/utilityHelpers'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { WERR_INTERNAL, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { TableProvenTxReq } from '../schema/tables/TableProvenTxReq'
import { TableProvenTx } from '../schema/tables/TableProvenTx'
import { ProvenTxReqStatus, TransactionStatus } from '../../sdk/types'
import { parseTxScriptOffsets, TxScriptOffsets } from '../../utility/parseTxScriptOffsets'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { TableOutput } from '../schema/tables/TableOutput'
import { asArray, asString } from '../../utility/utilityHelpers.noBuffer'
import { WalletError } from '../../sdk/WalletError'
import { classifyReqStatus } from '../storageProviderHelpers'

export async function processAction(
  storage: StorageProvider,
  auth: AuthId,
  args: StorageProcessActionArgs
): Promise<StorageProcessActionResults> {
  if (!storage.telemetry.enabled) return await processActionCore(storage, auth, args)
  return await storage.telemetry.withSpan(
    'wallet.storage.process_action',
    {
      component: 'wallet-storage',
      carrier: args,
      attributes: {
        'action.is_new_transaction': args.isNewTx,
        'action.is_no_send': args.isNoSend,
        'action.is_delayed': args.isDelayed,
        'action.send_with_count': args.sendWith.length
      }
    },
    async span => {
      const result = await processActionCore(storage, auth, args, span)
      span.end({ attributes: { 'action.send_result_count': result.sendWithResults?.length ?? 0 } })
      return result
    }
  )
}

async function processActionCore(
  storage: StorageProvider,
  auth: AuthId,
  args: StorageProcessActionArgs,
  parent?: TelemetrySpan
): Promise<StorageProcessActionResults> {
  const logger = args.logger
  logger?.group('storage processAction')

  const userId = verifyId(auth.userId)
  const r: StorageProcessActionResults = {
    sendWithResults: undefined
  }

  let req: EntityProvenTxReq | undefined
  const txidsOfReqsToShareWithWorld: string[] = [...args.sendWith]

  if (args.isNewTx) {
    const vargs = await traceProcessStep(
      storage,
      'wallet.storage.process_action.validate',
      parent,
      async () => await validateCommitNewTxToStorageArgs(storage, userId, args)
    )
    logger?.log('validated new tx updates to storage')
    ;({ req } = await traceProcessStep(
      storage,
      'wallet.storage.process_action.commit',
      parent,
      async () => await commitNewTxToStorage(storage, userId, vargs)
    ))
    logger?.log('committed new tx updates to storage ')
    if (!req) throw new WERR_INTERNAL()
    // Add the new txid to sendWith unless there are no others to send and the noSend option is set.
    if (args.isNoSend && !args.isSendWith) {
      logger?.log(`noSend txid ${req.txid}`)
    } else {
      txidsOfReqsToShareWithWorld.push(req.txid)
      logger?.log(`sending txid ${req.txid}`)
    }
  }

  // #589: exact retries are only planned (read-only) here. The share admits them from its one
  // lookup and commits them, all in one transaction, before anything is scheduled or posted.
  const exactResumes = await planExactResumes(storage, userId, args.sendWith)

  const { swr, ndr } = await traceProcessStep(
    storage,
    'wallet.storage.process_action.share',
    parent,
    async () =>
      await shareSendWithSet(
        storage,
        userId,
        txidsOfReqsToShareWithWorld,
        args.isDelayed,
        undefined,
        logger,
        exactResumes
      )
  )

  r.sendWithResults = swr
  r.notDelayedResults = ndr

  logger?.groupEnd()

  return r
}

async function traceProcessStep<T>(
  storage: StorageProvider,
  name: string,
  parent: TelemetrySpan | undefined,
  callback: () => Promise<T>
): Promise<T> {
  if (parent == null) return await callback()
  return await storage.telemetry.withSpan(name, { component: 'wallet-storage', parent: parent.context }, callback)
}

export interface GetReqsAndBeefDetail {
  txid: string
  req?: TableProvenTxReq
  proven?: TableProvenTx
  status: 'readyToSend' | 'alreadySent' | 'error' | 'unknown'
  error?: string
}

export interface GetReqsAndBeefResult {
  beef: Beef
  details: GetReqsAndBeefDetail[]
  /** Internal fast path: this exact BEEF instance already passed validation. */
  verified?: boolean
}

export interface PostBeefResultForTxidApi {
  txid: string

  /**
   * 'success' - The transaction was accepted for processing
   */
  status: 'success' | 'error'

  /**
   * if true, the transaction was already known to this service. Usually treat as a success.
   *
   * Potentially stop posting to additional transaction processors.
   */
  alreadyKnown?: boolean

  blockHash?: string
  blockHeight?: number
  merklePath?: string
}

/**
 * Verifies that all the txids are known reqs with ready-to-share status.
 * Assigns a batch identifier and updates all the provenTxReqs.
 * If not isDelayed, triggers an initial attempt to broadcast the batch and returns the results.
 *
 * @param storage
 * @param userId
 * @param txids
 * @param isDelayed
 * @param r Optional. Ignores txids and allows ProvenTxReqs and merged beef to be passed in.
 */
function classifyReqDetails(
  details: GetReqsAndBeefDetail[],
  swr: SendWithResult[],
  readyToSendReqs: EntityProvenTxReq[]
): void {
  for (const getReq of details) {
    let status: SendWithResultStatus = 'failed'
    if (getReq.status === 'alreadySent') {
      status = 'unproven'
    } else if (getReq.status === 'readyToSend') {
      status = 'sending'
      readyToSendReqs.push(new EntityProvenTxReq(getReq.req))
    }
    swr.push({ txid: getReq.txid, status })
  }
}

async function verifyMergedBeef(
  storage: StorageProvider,
  r: GetReqsAndBeefResult,
  readyToSendReqs: EntityProvenTxReq[],
  logger?: WalletLoggerInterface
): Promise<void> {
  if (readyToSendReqs.length === 0 || r.verified === true) return
  const beefIsValid = await r.beef.verify(await storage.getServices().getChainTracker())
  if (!beefIsValid) {
    logger?.error(`VERIFY FALSE BEEF: ${r.beef.toLogString()}`)
    throw new WERR_INTERNAL('merged Beef failed validation.')
  }
  logger?.log('beef is valid')
}

async function getReqDetailsForDelayedShare(storage: StorageProvider, txids: string[]): Promise<GetReqsAndBeefResult> {
  const r: GetReqsAndBeefResult = {
    beef: new Beef(),
    details: []
  }

  for (const txid of txids) {
    const d: GetReqsAndBeefDetail = {
      txid,
      status: 'unknown'
    }
    r.details.push(d)
    try {
      d.proven = verifyOneOrNone(await storage.findProvenTxs({ partial: { txid } }))
      if (d.proven != null) {
        d.status = 'alreadySent'
        continue
      }

      d.req = verifyOneOrNone(await storage.findProvenTxReqs({ partial: { txid } }))
      if (d.req == null) {
        d.status = 'error'
        d.error = `ERR_UNKNOWN_TXID: ${txid} was not found.`
      } else {
        classifyReqStatus(d, d.req)
      }
    } catch (error_: unknown) {
      const e = WalletError.fromUnknown(error_)
      d.error = `${e.name}: ${e.message}`
    }
  }

  return r
}

export async function shareReqsWithWorld(
  storage: StorageProvider,
  userId: number,
  txids: string[],
  isDelayed: boolean,
  r?: GetReqsAndBeefResult,
  logger?: WalletLoggerInterface
): Promise<{ swr: SendWithResult[]; ndr: ReviewActionResult[] | undefined }> {
  return await shareSendWithSet(storage, userId, txids, isDelayed, r, logger, [])
}

/**
 * #589: each admitted retry's request, as committed or as another caller left it, replaces the
 * planned failed one only while it stays sendable, or is marked unproven when already sent.
 * Anything else throws inside the commit transaction, which then commits no retry at all.
 */
function reconcileCommittedResumes(
  committed: EntityProvenTxReq[],
  readyToSendReqs: EntityProvenTxReq[],
  swr: SendWithResult[]
): void {
  for (const req of committed) {
    const detail: GetReqsAndBeefDetail = { txid: req.txid, status: 'unknown' }
    classifyReqStatus(detail, req.toApi())
    const index = readyToSendReqs.findIndex(ready => ready.txid === req.txid)
    if (index < 0) throw new WERR_INTERNAL('An admitted exact retry is missing from its set.')
    if (detail.status === 'readyToSend') {
      readyToSendReqs[index] = req
    } else if (detail.status === 'alreadySent') {
      readyToSendReqs.splice(index, 1)
      swr.find(result => result.txid === req.txid)!.status = 'unproven'
    } else {
      throw new WERR_INVALID_OPERATION('Exact retry state changed before it could be committed.')
    }
  }
}

async function shareSendWithSet(
  storage: StorageProvider,
  userId: number,
  txids: string[],
  isDelayed: boolean,
  r: GetReqsAndBeefResult | undefined,
  logger: WalletLoggerInterface | undefined,
  exactResumes: ExactResumeCandidate[]
): Promise<{ swr: SendWithResult[]; ndr: ReviewActionResult[] | undefined }> {
  const swr: SendWithResult[] = []
  const ndr: ReviewActionResult[] | undefined = undefined

  if (r == null && txids.length < 1) return { swr, ndr }

  r ??= isDelayed
    ? await getReqDetailsForDelayedShare(storage, txids)
    : await storage.getReqsAndBeefToShareWithWorld(txids, [])

  // #589: this one lookup is the only decision for the set. A planned retry is sendable only while
  // the lookup still shows its planned failed request and every other member already is sendable;
  // it is committed below, before anything is scheduled or posted, so the results reported here
  // and the persisted state cannot disagree.
  const admitted = admitExactResumes(r, exactResumes, isDelayed)

  const readyToSendReqs: EntityProvenTxReq[] = []
  classifyReqDetails(r.details, swr, readyToSendReqs)

  const readyToSendReqIds = readyToSendReqs.map(r => r.id)

  const batch = txids.length > 1 ? randomBytesBase64(16) : undefined
  if (isDelayed) {
    // Delayed sends rebuild BEEF when the monitor sends the req. Do not fail a committed
    // transaction here because the current aggregate BEEF is only a scheduling artifact.
    if (readyToSendReqIds.length > 0) {
      await storage.transaction(async trx => {
        // #589: retries commit in the same transaction that schedules their set.
        if (admitted.length > 0)
          reconcileCommittedResumes(await commitExactResumes(storage, userId, admitted, trx), readyToSendReqs, swr)
        const ordinary = readyToSendReqs.filter(req => !isExactResume(req))
        if (ordinary.length > 0) {
          await storage.updateProvenTxReq(
            ordinary.map(req => req.id),
            { status: 'unsent', batch },
            trx
          )
          await storage.updateTransaction(
            ordinary.flatMap(req => req.notify.transactionIds ?? []),
            { status: 'sending' },
            trx
          )
        }
        for (const req of readyToSendReqs.filter(isExactResume)) {
          const action = await lockExactResumeBinding(storage, req, trx, userId)
          if (['unmined', 'completed', 'callback', 'unconfirmed'].includes(req.status)) {
            swr.find(result => result.txid === req.txid)!.status = 'unproven'
            continue
          }
          if (!['unsent', 'sending'].includes(req.status))
            throw new WERR_INVALID_OPERATION('Exact retry state changed during delayed scheduling.')
          await storage.updateProvenTxReq(req.id, { status: 'unsent', batch }, trx)
          await storage.updateTransaction(action.transactionId, { status: 'sending' }, trx)
        }
      })
    }
    return { swr, ndr }
  }

  if (readyToSendReqIds.length < 1) return { swr, ndr }

  for (const req of readyToSendReqs.filter(isExactResume))
    await storage.transaction(async trx => {
      await lockExactResumeBinding(storage, req, trx, userId)
    })

  await verifyMergedBeef(storage, r, readyToSendReqs, logger)

  if (admitted.length > 0) {
    // #589: admitted retries commit only after every check above, and in the same transaction
    // as every exact binding's revalidation and the set's batch, so nothing between this commit
    // and the post below can refuse the set.
    await storage.transaction(async trx => {
      reconcileCommittedResumes(await commitExactResumes(storage, userId, admitted, trx), readyToSendReqs, swr)
      for (const req of readyToSendReqs.filter(isExactResume)) await lockExactResumeBinding(storage, req, trx, userId)
      if (batch && readyToSendReqs.length > 0)
        await storage.updateProvenTxReq(
          readyToSendReqs.map(req => req.id),
          { batch },
          trx
        )
    })
    if (readyToSendReqs.length < 1) return { swr, ndr }
  }

  if (batch) {
    for (const req of readyToSendReqs) req.batch = batch
    if (admitted.length === 0) await storage.updateProvenTxReq(readyToSendReqIds, { batch })
  }

  const prtn = await storage.attemptToPostReqsToNetwork(readyToSendReqs, undefined, logger)
  const { swr: swrRes, rar } = await aggregateActionResults(storage, swr, prtn)
  return { swr: swrRes, ndr: rar }
}

interface ReqTxStatus {
  req: ProvenTxReqStatus
  tx: TransactionStatus
}

function determineReqTxStatus(params: Pick<StorageProcessActionArgs, 'isNoSend' | 'isSendWith' | 'isDelayed'>): {
  status: ReqTxStatus
  postStatus: ReqTxStatus | undefined
} {
  if (params.isNoSend && !params.isSendWith) return { status: { req: 'nosend', tx: 'nosend' }, postStatus: undefined }
  if (!params.isNoSend && params.isDelayed)
    return { status: { req: 'unsent', tx: 'unprocessed' }, postStatus: undefined }
  if (!params.isNoSend && !params.isDelayed) {
    return {
      status: { req: 'unprocessed', tx: 'unprocessed' },
      postStatus: { req: 'unmined', tx: 'unproven' }
    }
  }
  throw new WERR_INTERNAL('logic error')
}

function buildOutputUpdates(storage: StorageProvider, tx: BsvTransaction, vargs: ValidCommitNewTxToStorageArgs): void {
  for (const o of vargs.outputOutputs) {
    const vout = verifyInteger(o.vout)
    const offset = vargs.txScriptOffsets.outputs[vout]
    const rawTxScript = asString(vargs.rawTx.slice(offset.offset, offset.offset + offset.length))
    if (o.lockingScript != null && rawTxScript !== asString(o.lockingScript)) {
      throw new WERR_INVALID_OPERATION(
        `rawTx output locking script for vout ${vout} not equal to expected output script.`
      )
    }
    if (tx.outputs[vout].lockingScript.toHex() !== rawTxScript) {
      throw new WERR_INVALID_OPERATION(
        `parsed transaction output locking script for vout ${vout} not equal to expected output script.`
      )
    }
    const update: Partial<TableOutput> = {
      txid: vargs.txid,
      spendable: true, // spendability is gated by transaction status. Remains true until the output is spent.
      scriptLength: offset.length,
      scriptOffset: offset.offset
    }
    if (offset.length > storage.getSettings().maxOutputScript)
    // Remove long lockingScript data from outputs table, will be read from rawTx in proven_tx or proven_tx_reqs tables.
    {
      update.lockingScript = undefined
    }
    vargs.outputUpdates.push({ id: o.outputId, update })
  }
}

interface ValidCommitNewTxToStorageArgs {
  // validated input args

  reference: string
  txid: string
  rawTx: number[]
  isNoSend: boolean
  isDelayed: boolean
  isSendWith: boolean
  log?: string

  // validated dependent args

  tx: BsvTransaction
  txScriptOffsets: TxScriptOffsets
  transactionId: number
  transaction: TableTransaction
  outputOutputs: TableOutput[]

  req: EntityProvenTxReq
  outputUpdates: Array<{ id: number; update: Partial<TableOutput> }>
  transactionUpdate: Partial<TableTransaction>
  postStatus?: ReqTxStatus
}

async function validateCommitNewTxToStorageArgs(
  storage: StorageProvider,
  userId: number,
  params: StorageProcessActionArgs
): Promise<ValidCommitNewTxToStorageArgs> {
  if (!params.reference || !params.txid || params.rawTx == null) {
    throw new WERR_INVALID_OPERATION('One or more expected params are undefined.')
  }
  const rawTx = asArray(params.rawTx)
  let tx: BsvTransaction
  try {
    tx = BsvTransaction.fromBinary(rawTx)
  } catch {
    throw new WERR_INVALID_OPERATION('Parsing serialized transaction failed.')
  }
  if (params.txid !== tx.id('hex')) {
    throw new WERR_INVALID_OPERATION("Hash of serialized transaction doesn't match expected txid")
  }
  const services = storage.getServices()
  if (!(await services.nLockTimeIsFinal(tx))) {
    throw new WERR_INVALID_OPERATION(`This transaction is not final.
         Ensure that the transaction meets the rules for being a finalized
         which can be found at https://wiki.bitcoinsv.io/index.php/NLocktime_and_nSequence`)
  }
  const txScriptOffsets = parseTxScriptOffsets(rawTx)
  const transaction = verifyOne(
    await storage.findTransactions({
      partial: { userId, reference: params.reference }
    })
  )
  if (!transaction.isOutgoing) throw new WERR_INVALID_OPERATION('isOutgoing is not true')
  if (transaction.inputBEEF == null) throw new WERR_INVALID_OPERATION()
  // Transaction must have unsigned or unprocessed status
  if (transaction.status !== 'unsigned' && transaction.status !== 'unprocessed') {
    throw new WERR_INVALID_OPERATION(`invalid transaction status ${transaction.status}`)
  }
  const transactionId = verifyId(transaction.transactionId)
  // These reads are independent once the planned transaction is resolved.
  // Running them together removes two network-database round trips from every
  // successful remote-storage commit.
  const [outputOutputs, commissionRows] = await Promise.all([
    storage.findOutputs({ partial: { userId, transactionId } }),
    storage.commissionSatoshis > 0
      ? storage.findCommissions({ partial: { transactionId, userId } })
      : Promise.resolve([])
  ])

  const commission = verifyOneOrNone(commissionRows)
  if (storage.commissionSatoshis > 0) {
    // A commission is required...
    if (commission == null) throw new WERR_INTERNAL()
    const commissionValid = tx.outputs.some(
      x => x.satoshis === commission.satoshis && x.lockingScript.toHex() === asString(commission.lockingScript)
    )
    if (!commissionValid) {
      throw new WERR_INVALID_OPERATION('Transaction did not include an output to cover service fee.')
    }
  }

  const req = EntityProvenTxReq.fromTxid(params.txid, rawTx, transaction.inputBEEF)
  req.addNotifyTransactionId(transactionId)

  // "Processing" a transaction is the final step of creating a new one.
  // If it is to be sent to the network directly (prior to return from processAction),
  // then there is status pre-send and post-send.
  // Otherwise there is no post-send status.
  // Note that isSendWith trumps isNoSend, e.g. isNoSend && !isSendWith
  //
  // Determine what status the req and transaction should have pre- at the end of processing.
  //                           Pre-Status (to newReq/newTx)     Post-Status (to all sent reqs/txs)
  //                           req         tx                   req                 tx
  // isNoSend                  noSend      noSend
  // !isNoSend && isDelayed    unsent      unprocessed
  // !isNoSend && !isDelayed   unprocessed unprocessed          sending/unmined     sending/unproven      This is the only case that sends immediately.
  const { status, postStatus } = determineReqTxStatus(params)

  req.status = status.req
  const vargs: ValidCommitNewTxToStorageArgs = {
    reference: params.reference,
    txid: params.txid,
    rawTx,
    isSendWith: !!params.sendWith && params.sendWith.length > 0,
    isDelayed: params.isDelayed,
    isNoSend: params.isNoSend,
    // Properties with values added during validation.
    tx,
    txScriptOffsets,
    transactionId,
    transaction,
    outputOutputs,
    req,
    outputUpdates: [],
    // update txid, status in transactions table and drop rawTransaction value
    transactionUpdate: {
      txid: params.txid,
      rawTx: undefined,
      inputBEEF: undefined,
      status: status.tx
    },
    postStatus
  }

  // update outputs with txid, script offsets and lengths, drop long output scripts from outputs table
  // outputs spendable will be updated for change to true and all others to !!o.tracked when tx has been broadcast
  // MAX_OUTPUTSCRIPT_LENGTH is limit for scripts left in outputs table
  buildOutputUpdates(storage, tx, vargs)

  return vargs
}

export interface CommitNewTxResults {
  req: EntityProvenTxReq
  log?: string
}

async function commitNewTxToStorage(
  storage: StorageProvider,
  userId: number,
  vargs: ValidCommitNewTxToStorageArgs
): Promise<CommitNewTxResults> {
  let log = vargs.log

  log = stampLog(log, 'start storage commitNewTxToStorage')

  let req: EntityProvenTxReq | undefined

  await storage.transaction(async trx => {
    log = stampLog(log, '... storage commitNewTxToStorage storage transaction start')

    // Create initial 'nosend' proven_tx_req record to store signed, valid rawTx and input beef
    req = await vargs.req.insertOrMerge(storage, trx)

    log = stampLog(log, '... storage commitNewTxToStorage req inserted')

    for (const ou of vargs.outputUpdates) {
      await storage.updateOutput(ou.id, ou.update, trx)
    }

    log = stampLog(log, '... storage commitNewTxToStorage outputs updated')

    await storage.updateTransaction(vargs.transactionId, vargs.transactionUpdate, trx)

    log = stampLog(log, '... storage commitNewTxToStorage storage transaction end')
  })

  log = stampLog(log, '... storage commitNewTxToStorage storage transaction await done')

  const r: CommitNewTxResults = {
    req: verifyTruthy(req),
    log
  }

  log = stampLog(log, 'end storage commitNewTxToStorage')

  return r
}
