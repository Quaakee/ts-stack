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
    if (scenario === 'incomplete-set') {
      // #59 F1: a sendWith set that cannot be sent together commits no exact-retry state, in
      // both immediate and delayed modes, so the monitor later finds nothing to broadcast.
      const missing = 'ab'.repeat(32)
      const { TaskSendWaiting } = require('../../src/monitor/tasks/TaskSendWaiting.ts')
      for (const acceptDelayedBroadcast of [false, true]) {
        const outcome = await wallet
          .createAction({
            description: 'resume with incomplete set',
            options: { sendWith: [txid, missing], acceptDelayedBroadcast }
          })
          .catch(error => error)
        const reported = outcome.sendWithResults?.find(result => result.txid === txid)?.status
        assert.ok(reported === undefined || reported === 'failed', JSON.stringify(outcome.sendWithResults))
        assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'invalid')
        assert.equal((await active.findTransactions({ partial: { transactionId: txId } }))[0].status, 'failed')
        const input = (await active.findOutputs({ partial: { outputId: inputId } }))[0]
        assert.ok(input.spentBy == null, `input reserved by ${input.spentBy}`)
        assert.equal(input.spendable, true)
        assert.equal((await services.getStatusForTxids([txid])).results[0].status, 'unknown')
        await new TaskSendWaiting(monitor, 0, 0).runTask()
        assert.equal((await services.getStatusForTxids([txid])).results[0].status, 'unknown')
        assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'invalid')
      }
      // The same retry inside a complete set still resumes and broadcasts.
      const result = await resume()
      assert.equal(result.sendWithResults[0].status, 'unproven', JSON.stringify(result))
      assert.equal((await services.getStatusForTxids([txid])).results[0].status, 'known')
      console.log('PASS incomplete-set: no retry state committed, nothing broadcast alone, complete set still resumes')
      return
    }
    const { TaskSendWaiting } = require('../../src/monitor/tasks/TaskSendWaiting.ts')
    const networkStatus = async id => (await services.getStatusForTxids([id])).results[0].status
    // SendWaiting only sends requests updated strictly before its run (agedMsecs 0), so let the
    // clock pass whatever was just queued; otherwise "sends nothing" could pass vacuously.
    const sendWaiting = async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      await new TaskSendWaiting(monitor, 0, 0).runTask()
    }
    // #59 R2-1: a refused or incomplete set leaves no exact-retry state, so the monitor has nothing to send.
    const assertNoRetryState = async (others, mode) => {
      const [req] = await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } })
      assert.equal(req.status, 'invalid', `${mode}: retry request committed`)
      const [action] = await active.findTransactions({ partial: { transactionId: txId } })
      assert.equal(action.status, 'failed', `${mode}: retry action committed`)
      const input = (await active.findOutputs({ partial: { outputId: inputId } }))[0]
      assert.ok(input.spentBy == null, `${mode}: input reserved by ${input.spentBy}`)
      assert.equal(input.spendable, true, `${mode}: input reserved`)
      for (const output of await active.findOutputs({ partial: { transactionId: txId } }))
        assert.equal(output.spendable, false, `${mode}: retry outputs released`)
      await sendWaiting()
      for (const id of [txid, ...others])
        assert.equal(await networkStatus(id), 'unknown', `${mode}: ${id} was broadcast`)
      const [after] = await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } })
      assert.equal(after.status, 'invalid', `${mode}: monitor advanced the retry`)
    }
    if (scenario === 'poc2-multi') {
      // B spends A:0 as a chained atomic pair; B passes read-only planning but fails the commit's
      // ownership check (isOutgoing=false). A's retry must not survive B's refusal in either mode.
      const b = new Transaction()
      b.addInput({ sourceTXID: txid, sourceOutputIndex: 0, unlockingScript: Script.fromHex(''), sequence: 0xffffffff })
      b.addOutput({ satoshis: 4_999_999_998, lockingScript: Script.fromHex('51') })
      const txidB = b.id('hex')
      const bBeef = Beef.fromBinary(inputBeef.toBinary())
      bBeef.mergeRawTx(rawTx)
      const txIdB = await active.insertTransaction({
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: user.userId,
        status: 'failed',
        reference: Buffer.from('secondB').toString('base64'),
        isOutgoing: false,
        satoshis: -1,
        description: 'second action',
        txid: txidB
      })
      await active.insertProvenTxReq({
        created_at: now,
        updated_at: now,
        provenTxReqId: 0,
        status: 'invalid',
        attempts: 1,
        notified: false,
        txid: txidB,
        history: JSON.stringify({ notes: [] }),
        notify: JSON.stringify({ transactionIds: [txIdB] }),
        rawTx: [...b.toBinary()],
        inputBEEF: bBeef.toBinary()
      })
      await active.insertOutput({
        ...outputBase,
        transactionId: txIdB,
        spendable: false,
        vout: 0,
        satoshis: 4_999_999_998,
        txid: txidB,
        lockingScript: [81]
      })
      for (const acceptDelayedBroadcast of [false, true]) {
        await assert.rejects(
          wallet.createAction({
            description: 'resume a set whose second retry is refused',
            options: { sendWith: [txid, txidB], acceptDelayedBroadcast }
          }),
          /Exact retry requires one owned failed outgoing action/
        )
        const mode = acceptDelayedBroadcast ? 'delayed' : 'immediate'
        assert.equal((await active.findProvenTxReqs({ partial: { txid: txidB } }))[0].status, 'invalid', mode)
        await assertNoRetryState([txidB], mode)
      }
      // Nothing was left half-committed: A alone still resumes and broadcasts.
      const result = await resume()
      assert.equal(result.sendWithResults[0].status, 'unproven', JSON.stringify(result))
      assert.equal(await networkStatus(txid), 'known')
      console.log('PASS poc2-multi: a refused member rolls back every retry in the set, in both modes')
      return
    }
    if (scenario === 'poc2-transient' || scenario === 'poc2-transient-delayed') {
      // B is an independent, ordinary nosend action spending the height-1 coinbase, which one
      // more block makes mature, so the network would accept B.
      await services.mineBlock()
      const [cb] = await services.storage
        .knex('mockchain_utxos')
        .where({ isCoinbase: true, blockHeight: 1, spentByTxid: null })
      const ib = await services.getBeefForTxid(cb.txid)
      const b = new Transaction()
      b.addInput({ sourceTXID: cb.txid, sourceOutputIndex: cb.vout, unlockingScript: Script.fromHex(''), sequence: 0xffffffff })
      b.addOutput({ satoshis: Number(cb.satoshis) - 1, lockingScript: Script.fromHex('51') })
      const txidB = b.id('hex')
      const txIdB = await active.insertTransaction({
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: user.userId,
        status: 'nosend',
        reference: Buffer.from('second').toString('base64'),
        isOutgoing: true,
        satoshis: -1,
        description: 'second action',
        txid: txidB
      })
      await active.insertProvenTxReq({
        created_at: now,
        updated_at: now,
        provenTxReqId: 0,
        status: 'nosend',
        attempts: 1,
        notified: false,
        txid: txidB,
        history: JSON.stringify({ notes: [] }),
        notify: JSON.stringify({ transactionIds: [txIdB] }),
        rawTx: [...b.toBinary()],
        inputBEEF: ib.toBinary()
      })
      const fundB = await active.insertTransaction({
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: user.userId,
        status: 'completed',
        reference: Buffer.from('sourceB').toString('base64'),
        isOutgoing: false,
        satoshis: Number(cb.satoshis),
        description: 'source B',
        txid: cb.txid
      })
      await active.insertOutput({
        ...outputBase,
        transactionId: fundB,
        spendable: false,
        spentBy: txIdB,
        vout: cb.vout,
        satoshis: Number(cb.satoshis),
        txid: cb.txid,
        lockingScript: [81]
      })
      await active.insertOutput({
        ...outputBase,
        transactionId: txIdB,
        spendable: false,
        vout: 0,
        satoshis: Number(cb.satoshis) - 1,
        txid: txidB,
        lockingScript: [81]
      })
      const delayed = scenario === 'poc2-transient-delayed'
      // B's share lookup reports a transient per-txid failure on the lookup numbers in `faulty`
      // (immediate: calls of getReqsAndBeefToShareWithWorld; delayed: B's non-transaction
      // request reads, where read 1 is planning and read 2 is the share's lookup).
      let lookups = 0
      const get = active.getReqsAndBeefToShareWithWorld.bind(active)
      const find = active.findProvenTxReqs.bind(active)
      const inject = faulty => {
        lookups = 0
        if (delayed)
          active.findProvenTxReqs = async args => {
            if (!args.trx && args.partial?.txid === txidB && faulty(++lookups))
              throw new Error('transient lookup failure')
            return find(args)
          }
        else
          active.getReqsAndBeefToShareWithWorld = async (...args) => {
            const r = await get(...args)
            if (faulty(++lookups))
              for (const d of r.details) if (d.txid === txidB) Object.assign(d, { status: 'error', error: 'transient' })
            return r
          }
      }
      const restore = () => {
        active.findProvenTxReqs = find
        active.getReqsAndBeefToShareWithWorld = get
      }
      const decision = delayed ? 2 : 1
      const share = () =>
        wallet.createAction({
          description: 'resume beside an ordinary nosend action',
          options: { sendWith: [txid, txidB], acceptDelayedBroadcast: delayed }
        })
      // 1. A fault on the decision lookup: the set is incomplete, so nothing is committed.
      inject(n => n === decision)
      const refused = await share()
      restore()
      assert.deepEqual(
        refused.sendWithResults.map(result => result.status),
        ['failed', 'failed'],
        JSON.stringify(refused)
      )
      assert.equal((await active.findProvenTxReqs({ partial: { txid: txidB } }))[0].status, 'nosend')
      await assertNoRetryState([txidB], `${delayed ? 'delayed' : 'immediate'} decision-lookup fault`)
      // 2. A fault on any later lookup (the reviewer's injection) never fires: the set is decided
      // once, so the retry and B are sent together and the caller is told so.
      inject(n => n > decision)
      const sent = await share()
      const lookupsMade = lookups
      restore()
      const told = sent.sendWithResults.map(result => result.status)
      const [committed] = await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } })
      // The caller's results must describe what was persisted: never failed beside a committed retry.
      if (told.includes('failed'))
        assert.equal(committed.status, 'invalid', `later-lookup fault: told ${told} but the retry is ${committed.status}`)
      assert.equal(lookupsMade, decision, `later-lookup fault: ${lookupsMade} lookups, the share re-looked-up`)
      if (delayed) {
        assert.deepEqual(told, ['sending', 'sending'], JSON.stringify(sent))
        const [reqA] = await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } })
        const [reqB] = await active.findProvenTxReqs({ partial: { txid: txidB } })
        assert.equal(reqA.status, 'unsent')
        assert.equal(reqB.status, 'unsent')
        assert.ok(reqA.batch != null && reqA.batch === reqB.batch, `batches ${reqA.batch} / ${reqB.batch}`)
        assert.equal(await networkStatus(txid), 'unknown')
        await sendWaiting()
      } else {
        assert.deepEqual(told, ['unproven', 'unproven'], JSON.stringify(sent))
      }
      assert.equal(await networkStatus(txid), 'known')
      assert.equal(await networkStatus(txidB), 'known')
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'unmined')
      assert.equal((await active.findProvenTxReqs({ partial: { txid: txidB } }))[0].status, 'unmined')
      assert.equal((await active.findOutputs({ partial: { outputId: inputId } }))[0].spentBy, txId)
      console.log(`PASS ${scenario}: one share decision; a faulty lookup commits nothing, the complete set goes together`)
      return
    }
    if (scenario === 'delayed-race') {
      const find = active.findProvenTxReqs.bind(active)
      let changed = false
      let reads = 0
      active.findProvenTxReqs = async args => {
        const rows = await find(args)
        // The concurrent broadcast lands after the request was queued or, now that the retry and
        // its delayed scheduling commit in one transaction (#59), at the share's lookup (read 2
        // of A; read 1 is planning), the last moment before that transaction.
        const shareLookup = !args.trx && args.partial?.txid === txid && ++reads === 2
        if (!args.trx && !changed && (rows[0]?.status === 'unsent' || shareLookup)) {
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
        let reads = 0
        active.findProvenTxReqs = async args => {
          const rows = await find(args)
          // As in delayed-race: after queueing, or at the share's lookup before the one
          // transaction that commits and schedules the retry (#59).
          const shareLookup = !args.trx && args.partial?.txid === txid && ++reads === 2
          if (!args.trx && (rows[0]?.status === 'unsent' || shareLookup)) await addForeign()
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
