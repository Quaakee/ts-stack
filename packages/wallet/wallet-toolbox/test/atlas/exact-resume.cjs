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
    chain: 'test',
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
    chain: 'test',
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
    chain: 'test',
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
        chain: 'test',
        knex: walletDb,
        commissionSatoshis: 0,
        feeModel: { model: 'sat/kb', value: 1 }
      })
      active.setServices(services)
      await active.makeAvailable()
      manager = new WalletStorageManager(identityKey, active)
      await manager.makeAvailable()
      monitor = new Monitor({
        chain: 'test',
        storage: manager,
        services,
        chaintracks: services.tracker,
        startupTaskMode: 'none'
      })
      monitor.addDefaultTasks()
      wallet = new Wallet({
        chain: 'test',
        keyDeriver: new CachedKeyDeriver(root),
        storage: manager,
        services,
        monitor
      })
    }
    const { TaskSendWaiting } = require('../../src/monitor/tasks/TaskSendWaiting.ts')
    const networkStatus = async id => (await services.getStatusForTxids([id])).results[0].status
    // SendWaiting only sends requests updated strictly before its run (agedMsecs 0), so let the
    // clock pass whatever was just queued; otherwise "sends nothing" could pass vacuously.
    const sendWaiting = async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      await new TaskSendWaiting(monitor, 0, 0).runTask()
    }
    // #589: a refused set, or a retry the share did not admit, leaves no exact-retry state, so the
    // monitor has nothing to send on its own.
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
    // An independent, ordinary nosend action spending the coinbase mined at `height`.
    const insertNosend = async (height, label) => {
      const [cb] = await services.storage
        .knex('mockchain_utxos')
        .where({ isCoinbase: true, blockHeight: height, spentByTxid: null })
      const ib = await services.getBeefForTxid(cb.txid)
      const tx = new Transaction()
      tx.addInput({
        sourceTXID: cb.txid,
        sourceOutputIndex: cb.vout,
        unlockingScript: Script.fromHex(''),
        sequence: 0xffffffff
      })
      tx.addOutput({ satoshis: Number(cb.satoshis) - 1, lockingScript: Script.fromHex('51') })
      const id = tx.id('hex')
      const transactionId = await active.insertTransaction({
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: user.userId,
        status: 'nosend',
        reference: Buffer.from(label).toString('base64'),
        isOutgoing: true,
        satoshis: -1,
        description: label,
        txid: id
      })
      const provenTxReqId = await active.insertProvenTxReq({
        created_at: now,
        updated_at: now,
        provenTxReqId: 0,
        status: 'nosend',
        attempts: 1,
        notified: false,
        txid: id,
        history: JSON.stringify({ notes: [] }),
        notify: JSON.stringify({ transactionIds: [transactionId] }),
        rawTx: [...tx.toBinary()],
        inputBEEF: ib.toBinary()
      })
      const fund = await active.insertTransaction({
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: user.userId,
        status: 'completed',
        reference: Buffer.from(`${label} source`).toString('base64'),
        isOutgoing: false,
        satoshis: Number(cb.satoshis),
        description: `${label} source`,
        txid: cb.txid
      })
      await active.insertOutput({
        ...outputBase,
        transactionId: fund,
        spendable: false,
        spentBy: transactionId,
        vout: cb.vout,
        satoshis: Number(cb.satoshis),
        txid: cb.txid,
        lockingScript: [81]
      })
      await active.insertOutput({
        ...outputBase,
        transactionId,
        spendable: false,
        vout: 0,
        satoshis: Number(cb.satoshis) - 1,
        txid: id,
        lockingScript: [81]
      })
      return { txid: id, reqId: provenTxReqId }
    }
    if (scenario === 'incomplete-set') {
      // A sendWith set that cannot be sent together commits no exact-retry state, in both immediate
      // and delayed modes, so the monitor later finds nothing to broadcast. On this base an
      // immediate share of an incomplete set posts its ready members and then throws.
      const missing = 'ab'.repeat(32)
      for (const acceptDelayedBroadcast of [false, true]) {
        const mode = acceptDelayedBroadcast ? 'delayed' : 'immediate'
        const outcome = await wallet
          .createAction({
            description: 'resume with incomplete set',
            options: { sendWith: [txid, missing], acceptDelayedBroadcast }
          })
          .catch(error => error)
        const reported = outcome.sendWithResults?.find(result => result.txid === txid)?.status
        assert.ok(
          reported === undefined || reported === 'failed',
          `${mode}: ${JSON.stringify(outcome.sendWithResults)}`
        )
        await assertNoRetryState([], `${mode} incomplete set`)
      }
      // The same retry inside a complete set still resumes and broadcasts.
      const result = await resume()
      assert.equal(result.sendWithResults[0].status, 'unproven', JSON.stringify(result))
      assert.equal(await networkStatus(txid), 'known')
      console.log('PASS incomplete-set: no retry state committed, nothing broadcast alone, complete set still resumes')
      return
    }
    if (scenario === 'duplicate-member' || scenario === 'duplicate-member-delayed') {
      // A txid listed twice is one retry: every result reported for it matches what was persisted,
      // and each of its positions takes the exact-retry path. Immediate mode posts to an offline
      // provider, which an exact retry must report as indeterminate (sending), never as an error.
      const acceptDelayedBroadcast = scenario === 'duplicate-member-delayed'
      const mode = acceptDelayedBroadcast ? 'delayed' : 'immediate'
      if (!acceptDelayedBroadcast)
        services.postBeef = async () => {
          throw new Error('offline')
        }
      const result = await wallet
        .createAction({
          description: 'resume a retry listed twice',
          options: { sendWith: [txid, txid], acceptDelayedBroadcast }
        })
        .catch(error => {
          assert.equal(error.name, 'WERR_REVIEW_ACTIONS', `${mode}: ${error.message}`)
          return error
        })
      services.postBeef = post
      const [req] = await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } })
      assert.equal(req.status, acceptDelayedBroadcast ? 'unsent' : 'sending', mode)
      assert.deepEqual(
        result.sendWithResults.map(r => r.status),
        ['sending', 'sending'],
        `${mode}: ${JSON.stringify(result.sendWithResults)}`
      )
      assert.equal(JSON.parse(req.history).notes.filter(note => note.what === 'exactSendWithResume').length, 1)
      assert.equal((await active.findOutputs({ partial: { outputId: inputId } }))[0].spentBy, txId)
      await sendWaiting()
      assert.equal(await networkStatus(txid), 'known', mode)
      console.log(`PASS ${scenario}: every result for a retry listed twice matches its one persisted retry`)
      return
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
      // The coinbases mined at heights 1 and 2 mature after two more blocks.
      await services.mineBlock()
      await services.mineBlock()
      const delayed = scenario === 'poc2-transient-delayed'
      const mode = delayed ? 'delayed' : 'immediate'
      const share = sendWith =>
        wallet.createAction({
          description: 'resume beside an ordinary nosend action',
          options: { sendWith, acceptDelayedBroadcast: delayed }
        })
      // Each member's reads outside any transaction: read 1 is planning, read 2 is the share's lookup.
      const find = active.findProvenTxReqs.bind(active)
      const faultShareLookup = async (faulty, sendWith) => {
        let reads = 0
        active.findProvenTxReqs = async args => {
          if (!args.trx && args.partial?.txid === faulty && ++reads === 2) throw new Error('transient lookup failure')
          return find(args)
        }
        const outcome = await share(sendWith).catch(error => error)
        active.findProvenTxReqs = find
        assert.equal(reads, 2, `${mode}: the share's lookup did not read ${faulty}`)
        return outcome
      }
      const b = await insertNosend(1, 'poc2-transient B')
      // 1a. B's read in the share's lookup fails: the set is incomplete, so the retry is not admitted
      // and nothing is committed, scheduled or posted.
      const incomplete = await faultShareLookup(b.txid, [txid, b.txid])
      assert.deepEqual(
        incomplete.sendWithResults?.map(result => result.status),
        ['failed', 'failed'],
        `${mode}: ${JSON.stringify(incomplete.sendWithResults ?? incomplete)}`
      )
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: b.reqId } }))[0].status, 'nosend')
      await assertNoRetryState([b.txid], `${mode} B share-lookup fault`)
      // 1b. A's own read in the share's lookup fails. The share then reports A as not sent, so nothing
      // may be committed for A. On this 2.10.2 base the ready member B is still shared on its own: an
      // immediate share posts it and then throws, a delayed one schedules it and reports A failed.
      const unadmitted = await faultShareLookup(txid, [txid, b.txid])
      const toldA = unadmitted.sendWithResults?.find(result => result.txid === txid)?.status
      assert.ok(
        delayed ? toldA === 'failed' : unadmitted instanceof Error && toldA === undefined,
        `${mode}: ${JSON.stringify(unadmitted.sendWithResults ?? unadmitted.message)}`
      )
      await assertNoRetryState([], `${mode} A share-lookup fault`)
      // 2. Without the fault the same retry is admitted and goes out with its set.
      const c = await insertNosend(2, 'poc2-transient C')
      const sent = await share([txid, c.txid])
      if (delayed) {
        assert.deepEqual(
          sent.sendWithResults.map(result => result.status),
          ['sending', 'sending'],
          JSON.stringify(sent)
        )
        const [reqA] = await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } })
        const [reqC] = await active.findProvenTxReqs({ partial: { provenTxReqId: c.reqId } })
        assert.equal(reqA.status, 'unsent')
        assert.equal(reqC.status, 'unsent')
        assert.ok(reqA.batch != null && reqA.batch === reqC.batch, `batches ${reqA.batch} / ${reqC.batch}`)
        assert.equal(await networkStatus(txid), 'unknown')
        await sendWaiting()
      } else {
        assert.deepEqual(
          sent.sendWithResults.map(result => result.status),
          ['unproven', 'unproven'],
          JSON.stringify(sent)
        )
      }
      assert.equal(await networkStatus(txid), 'known')
      assert.equal(await networkStatus(c.txid), 'known')
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'unmined')
      assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: c.reqId } }))[0].status, 'unmined')
      assert.equal((await active.findOutputs({ partial: { outputId: inputId } }))[0].spentBy, txId)
      console.log(
        `PASS ${scenario}: one share decision; an unadmitted retry commits nothing, an admitted one goes with its set`
      )
      return
    }
    if (scenario === 'poc2-ordering' || scenario === 'poc2-ordering-delayed') {
      // A refusal after the share's decision but before the set is posted or scheduled must leave
      // no retry state: the retry commits with the set's batch, after every pre-post check.
      await services.mineBlock()
      const delayed = scenario === 'poc2-ordering-delayed'
      const b = await insertNosend(1, 'poc2-ordering B')
      const setWith = async (label, inject, expected) => {
        const restore = inject()
        await assert.rejects(
          wallet.createAction({
            description: `resume beside B: ${label}`,
            options: { sendWith: [txid, b.txid], acceptDelayedBroadcast: delayed }
          }),
          expected
        )
        restore()
        await assertNoRetryState([b.txid], label)
        assert.equal(
          (await active.findProvenTxReqs({ partial: { provenTxReqId: b.reqId } }))[0].status,
          'nosend',
          label
        )
      }
      const update = active.updateProvenTxReq.bind(active)
      const touchesB = id => (Array.isArray(id) ? id : [id]).includes(b.reqId)
      if (delayed) {
        // The scheduling write for the set fails inside the scheduling transaction.
        await setWith(
          'delayed scheduling write fails',
          () => {
            active.updateProvenTxReq = async (id, fields, trx) => {
              if (touchesB(id) && fields.status === 'unsent') throw new Error('crash scheduling the set')
              return update(id, fields, trx)
            }
            return () => (active.updateProvenTxReq = update)
          },
          /crash scheduling the set/
        )
      } else {
        // The set's merged BEEF is refused.
        const get = active.getReqsAndBeefToShareWithWorld.bind(active)
        await setWith(
          'immediate merged BEEF refused',
          () => {
            active.getReqsAndBeefToShareWithWorld = async (...args) => {
              const r = await get(...args)
              r.beef.verify = async () => false
              return r
            }
            return () => (active.getReqsAndBeefToShareWithWorld = get)
          },
          /merged Beef failed validation/
        )
        // The set's batch write fails.
        await setWith(
          'immediate batch write fails',
          () => {
            active.updateProvenTxReq = async (id, fields, trx) => {
              if (touchesB(id) && Object.keys(fields).join() === 'batch') throw new Error('crash writing the set batch')
              return update(id, fields, trx)
            }
            return () => (active.updateProvenTxReq = update)
          },
          /crash writing the set batch/
        )
      }
      // Nothing was left half-committed: A alone still resumes and broadcasts.
      const result = await resume()
      assert.equal(result.sendWithResults[0].status, 'unproven', JSON.stringify(result))
      assert.equal(await networkStatus(txid), 'known')
      console.log(`PASS ${scenario}: a refusal before the post or schedule leaves no retry state`)
      return
    }
    if (scenario === 'delayed-race') {
      const find = active.findProvenTxReqs.bind(active)
      let changed = false
      let reads = 0
      active.findProvenTxReqs = async args => {
        const rows = await find(args)
        // The concurrent broadcast lands after the request was queued or, now that the retry and
        // its delayed scheduling commit in one transaction (#589), at the share's lookup (read 2
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
          // transaction that commits and schedules the retry (#589).
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
      if (scenario !== 'shared-during-post') {
        assert.equal((await services.getStatusForTxids([txid])).results[0].status, 'unknown')
        // #589: the refusal comes before the retry commits, so no retry state survives it.
        assert.equal((await active.findProvenTxReqs({ partial: { provenTxReqId: reqId } }))[0].status, 'invalid')
        assert.ok((await active.findOutputs({ partial: { outputId: inputId } }))[0].spentBy == null)
      }
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
