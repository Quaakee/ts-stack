import type Transaction from '@bsv/sdk/transaction/Transaction'
import { boundPreimage, resolveBoundSource, signatureScope } from './signing-context.js'

export type SignOutputs = 'all' | 'none' | 'single'

/**
 * Builds the BIP143 sighash preimage and scope shared by the Mandala unlock templates.
 */
export function buildSighashPreimage(
  tx: Transaction,
  inputIndex: number,
  signOutputs: SignOutputs,
  anyoneCanPay: boolean
): { preimage: number[]; scope: number } {
  const scope = signatureScope(tx, inputIndex, signOutputs, anyoneCanPay)
  const source = resolveBoundSource(tx, inputIndex)
  const preimage = boundPreimage(tx, inputIndex, source, scope)
  return { preimage, scope }
}
