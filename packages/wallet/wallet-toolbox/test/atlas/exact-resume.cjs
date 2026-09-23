const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { knex } = require('knex')
const { PrivateKey, CachedKeyDeriver, Beef, Script, Transaction } = require('@bsv/sdk')
const { StorageKnex, WalletStorageManager, Wallet, Monitor, MockServices } = require('../../src/index.ts')
async function main() {
  let walletDb = knex({
    client: 'better-sqlite3',
    connection: { filename: join(mkdtempSync(join(tmpdir(), 'atlas-exact-wallet-')), 'wallet.sqlite') },
    useNullAsDefault: true
  })
  const chainDb = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  const services = new MockServices(chainDb)
  await services.initialize()
  let active = new StorageKnex({
    chain: 'mock',
    knex: walletDb,
    commissionSatoshis: 0,
    commissionPubKeyHex: undefined,
    feeModel: { model: 'sat/kb', value: 1 }
  })
  active.setServices(services)
  await active.migrate('atlas_wallet_failure_probe', `02${'11'.repeat(32)}`)
  await active.makeAvailable()

  const root = PrivateKey.fromHex('1'.repeat(64))
  const identityKey = root.toPublicKey().toString()
  let manager = new WalletStorageManager(identityKey, active)
  await manager.makeAvailable()
  const { user } = await active.findOrInsertUser(identityKey)
  let monitor = new Monitor({
    chain: 'mock',
    storage: manager,
    services,
    chaintracks: services.tracker,
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 100,
    unprovenAttemptsLimitMain: 144,
    maxRebroadcastAttempts: 0,
    startupTaskMode: 'none'
  })
  monitor.addDefaultTasks()
  let wallet = new Wallet({
    chain: 'mock',
    keyDeriver: new CachedKeyDeriver(root),
    storage: manager,
    services,
    monitor
  })

  try {
    for (let i = 0; i < 100; i++) await services.mineBlock()
    const [coinbase] = await services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, blockHeight: 0, spentByTxid: null })
    const inputBeef = await services.getBeefForTxid(coinbase.txid)
    const action = new Transaction()
    action.addInput({
      sourceTXID: coinbase.txid,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(''),
      sequence: 0xffffffff
    })
    action.addOutput({ satoshis: 4_999_999_999, lockingScript: Script.fromHex('51') })
    action.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
    const txid = action.id('hex')
    const rawTx = [...action.toBinary()]
    const now = new Date()
    const txId = await active.insertTransaction({
      created_at: now,
      updated_at: now,
      transactionId: 0,
      userId: user.userId,
      status: 'failed',
      reference: Buffer.from('exact-resume').toString('base64'),
      isOutgoing: true,
      satoshis: -1,
      description: 'exact resume regression',
      txid
    })
    const reqId = await active.insertProvenTxReq({
      created_at: now,
      updated_at: now,
      provenTxReqId: 0,
      status: 'invalid',
      attempts: 1,
      notified: false,
      txid,
      history: JSON.stringify({ notes: [] }),
      notify: JSON.stringify({ transactionIds: [txId] }),
      rawTx,
      inputBEEF: inputBeef.toBinary()
    })
    const fundingId = await active.insertTransaction({
      created_at: now,
      updated_at: now,
      transactionId: 0,
      userId: user.userId,
      status: 'completed',
      reference: Buffer.from('source').toString('base64'),
      isOutgoing: false,
      satoshis: 5_000_000_000,
      description: 'source fixture',
      txid: coinbase.txid
    })
    const outputBase = {
      created_at: now,
      updated_at: now,
      outputId: 0,
      userId: user.userId,
      change: false,
      outputDescription: 'test owned output',
      providedBy: 'you',
      purpose: '',
      type: 'custom'
    }
    const inputId = await active.insertOutput({
      ...outputBase,
      transactionId: fundingId,
      spendable: true,
      vout: 0,
      satoshis: 5_000_000_000,
      txid: coinbase.txid,
      lockingScript: [81]
    })
    for (const [vout, output] of action.outputs.entries())
      await active.insertOutput({
        ...outputBase,
        transactionId: txId,
        spendable: false,
        vout,
        satoshis: output.satoshis,
        txid,
        lockingScript: [...output.lockingScript.toBinary()]
      })
    const scenario = process.argv[2] ?? 'normal'
    const post = services.postBeef.bind(services)
    if (scenario === 'lost-response')
      services.postBeef = async (...args) => {
        await post(...args)
        throw new Error('provider response lost')
      }
    if (scenario === 'already-known') {
      const b = Beef.fromBinary(inputBeef.toBinary())
      b.mergeRawTx(rawTx)
      await post(b, [txid])
    }
    const resume = () =>
      wallet.createAction({
        description: 'resume exact signed action',
        options: { sendWith: [txid], acceptDelayedBroadcast: false }
      })
    if (scenario === 'empty-stored-beef') {
      const { EntityProvenTx } = require('../../src/storage/schema/entities/EntityProvenTx.ts')
      const { proven } = await EntityProvenTx.fromTxid(coinbase.txid, services)
      assert.ok(proven)
      await active.insertProvenTx(proven.toApi())
      await active.updateProvenTxReq(reqId, { inputBEEF: new Beef().toBinary() })
    }
    if (scenario === 'missing-ancestry') await active.updateProvenTxReq(reqId, { inputBEEF: new Beef().toBinary() })
    if (scenario === 'missing-output') await active.knex('outputs').where({ transactionId: txId, vout: 1 }).del()
    if (scenario === 'foreign-output-owner') {
      const { user: other } = await active.findOrInsertUser(PrivateKey.fromHex('2'.repeat(64)).toPublicKey().toString())
      await active.knex('outputs').where({ transactionId: txId, vout: 1 }).update({ userId: other.userId })
    }
    if (scenario === 'malformed') await active.updateProvenTxReq(reqId, { rawTx: [0] })
    if (scenario === 'wrong-id') await active.updateProvenTxReq(reqId, { rawTx: [...rawTx.slice(0, -1), 1] })
    if (scenario === 'foreign-owner') await active.updateTransaction(txId, { isOutgoing: false })
    if (scenario === 'output-mismatch')
      await active.updateOutput((await active.findOutputs({ partial: { transactionId: txId } }))[0].outputId, {
        satoshis: 22
      })
    if (scenario === 'reallocated') await active.updateOutput(inputId, { spendable: false, spentBy: fundingId })
    if (
      [
        'malformed',
        'wrong-id',
        'foreign-owner',
        'output-mismatch',
        'reallocated',
        'missing-output',
        'foreign-output-owner',
        'missing-ancestry'
      ].includes(scenario)
    ) {
      await assert.rejects(resume)
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'invalid')
      assert.equal((await services.getStatusForTxids([txid])).results[0].status, 'unknown')
      console.log(`PASS refuses ${scenario} without posting or lifecycle mutation`)
      return
    }
    if (scenario === 'prequeue-crash') {
      const update = active.updateTransaction.bind(active)
      active.updateTransaction = async (id, fields, trx) => {
        if (id === txId && fields.status === 'sending') throw new Error('crash before queue commit')
        return update(id, fields, trx)
      }
      await assert.rejects(resume)
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'invalid')
      assert.equal((await active.findOutputs({ partial: { outputId: inputId } }))[0].spendable, true)
      active.updateTransaction = update
    }
    if (scenario === 'postqueue-crash') {
      const attempt = active.attemptToPostReqsToNetwork.bind(active)
      active.attemptToPostReqsToNetwork = async () => {
        throw new Error('crash after queue commit')
      }
      await assert.rejects(resume)
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'unsent')
      assert.equal((await active.findOutputs({ partial: { outputId: inputId } }))[0].spentBy, txId)
      active.attemptToPostReqsToNetwork = attempt
    }
    if (scenario === 'status-commit-crash') {
      const update = active.updateTransaction.bind(active)
      active.updateTransaction = async (id, fields, trx) => {
        if (id === txId && fields.status === 'unproven') throw new Error('crash after post before status commit')
        return update(id, fields, trx)
      }
      await assert.rejects(resume)
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'unsent')
      assert.equal((await services.getStatusForTxids([txid])).results[0].status, 'known')
      active.updateTransaction = update
    }
    if (scenario === 'provider-unknown' || scenario === 'malformed-status') {
      services.postBeef = async () => {
        throw new Error('offline')
      }
      if (scenario === 'malformed-status')
        services.getStatusForTxids = async () => ({
          status: 'success',
          results: [{ txid: 'ff'.repeat(32), status: 'known' }]
        })
      const pending = await resume().catch(error => {
        assert.equal(error.name, 'WERR_REVIEW_ACTIONS')
        return error
      })
      assert.equal(pending.sendWithResults[0].status, 'sending')
      assert.equal((await active.findOutputs({ partial: { outputId: inputId } }))[0].spentBy, txId)
      services.postBeef = post
    }
    if (scenario === 'restart') {
      active.attemptToPostReqsToNetwork = async () => {
        throw new Error('stop after durable queue')
      }
      await assert.rejects(resume)
      const filename = walletDb.client.config.connection.filename
      await monitor.destroy()
      await active.destroy()
      walletDb = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true })
      active = new StorageKnex({
        chain: 'mock',
        knex: walletDb,
        commissionSatoshis: 0,
        feeModel: { model: 'sat/kb', value: 1 }
      })
      active.setServices(services)
      await active.makeAvailable()
      manager = new WalletStorageManager(identityKey, active)
      await manager.makeAvailable()
      monitor = new Monitor({
        chain: 'mock',
        storage: manager,
        services,
        chaintracks: services.tracker,
        msecsWaitPerMerkleProofServiceReq: 0,
        taskRunWaitMsecs: 0,
        abandonedMsecs: 300000,
        unprovenAttemptsLimitTest: 100,
        unprovenAttemptsLimitMain: 144,
        maxRebroadcastAttempts: 0,
        startupTaskMode: 'none'
      })
      monitor.addDefaultTasks()
      wallet = new Wallet({
        chain: 'mock',
        keyDeriver: new CachedKeyDeriver(root),
        storage: manager,
        services,
        monitor
      })
    }
    if (scenario === 'delayed-race') {
      const find = active.findProvenTxReqs.bind(active)
      let changed = false
      active.findProvenTxReqs = async args => {
        const rows = await find(args)
        if (!args.trx && !changed && rows[0]?.status === 'unsent') {
          changed = true
          await active.updateProvenTxReq(reqId, { status: 'unmined' })
          await active.updateTransaction(txId, { status: 'unproven' })
        }
        return rows
      }
      await wallet.createAction({ description: 'race delayed exact retry', options: { sendWith: [txid] } })
      assert.equal((await find({ partial: { provenTxReqId: reqId } }))[0].status, 'unmined')
      console.log('PASS delayed scheduling preserves concurrent broadcast advancement')
      return
    }
    if (scenario === 'delayed') {
      const queued = await wallet.createAction({
        description: 'resume delayed original action',
        options: { sendWith: [txid] }
      })
      assert.equal(queued.sendWithResults[0].status, 'sending')
      const { TaskSendWaiting } = require('../../src/monitor/tasks/TaskSendWaiting.ts')
      const task = new TaskSendWaiting(monitor, 0, 0)
      await task.runTask()
    }
    if (scenario === 'failure-during-post') {
      services.postBeef = async (...args) => {
        const result = await post(...args)
        await active.updateProvenTxReq(reqId, { status: 'invalid' })
        await active.updateTransactionStatus('failed', txId)
        return result
      }
      await assert.rejects(resume, error => error.sendWithResults?.[0].status === 'sending')
      assert.equal((await active.findTransactions({ partial: { transactionId: txId } }))[0].status, 'failed')
      services.postBeef = post
    }
    if (['shared-after-requeue', 'shared-during-post', 'shared-delayed'].includes(scenario)) {
      let foreignTxId
      const addForeign = async () => {
        if (foreignTxId) return
        const { user: other } = await active.findOrInsertUser(
          PrivateKey.fromHex('2'.repeat(64)).toPublicKey().toString()
        )
        foreignTxId = await active.insertTransaction({
          created_at: now,
          updated_at: now,
          transactionId: 0,
          userId: other.userId,
          status: 'failed',
          reference: Buffer.from('foreign-shared').toString('base64'),
          isOutgoing: false,
          satoshis: 1,
          description: 'foreign shared view',
          txid
        })
        await active.updateProvenTxReq(reqId, { notify: JSON.stringify({ transactionIds: [txId, foreignTxId] }) })
      }
      if (scenario === 'shared-after-requeue') {
        const get = active.getReqsAndBeefToShareWithWorld.bind(active)
        active.getReqsAndBeefToShareWithWorld = async (...args) => {
          await addForeign()
          return get(...args)
        }
      } else if (scenario === 'shared-during-post') {
        services.postBeef = async (...args) => {
          const result = await post(...args)
          await addForeign()
          return result
        }
      } else {
        const find = active.findProvenTxReqs.bind(active)
        active.findProvenTxReqs = async args => {
          const rows = await find(args)
          if (!args.trx && rows[0]?.status === 'unsent') await addForeign()
          return rows
        }
      }
      await assert.rejects(() =>
        scenario === 'shared-delayed'
          ? wallet.createAction({ description: 'delayed shared recovery', options: { sendWith: [txid] } })
          : resume()
      )
      assert.equal((await active.findTransactions({ partial: { transactionId: foreignTxId } }))[0].status, 'failed')
      if (scenario !== 'shared-during-post')
        assert.equal((await services.getStatusForTxids([txid])).results[0].status, 'unknown')
      console.log(`PASS refuses ${scenario} without advancing foreign action`)
      return
    }
    const result = scenario === 'concurrent' ? (await Promise.all([resume(), resume(), resume()]))[0] : await resume()
    assert.equal(result.sendWithResults[0].status, 'unproven', JSON.stringify(result))
    const req = (await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0]
    assert.deepEqual(req.rawTx, rawTx)
    assert.equal((await active.findTransactions({ partial: { transactionId: txId } }))[0].status, 'unproven')
    assert.equal((await active.findOutputs({ partial: { outputId: inputId } }))[0].spentBy, txId)
    assert.equal((await active.findTransactions({ partial: { txid } })).length, 1)
    if (scenario === 'proof') {
      monitor.lastNewHeader = await services.mineBlock()
      await monitor.runTask('CheckForProofs')
      assert.equal((await active.findTransactions({ partial: { transactionId: txId } }))[0].status, 'completed')
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'completed')
    }
    console.log(`PASS ${scenario}: identical signed txid, same input reservation and coherent lifecycle`)
  } finally {
    await monitor.destroy()
    await active.destroy()
    await chainDb.destroy()
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
