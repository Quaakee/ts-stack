const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { randomBytes } = require('node:crypto')
const { join } = require('node:path')
const { knex } = require('knex')
const { PrivateKey, CachedKeyDeriver, Beef, Script, Transaction } = require('@bsv/sdk')
const { StorageKnex, WalletStorageManager, Wallet, Monitor, MockServices } = require('../../src/index.ts')
// ATLAS_EXACT_RESUME_MYSQL, a JSON mysql2 connection config without a database (as Setup.createMySQLKnex
// takes), moves the wallet store to a fresh MySQL database that is dropped afterwards. Otherwise the
// store is a fresh SQLite file. The mock chain always stays in memory.
const mysqlConnection = process.env.ATLAS_EXACT_RESUME_MYSQL
async function walletDbConfig() {
  if (!mysqlConnection) {
    const filename = join(mkdtempSync(join(tmpdir(), 'atlas-exact-wallet-')), 'wallet.sqlite')
    return { client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true }
  }
  const database = `atlas_exact_${randomBytes(8).toString('hex')}`
  const admin = knex({ client: 'mysql2', connection: JSON.parse(mysqlConnection) })
  await admin.raw(`CREATE DATABASE ${database}`)
  await admin.destroy()
  return {
    client: 'mysql2',
    connection: { ...JSON.parse(mysqlConnection), database },
    useNullAsDefault: true,
    pool: { min: 0, max: 7, idleTimeoutMillis: 15000 }
  }
}
async function dropWalletDb(config) {
  if (config.client !== 'mysql2') return
  const admin = knex({ client: 'mysql2', connection: JSON.parse(mysqlConnection) })
  await admin.raw(`DROP DATABASE ${config.connection.database}`)
  await admin.destroy()
}
async function main() {
  const walletConfig = await walletDbConfig()
  let walletDb = knex(walletConfig)
  if (mysqlConnection) {
    const [[{ isolation }]] = await walletDb.raw('SELECT @@transaction_isolation AS isolation')
    assert.equal(isolation, 'REPEATABLE-READ', 'MySQL qualification runs at REPEATABLE READ')
  }
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
  await active.findOrInsertUser(identityKey)
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
    monitor,
    actionBatchMode: 'legacy'
  })

  try {
    for (let i = 0; i < 108; i++) await services.mineBlock()
    const { P2PKH } = require('@bsv/sdk')
    const { WalletPermissionsManager } = require('../../src/index.ts')
    const sender = new CachedKeyDeriver(PrivateKey.fromHex('2'.repeat(64)))
    const prefix = Buffer.from('prefix').toString('base64'),
      suffix = Buffer.from('suffix').toString('base64')
    const key = sender.derivePublicKey([2, '3241645161d8'], `${prefix} ${suffix}`, identityKey)
    const [source] = await services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, blockHeight: 0, spentByTxid: null })
    const beef = await services.getBeefForTxid(source.txid)
    const parent = new Transaction()
    parent.addInput({
      sourceTransaction: Transaction.fromBEEF(beef.toBinary(), source.txid),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex('')
    })
    parent.addOutput({ satoshis: 100000, lockingScript: new P2PKH().lock(key.toAddress()) })
    beef.mergeTransaction(parent)
    const [posted] = await services.postBeef(beef, [parent.id('hex')])
    assert.equal(posted.status, 'success', JSON.stringify(posted))
    await services.mineBlock()
    // Internalize the mined funding with its proof. Without one, 2.15.3 storage finds no proof
    // and broadcasts it again, and the 2.15.3 mock chain refuses that repeated spend of its input.
    const funded = await services.getBeefForTxid(parent.id('hex'))
    await wallet.internalizeAction({
      tx: funded.toBinaryAtomic(parent.id('hex')),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: prefix,
            derivationSuffix: suffix,
            senderIdentityKey: sender.identityKey
          }
        }
      ],
      description: 'mock BRC29 funding'
    })
    const perms = new WalletPermissionsManager(wallet, 'atlas-admin')
    const create = wallet.createAction.bind(wallet)
    let created, mint
    wallet.createAction = async (args, originator) => {
      created = await create(
        { ...args, options: { ...args.options, noSend: true, acceptDelayedBroadcast: false } },
        originator
      )
      return created
    }
    perms.bindCallback('onCertificateAccessRequested', request => {
      mint = perms.grantPermission({ requestID: request.requestID, expiry: 0 })
      return mint
    })
    await perms.ensureCertificateAccess({
      originator: 'atlas-client',
      privileged: false,
      verifier: sender.identityKey,
      certType: Buffer.alloc(32, 1).toString('base64'),
      fields: [],
      usageType: 'disclosure'
    })
    await mint
    wallet.createAction = create
    if (created.signableTransaction) {
      const [signed] = await active.findTransactions({ partial: { reference: created.signableTransaction.reference } })
      created.txid = signed?.txid
    }
    assert.ok(created.txid, 'signed WPM txid required')
    const [action] = await active.findTransactions({ partial: { txid: created.txid } })
    const [before] = await active.findProvenTxReqs({ partial: { txid: created.txid } })
    assert.equal(
      Beef.fromBinary(before.inputBEEF).txs.length,
      0,
      'real WPM preserves locally known ancestry in storage'
    )
    const count = (await active.findTransactions({ partial: {} })).length
    assert.equal((await wallet.abortAction({ reference: action.reference })).aborted, true)
    const [failed] = await active.findProvenTxReqs({ partial: { txid: created.txid } })
    assert.equal(failed.status, 'invalid')
    const result = await wallet.createAction({
      description: 'resume genuine WPM signed action',
      options: { sendWith: [created.txid], acceptDelayedBroadcast: false }
    })
    assert.equal(result.sendWithResults[0].status, 'unproven')
    const [after] = await active.findProvenTxReqs({ partial: { txid: created.txid } })
    assert.deepEqual(after.rawTx, before.rawTx)
    assert.deepEqual(after.inputBEEF, before.inputBEEF)
    assert.equal((await active.findTransactions({ partial: {} })).length, count)
    console.log('PASS genuine WPM noSend/abort/exact-resume with storage-only ancestry and identical signed bytes')
  } finally {
    await monitor.destroy()
    await active.destroy()
    await chainDb.destroy()
    await dropWalletDb(walletConfig)
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
