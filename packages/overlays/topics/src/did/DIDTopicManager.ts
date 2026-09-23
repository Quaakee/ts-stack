import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { decodeCanonicalDIDToken, Transaction } from '@bsv/sdk'

export default class DIDTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      const parsedTransaction = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1)
        throw new Error('Missing parameter: inputs')
      if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1)
        throw new Error('Missing parameter: outputs')

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          decodeCanonicalDIDToken(output.lockingScript)

          outputsToAdmit.push(i)
        } catch (error) {
          console.error(`Error parsing output ${i}`, error)
          continue
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('DID topic manager: no outputs admitted!')

      return { outputsToAdmit, coinsToRetain: [] }
    } catch (error) {
      if (
        outputsToAdmit.length === 0 &&
        (previousCoins === undefined || previousCoins.length === 0)
      ) {
        console.error('Error identifying admissible outputs:', error)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return 'DID Topic Manager: indexes canonical legacy DID tokens. The v1 wire format omits issuer and subject, so issuer/subject authority must be established separately.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'DID Topic Manager',
      shortDescription: 'DID Resolution Protocol'
    }
  }
}
