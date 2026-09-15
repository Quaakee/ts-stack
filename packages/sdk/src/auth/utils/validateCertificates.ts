import { OriginatorDomainNameStringUnder250Bytes, WalletInterface } from '../../wallet/index.js'
import { AuthMessage, RequestedCertificateSet } from '../types.js'
import { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'

/**
 * Validates and processes the certificates received from a peer.
 * An exact, locally retained request for zero fields validates the signed core
 * without decryption. Callers must authenticate and bind the message to that
 * request; a peer-supplied requestedCertificates member is not request authority.
 *
 * @private
 * @param {AuthMessage} message - The message containing the certificates to validate.
 * @param {boolean} allowZeroFields - Whether the caller has retained a trusted request for zero-field validation.
 * @returns {Promise<void>}
 * @throws Will throw an error if certificate validation or field decryption fails.
 */
export const validateCertificates = async (
  verifierWallet: WalletInterface,
  message: AuthMessage,
  certificatesRequested?: RequestedCertificateSet,
  originator?: OriginatorDomainNameStringUnder250Bytes,
  allowZeroFields: boolean = true
): Promise<void> => {
  if ((message.certificates == null) || message.certificates.length === 0) {
    throw new Error('No certificates were provided in the AuthMessage.')
  }

  await Promise.all(
    message.certificates.map(async (incomingCert: VerifiableCertificate) => {
      if (incomingCert.subject !== message.identityKey) {
        throw new Error(
          `The subject of one of your certificates ("${incomingCert.subject}") is not the same as the request sender ("${message.identityKey}").`
        )
      }

      // Verify Certificate structure and signature
      const certToVerify = new VerifiableCertificate(
        incomingCert.type,
        incomingCert.serialNumber,
        incomingCert.subject,
        incomingCert.certifier,
        incomingCert.revocationOutpoint,
        incomingCert.fields,
        incomingCert.keyring,
        incomingCert.signature
      )
      const isValidCert = await certToVerify.verify()
      if (!isValidCert) {
        throw new Error(
          `The signature for the certificate with serial number ${certToVerify.serialNumber} is invalid!`
        )
      }

      // Check if the certificate matches requested certifiers, types, and fields
      if (certificatesRequested != null) {
        const { certifiers, types } = certificatesRequested

        // Check certifier matches
        if (!certifiers.includes(certToVerify.certifier)) {
          throw new Error(
            `Certificate with serial number ${certToVerify.serialNumber} has an unrequested certifier: ${certToVerify.certifier}`
          )
        }

        // Check type and fields match requested
        const requestedFields = types[certToVerify.type]
        if (requestedFields == null) {
          throw new Error(
            `Certificate with type ${certToVerify.type} was not requested`
          )
        }

        // BRC-52 permits zero revealed fields and an empty or omitted keyring.
        // The signed core and requested issuer/type have already been checked.
        if (allowZeroFields && Array.isArray(requestedFields) && requestedFields.length === 0) {
          const { keyring } = certToVerify
          if (keyring != null && (
            typeof keyring !== 'object' ||
            Array.isArray(keyring) ||
            Object.keys(keyring).length > 0
          )) {
            throw new Error('Unexpected keyring.')
          }
          return
        }
      }

      // Attempt to decrypt fields
      await certToVerify.decryptFields(verifierWallet, undefined, undefined, originator)
    })
  )
}
