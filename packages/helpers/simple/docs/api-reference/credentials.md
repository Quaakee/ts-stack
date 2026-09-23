# Credentials Module

The credentials module provides W3C Verifiable Credentials backed by BSV `MasterCertificate` cryptography. It includes schema definition, credential issuance/verification/revocation, and wallet-side acquisition.

**Source:** `src/modules/credentials.ts`

## CredentialSchema

Defines the fields, validation, and computed values for a credential type.

### Constructor

```typescript
new CredentialSchema(config: CredentialSchemaConfig)
```

| Parameter                             | Type                                 | Description                                                                                                                                         |
| ------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.id`                           | `string`                             | Unique schema identifier                                                                                                                            |
| `config.name`                         | `string`                             | Human-readable name                                                                                                                                 |
| `config.description`                  | `string?`                            | Optional description                                                                                                                                |
| `config.certificateTypeBase64`        | `string?`                            | Canonical 32-byte type, or a historical short type to hash for new issuance and retain as a local migration alias (default: base64 SHA-256 of `id`) |
| `config.legacyCertificateTypesBase64` | `string[]?`                          | Exact additional short identifiers accepted only when verifying offline persisted credentials                                                       |
| `config.fields`                       | `CredentialFieldSchema[]`            | Field definitions                                                                                                                                   |
| `config.fieldGroups`                  | `{ key, label }[]?`                  | Optional field grouping                                                                                                                             |
| `config.validate`                     | `(values) => string \| null`         | Custom validation function                                                                                                                          |
| `config.computedFields`               | `(values) => Record<string, string>` | Add/transform fields at issuance                                                                                                                    |

### schema.validate()

```typescript
validate(values: Record<string, string>): string | null
```

Validate field values. Returns `null` if valid, or an error message string.

Checks:

1. Every supplied field is declared by the schema
2. Required fields are present and non-empty
3. Email, date, number, checkbox, and select values are in their declared domains
4. Custom `validate` function (if provided)

### schema.computeFields()

```typescript
computeFields(values: Record<string, string>): Record<string, string>
```

Merge computed fields into values. Returns a new object with original values plus computed additions.

### schema.getInfo()

```typescript
getInfo(): {
  id: string
  name: string
  description?: string
  certificateTypeBase64: string
  fieldCount: number
}
```

### schema.getConfig()

```typescript
getConfig(): CredentialSchemaConfig
```

Returns the full configuration object. Used when creating a `CredentialIssuer`.

### Certificate type migration

```typescript
CredentialSchema.getCanonicalCertificateType(schemaId: string): string
CredentialSchema.getLegacyCertificateType(schemaId: string): string
schema.getCertificateTypeMigration(): { canonical: string; legacy: string[] }
```

Pre-0.6 default schemas used base64 of the UTF-8 schema ID. New issuance uses
the 32-byte SHA-256 digest. A short `certificateTypeBase64` or an entry in
`legacyCertificateTypesBase64` is never used for new issuance or remote
metadata; it only scopes historical signature verification to an exact locally
configured identifier.

Current SDK `WalletInterface` methods reject short certificate types, so do
not pass `legacy` values to list, acquire, prove, or relinquish calls. Export
affected records through the storage version that created them, verify the
persisted VC with a locally configured `CredentialIssuer`, and reissue/import a
canonical replacement. There is no automatic wallet rewrite.

## CredentialIssuer

Issues, verifies, and revokes Verifiable Credentials.

### CredentialIssuer.create()

```typescript
static async create(config: CredentialIssuerConfig): Promise<CredentialIssuer>
```

| Parameter                   | Type                       | Required   | Description                                        |
| --------------------------- | -------------------------- | ---------- | -------------------------------------------------- |
| `config.privateKey`         | `string`                   | Yes        | Hex-encoded private key                            |
| `config.schemas`            | `CredentialSchemaConfig[]` | No         | Schema definitions                                 |
| `config.revocation.enabled` | `boolean`                  | No         | Enable on-chain revocation                         |
| `config.revocation.wallet`  | `WalletInterface`          | If enabled | Wallet for creating revocation UTXOs               |
| `config.revocation.store`   | `RevocationStore`          | No         | Storage backend (default: `MemoryRevocationStore`) |

**Throws:** `CredentialError` if revocation is enabled but no wallet is provided.

### issuer.issue()

```typescript
async issue(
  subjectIdentityKey: string,
  schemaId: string,
  fields: Record<string, string>
): Promise<VerifiableCredential>
```

Issue a Verifiable Credential.

| Parameter            | Type                     | Description                     |
| -------------------- | ------------------------ | ------------------------------- |
| `subjectIdentityKey` | `string`                 | Subject's compressed public key |
| `schemaId`           | `string`                 | ID of a registered schema       |
| `fields`             | `Record<string, string>` | Field values                    |

**What happens:**

1. Validates fields against the schema
2. Merges computed fields
3. If revocation enabled: creates a hash-lock UTXO (`OP_SHA256 <hash> OP_EQUAL`, 1 satoshi), saves secret to store
4. Issues a `MasterCertificate`
5. Wraps in W3C Verifiable Credential format

**Throws:** `CredentialError` if schema not found or validation fails.

### issuer.verify()

```typescript
async verify(vc: VerifiableCredential): Promise<VerificationResult>
```

Verify a Verifiable Credential.

**Returns:**

```typescript
{
  valid: boolean      // true if all checks pass
  revoked: boolean    // true if credential has been revoked
  errors: string[]    // list of validation errors
  issuer?: string     // issuer DID
  subject?: string    // subject DID
  type?: string       // credential types joined
}
```

**Checks:**

1. The embedded BSV certificate is canonical, or matches an exact locally configured legacy alias, and its certifier signature verifies
2. The certifier is this issuer
3. Wrapper issuer, subject, schema type, fields, proof, and revocation reference match the signed certificate
4. Revocation status is affirmative in the issuer's store

Wrapper timestamps are not covered by the BSV certificate signature and are
not returned as authenticated authorization facts.

### issuer.revoke()

```typescript
async revoke(serialNumber: string): Promise<{ txid: string }>
```

Revoke a credential by spending its hash-lock UTXO.

| Parameter      | Type     | Description               |
| -------------- | -------- | ------------------------- |
| `serialNumber` | `string` | Certificate serial number |

**What happens:**

1. Loads the revocation record (secret + outpoint) from the store
2. Creates an unlocking script with the secret
3. Spends the hash-lock UTXO
4. Deletes the record from the store

**Throws:** `CredentialError` if revocation is not enabled, or the certificate is not found/already revoked.

### issuer.isRevoked()

```typescript
async isRevoked(serialNumber: string): Promise<boolean>
```

Check if a credential has been revoked. Returns `true` if the revocation record no longer exists in the store.

### issuer.getInfo()

```typescript
getInfo(): {
  publicKey: string
  did: string
  schemas: { id: string; name: string }[]
}
```

## Revocation Stores

### MemoryRevocationStore

In-memory storage for browser and tests.

```typescript
import { MemoryRevocationStore } from '@bsv/simple/browser'
const store = new MemoryRevocationStore()
```

### FileRevocationStore

File-based storage for Node.js servers.

```typescript
const { FileRevocationStore } = await import('@bsv/simple/server')
const store = new FileRevocationStore() // default: .revocation-secrets.json
const store = new FileRevocationStore('/path/to/secrets.json') // custom path
```

> Add the secrets file to `.gitignore`.

### RevocationStore Interface

Both stores implement:

```typescript
interface RevocationStore {
  save(serialNumber: string, record: RevocationRecord): Promise<void>
  load(serialNumber: string): Promise<RevocationRecord | undefined>
  delete(serialNumber: string): Promise<void>
  has(serialNumber: string): Promise<boolean>
  findByOutpoint(outpoint: string): Promise<boolean>
}
```

## Standalone Utilities

### toVerifiableCredential()

```typescript
function toVerifiableCredential(
  cert: CertificateData,
  issuerKey: string,
  options?: { credentialType?: string }
): VerifiableCredential
```

Wrap a BSV `CertificateData` into a W3C Verifiable Credential envelope.

### toVerifiablePresentation()

```typescript
function toVerifiablePresentation(
  credentials: VerifiableCredential[],
  holderKey: string
): VerifiablePresentation
```

Build an unsigned W3C presentation-shaped envelope. It contains no holder
signature, verifier challenge, audience, or replay protection and is not
authentication evidence.

## Wallet Methods

### acquireCredential()

```typescript
async acquireCredential(config: {
  serverUrl: string
  schemaId?: string
  fields?: Record<string, string>
  replaceExisting?: boolean
  fetch?: typeof fetch
}): Promise<VerifiableCredential>
```

Acquire a Verifiable Credential from a remote issuer server.

| Parameter                | Type                     | Default              | Description                                                             |
| ------------------------ | ------------------------ | -------------------- | ----------------------------------------------------------------------- |
| `config.serverUrl`       | `string`                 | _required_           | Credential-free public HTTPS service URL without query or fragment      |
| `config.schemaId`        | `string`                 | —                    | Schema to request                                                       |
| `config.fields`          | `Record<string, string>` | —                    | Field values to submit                                                  |
| `config.replaceExisting` | `boolean`                | `true`               | Import the authenticated replacement before relinquishing older serials |
| `config.fetch`           | `typeof fetch`           | restricted transport | Explicitly trusted override for controlled tests/local development      |

### listCredentials()

```typescript
async listCredentials(config: {
  certifiers: string[]
  types: string[]
  limit?: number
}): Promise<VerifiableCredential[]>
```

List wallet certificates wrapped as Verifiable Credentials.

### createPresentation()

```typescript
createPresentation(credentials: VerifiableCredential[]): VerifiablePresentation
```

Build an unsigned presentation-shaped envelope. **Synchronous and not holder authentication.**
