import { Beef, Transaction } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { TableProvenTxReq } from '../schema/tables/TableProvenTxReq'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { GetReqsAndBeefResult } from './processAction'

const resumableStatuses = ['invalid', 'doubleSpend', 'unknown', 'unfail']

/** A retry is consent to publish these exact bytes, never to build another action. */
export function isExactResume(req: EntityProvenTxReq): boolean {
  return req.history.notes?.some(note => note.what === 'exactSendWithResume') === true
}

/** A failed request whose signed lineage was validated read-only and can be requeued. */
export interface ExactResumeCandidate {
  txid: string
  original: TableProvenTxReq
  raw: Transaction
  /** The BEEF, resolved from storage and verified during planning, that an immediate share posts. */
  beef: Beef
  preparedAction: TableTransaction
  lockedOutputIds: Set<number>
}

/**
 * Plan the exact retries in a sendWith set, read-only: nothing is committed here (#589).
 * Every candidate is planned before any is committed, so a refused candidate commits no retry.
 */
export async function planExactResumes(
  storage: StorageProvider,
  userId: number,
  txids: string[]
): Promise<ExactResumeCandidate[]> {
  const candidates: ExactResumeCandidate[] = []
  for (const txid of new Set(txids)) {
    const candidate = await planExactResume(storage, userId, txid)
    if (candidate != null) candidates.push(candidate)
  }
  return candidates
}

/**
 * Admit planned retries into the share's one lookup `r` (#589).
 *
 * A candidate is admitted only while `r` still shows its planned failed request, and only when
 * every other member of `r` is already sendable or already sent. This base shares the ready part of
 * an incomplete set (and an immediate share then throws), so a retry must never join one. Admitted
 * details become `readyToSend` (an immediate share also merges their planned, verified BEEF into
 * `r.beef`), so the share's classification reads this same decision. Otherwise `r` keeps the
 * failed details, the share reports every candidate as failed and no retry is ever committed.
 */
export function admitExactResumes(
  r: GetReqsAndBeefResult,
  candidates: ExactResumeCandidate[],
  isDelayed: boolean
): ExactResumeCandidate[] {
  const detailOf = (txid: string) => r.details.find(detail => detail.txid === txid)
  const admitted = candidates.filter(candidate => {
    const detail = detailOf(candidate.txid)
    return (
      detail?.status === 'error' &&
      detail.proven == null &&
      detail.req?.provenTxReqId === candidate.original.provenTxReqId &&
      resumableStatuses.includes(detail.req.status)
    )
  })
  if (admitted.length === 0) return []
  const admittedTxids = new Set(admitted.map(candidate => candidate.txid))
  if (
    !r.details.every(
      detail => detail.status === 'alreadySent' || detail.status === 'readyToSend' || admittedTxids.has(detail.txid)
    )
  )
    return []
  for (const candidate of admitted) {
    if (!isDelayed) r.beef.mergeBeef(candidate.beef.toBinary())
    detailOf(candidate.txid)!.status = 'readyToSend'
  }
  return admitted
}

/**
 * Commit every admitted retry inside the caller's one storage transaction, all or nothing (#589).
 *
 * Every row lock of every candidate is taken before the first snapshot read, then each candidate
 * runs every check of a single retry; any refusal throws and rolls back all of them. A request
 * that another caller already moved out of a failed status is left unchanged and returned as
 * found, for the share to reconcile within the same transaction.
 */
export async function commitExactResumes(
  storage: StorageProvider,
  userId: number,
  candidates: ExactResumeCandidate[],
  trx: TrxToken
): Promise<EntityProvenTxReq[]> {
  const ascending = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b)
  // An actual UPDATE acquires the request row's write lock also on MySQL;
  // transaction reads alone do not serialize concurrent retries there.
  for (const id of ascending(candidates.map(candidate => candidate.original.provenTxReqId)))
    await storage.updateProvenTxReq(id, { updated_at: new Date() }, trx)
  // Acquire every owned row lock before the first snapshot read. Under
  // MySQL REPEATABLE READ, re-reading after a later lock can return an old
  // snapshot and mistakenly steal an input allocated by another action.
  for (const id of ascending(candidates.map(candidate => candidate.preparedAction.transactionId)))
    await storage.updateTransaction(id, { updated_at: new Date() }, trx)
  for (const id of ascending(candidates.flatMap(candidate => [...candidate.lockedOutputIds])))
    await storage.updateOutput(id, { updated_at: new Date() }, trx)
  const current: EntityProvenTxReq[] = []
  for (const candidate of candidates) current.push(await commitExactResume(storage, userId, candidate, trx))
  return current
}

