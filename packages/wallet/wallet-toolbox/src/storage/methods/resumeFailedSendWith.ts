import { Beef, Transaction } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

/** A retry is consent to publish these exact bytes, never to build another action. */
export function isExactResume(req: EntityProvenTxReq): boolean {
  return req.history.notes?.some(note => note.what === 'exactSendWithResume') === true
}

/** Reclaim a failed action only when its persisted signed lineage is unambiguous. */
export async function resumeFailedSendWith(storage: StorageProvider, userId: number, txids: string[]): Promise<void> {
  for (const txid of new Set(txids)) {
    const rows = await storage.findProvenTxReqs({ partial: { txid } })
    if (rows.length !== 1 || !['invalid', 'doubleSpend', 'unknown', 'unfail'].includes(rows[0].status)) continue
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
    await storage.transaction(async trx => {
      // An actual UPDATE acquires the request row's write lock also on MySQL;
      // transaction reads alone do not serialize concurrent retries there.
      await storage.updateProvenTxReq(original.provenTxReqId, { updated_at: new Date() }, trx)
      // Acquire every owned row lock before the first snapshot read. Under
      // MySQL REPEATABLE READ, re-reading after a later lock can return an old
      // snapshot and mistakenly steal an input allocated by another action.
      await storage.updateTransaction(preparedAction.transactionId, { updated_at: new Date() }, trx)
      for (const id of [...lockedOutputIds].sort((a, b) => a - b))
        await storage.updateOutput(id, { updated_at: new Date() }, trx)
      const current = await storage.findProvenTxReqs({ partial: { txid }, trx })
      if (current.length !== 1) throw new WERR_INVALID_OPERATION('Exact retry request became ambiguous.')
      const req = new EntityProvenTxReq(current[0])
      if (!['invalid', 'doubleSpend', 'unknown', 'unfail'].includes(req.status)) return
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
      if (
        outputs.length !== raw.outputs.length ||
        new Set(outputs.map(output => output.vout)).size !== raw.outputs.length
      )
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
        if (!lockedOutputIds.has(output.outputId))
          throw new WERR_INVALID_OPERATION('Exact retry input lineage changed.')
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
    })
  }
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
