const { spawnSync } = require('node:child_process')
const scenarios = [
  'empty-stored-beef',
  'missing-ancestry',
  'missing-output',
  'foreign-output-owner',
  'shared-after-requeue',
  'shared-during-post',
  'shared-delayed',
  'normal',
  'failure-during-post',
  'lost-response',
  'already-known',
  'concurrent',
  'malformed',
  'wrong-id',
  'foreign-owner',
  'output-mismatch',
  'reallocated',
  'prequeue-crash',
  'postqueue-crash',
  'status-commit-crash',
  'provider-unknown',
  'malformed-status',
  'restart',
  'delayed',
  'delayed-race',
  'proof',
  'incomplete-set',
  'duplicate-member',
  'duplicate-member-delayed',
  'poc2-multi',
  'poc2-transient',
  'poc2-transient-delayed',
  'poc2-ordering',
  'poc2-ordering-delayed'
]
const [launcher, fixture] = process.argv.slice(2)
if (!launcher || !fixture) throw new Error('Usage: node run-exact-resume.cjs <node-or-tsx> <fixture-path>')
for (const scenario of scenarios) {
  const result = spawnSync(launcher, [fixture, scenario], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`PASS ${scenarios.length} exact signed-action recovery scenarios`)