async function planExactResume(
  storage: StorageProvider,
  userId: number,
  txid: string
): Promise<ExactResumeCandidate | undefined> {
  const rows = await storage.findProvenTxReqs({ partial: { txid } })
  if (rows.length !== 1 || !resumableStatuses.includes(rows[0].status)) return undefined
  const original = rows[0]
  const raw = Transaction.fromBinary(original.rawTx)
  if (raw.id('hex') !== txid || original.inputBEEF == null || raw.inputs.length === 0)
    throw new WERR_INVALID_OPERATION('Exact retry requires matching signed transaction and input BEEF.')
  const beef = new Beef()
  // Persisted input BEEF can omit locally known ancestry. Resolve it exactly
  // as ordinary sharing does, outside the storage write transaction.
  await storage.mergeReqToBeefToShareExternally(original, beef, [])
  if (!(await Transaction.fromBEEF(beef.toBinary(), txid).verify(await storage.getServices().getChainTracker())))
    throw new WERR_INVALID_OPERATION('Exact retry could not validate stored signed transaction.')

  const preparedTransactions = await storage.findTransactions({ partial: { txid } })
  if (preparedTransactions.length !== 1) throw new WERR_INVALID_OPERATION('Exact retry requires one action.')
  const preparedAction = preparedTransactions[0]
  const preparedOutputs = await storage.findOutputs({ partial: { transactionId: preparedAction.transactionId } })
  const preparedInputs = (
    await Promise.all(
      raw.inputs.map(input =>
        storage.findOutputs({
          partial: { userId, txid: input.sourceTXID, vout: input.sourceOutputIndex }
        })
      )
    )
  ).flat()
  const lockedOutputIds = new Set([...preparedInputs, ...preparedOutputs].map(output => output.outputId))
  return { txid, original, raw, beef, preparedAction, lockedOutputIds }
}

async function commitExactResume(
  storage: StorageProvider,
  userId: number,
  { txid, original, raw, preparedAction, lockedOutputIds }: ExactResumeCandidate,
  trx: TrxToken
): Promise<EntityProvenTxReq> {
  const current = await storage.findProvenTxReqs({ partial: { txid }, trx })
  if (current.length !== 1) throw new WERR_INVALID_OPERATION('Exact retry request became ambiguous.')
  const req = new EntityProvenTxReq(current[0])
  if (!resumableStatuses.includes(req.status)) return req
  if (
    JSON.stringify(req.rawTx) !== JSON.stringify(original.rawTx) ||
    JSON.stringify(req.inputBEEF) !== JSON.stringify(original.inputBEEF)
  )
    throw new WERR_INVALID_OPERATION('Exact retry signed material changed.')
  const transactions = await storage.findTransactions({ partial: { txid }, trx })
  if (
    transactions.length !== 1 ||
    transactions[0].userId !== userId ||
    !transactions[0].isOutgoing ||
    !['failed', 'unfail'].includes(transactions[0].status)
  )
    throw new WERR_INVALID_OPERATION('Exact retry requires one owned failed outgoing action.')
  const action = transactions[0]
  if (action.transactionId !== preparedAction.transactionId)
    throw new WERR_INVALID_OPERATION('Exact retry action changed.')
  if (action.rawTx != null && JSON.stringify(action.rawTx) !== JSON.stringify(original.rawTx))
    throw new WERR_INVALID_OPERATION('Exact retry action bytes disagree with its request.')
  if (req.notify.transactionIds?.length !== 1 || req.notify.transactionIds[0] !== action.transactionId)
    throw new WERR_INVALID_OPERATION('Exact retry notification lineage is inconsistent.')
  const outputs = await storage.findOutputs({ partial: { transactionId: action.transactionId }, trx })
  if (outputs.length !== raw.outputs.length || new Set(outputs.map(output => output.vout)).size !== raw.outputs.length)
    throw new WERR_INVALID_OPERATION('Exact retry requires every signed output exactly once.')
  for (const output of outputs) {
    const signed = raw.outputs[output.vout]
    if (
      output.userId !== userId ||
      !Number.isInteger(output.vout) ||
      !lockedOutputIds.has(output.outputId) ||
      !signed ||
      output.txid !== txid ||
      output.satoshis !== signed.satoshis ||
      output.spentBy != null ||
      (output.lockingScript != null &&
        JSON.stringify(output.lockingScript) !== JSON.stringify(signed.lockingScript.toBinary()))
    )
      throw new WERR_INVALID_OPERATION('Exact retry output lineage is inconsistent or allocated.')
  }
  for (const input of raw.inputs) {
    const matches = await storage.findOutputs({
      partial: { userId, txid: input.sourceTXID, vout: input.sourceOutputIndex },
      trx
    })
    if (matches.length > 1) throw new WERR_INVALID_OPERATION('Exact retry input lineage is ambiguous.')
    if (matches.length === 0) continue // A supplied external input need not be a wallet output.
    const output = matches[0]
    if (!lockedOutputIds.has(output.outputId)) throw new WERR_INVALID_OPERATION('Exact retry input lineage changed.')
    const locked = output
    if (
      (locked.spentBy != null && locked.spentBy !== action.transactionId) ||
      (!locked.spendable && locked.spentBy !== action.transactionId)
    )
      throw new WERR_INVALID_OPERATION('Exact retry input is unavailable or allocated to another action.')
    await storage.updateOutput(output.outputId, { spendable: false, spentBy: action.transactionId }, trx)
  }
  // Match ordinary signed-action bookkeeping; transaction status still gates availability.
  for (const output of outputs) await storage.updateOutput(output.outputId, { spendable: true }, trx)
  req.status = 'unsent'
  req.attempts = 0
  req.notified = false
  req.addHistoryNote({
    what: 'exactSendWithResume',
    when: new Date().toISOString(),
    transactionId: action.transactionId,
    userId
  })
  await req.updateStorageDynamicProperties(storage, trx)
  await storage.updateTransaction(action.transactionId, { status: 'sending' }, trx)
  return req
}

/** Revalidate the durable authorization after every asynchronous boundary. */
export async function lockExactResumeBinding(
  storage: StorageProvider,
  req: EntityProvenTxReq,
  trx: TrxToken,
  expectedUserId?: number
): Promise<TableTransaction> {
  const markers = req.history.notes?.filter(note => note.what === 'exactSendWithResume') ?? []
  const binding = markers[markers.length - 1]
  if (
    binding == null ||
    typeof binding.userId !== 'number' ||
    typeof binding.transactionId !== 'number' ||
    (expectedUserId != null && binding.userId !== expectedUserId) ||
    markers.some(note => note.userId !== binding.userId || note.transactionId !== binding.transactionId)
  )
    throw new WERR_INVALID_OPERATION('Exact retry authorization binding is missing or ambiguous.')
  await storage.updateProvenTxReq(req.id, { updated_at: new Date() }, trx)
  await storage.updateTransaction(binding.transactionId, { updated_at: new Date() }, trx)
  await req.refreshFromStorage(storage, trx)
  const currentMarkers = req.history.notes?.filter(note => note.what === 'exactSendWithResume') ?? []
  const actions = await storage.findTransactions({ partial: { txid: req.txid }, trx })
  if (
    currentMarkers.length === 0 ||
    currentMarkers.some(note => note.userId !== binding.userId || note.transactionId !== binding.transactionId) ||
    req.notify.transactionIds?.length !== 1 ||
    req.notify.transactionIds[0] !== binding.transactionId ||
    actions.length !== 1 ||
    actions[0].transactionId !== binding.transactionId ||
    actions[0].userId !== binding.userId ||
    !actions[0].isOutgoing
  )
    throw new WERR_INVALID_OPERATION('Exact retry authorization became shared or inconsistent.')
  return actions[0]
}
