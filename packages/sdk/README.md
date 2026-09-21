# BSV SDK

[![codecov](https://codecov.io/gh/bsv-blockchain/ts-stack/branch/main/graph/badge.svg?flag=sdk)](https://codecov.io/gh/bsv-blockchain/ts-stack)
[![npm version](https://badge.fury.io/js/@bsv%2Fsdk.svg)](https://badge.fury.io/js/@bsv%2Fsdk)
[![Build Status](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml)

BSV BLOCKCHAIN | Software Development Kit for JavaScript and TypeScript

Welcome to the BSV Blockchain Libraries Project, the comprehensive TypeScript SDK designed to provide an updated and unified layer for developing scalable applications on the BSV Blockchain. This SDK addresses the limitations of previous tools by offering a fresh, peer-to-peer approach, adhering to SPV, and ensuring privacy and scalability.

For application-to-wallet integrations, the SDK exposes the BRC-100 `WalletClient` interface. BSV Desktop and BSV Browser are the BSV Association reference implementations for this interface; vendor distributions such as Babbage's Metanet Desktop / Metanet Explorer and Hudos Browser can implement the same interface with their own branding and service defaults.

The BRC-100 `CreateActionResult` permits AtomicBEEF as either `number[]` or
`Uint8Array`. SDK BRC-29 remittance accepts both wallet representations and
emits a portable `number[]` settlement artifact so HTTP, WebSocket, Message Box,
and JSON transports preserve identical transaction bytes. The same boundary
protects overlay lookup queries and JSON BEEF responses.

AuthFetch gives each authenticated request a private 30-second cancellation
lifecycle. The deadline prevents application dispatch when pending
certificate, session, or wallet work finishes late. The maintained
`SimplifiedFetchTransport` also forwards the optional abort signal to handshake
and application fetches. Stale-session recovery and authenticated-to-plain
fallback keep the original absolute deadline; they do not receive a fresh
30-second window, and plain fallback I/O is aborted when that budget expires.
The built-in AuthFetch certificate listener also receives the signal, so a late
wallet result cannot dispatch certificate disclosure. Custom certificate-request
listeners should honor their optional third signal argument. AuthFetch does not cancel an
already displayed wallet approval prompt; the late result is ignored. Custom `Transport`
implementations must check the optional signal before any delayed side-effect
dispatch and forward it to cancellation-aware I/O. A transport that ignores
the signal after `send` begins may still dispatch after the AuthFetch promise
times out. The timeout message remains
`Timed out waiting for authenticated response.` and its non-secret `details`
contain the request ID plus `dispatchState: 'not-dispatched'` or
`'possibly-dispatched'`. For the application request, Peer marks the latter
immediately before entering the transport, so it conservatively includes
delayed or cancellation-ignoring custom transports. The server may still
complete such a request; callers must resolve its outcome before retrying a
non-idempotent write. AuthFetch does not automatically retry after the deadline.

The in-memory `SessionManager` atomically coordinates authentication and
cancellation. Durable `AsyncSessionManager` implementations may provide the
optional pair `updateSessionIfUnauthenticated(session)` and
`removeSessionIfUnauthenticated(sessionNonce)`. Both operations must be atomic:
the update returns `true` only when it transitioned the still-unauthenticated
row, while the remove deletes only that state. Peer enables durable cleanup
only when both methods exist. Legacy or partially upgraded async stores remain
compatible; Peer leaves their cancelled row for normal TTL or session
maintenance instead of risking a delete followed by a stale authenticated
upsert from another replica.

The exact packed browser graph measures 748,462 raw bytes with Vite, 564,695
with esbuild, and 559,748 in UMD. The reviewed raw ceilings are 749,000,
566,000, and 560,500 bytes respectively; every gzip and Brotli ceiling remains
unchanged.

For signature payloads of at least 64 KiB, `ProtoWallet` uses asynchronous
platform SHA-256 when Web Crypto is available, avoiding long synchronous
hashing on browser UI threads. Unsupported or failed native hashing falls back
to the existing implementation using the same input snapshot. Short payloads,
explicit digests, signature bytes, and verification rules remain compatible.
No host registration or API migration is required. The additional portable
path measures 742,126 raw bytes in the SDK Vite fixture and 555,548 raw bytes
in UMD; their reviewed ceilings are 742,500 and 556,000 bytes respectively.
The combined sync and security candidate measures 560,560 raw bytes with esbuild;
its reviewed raw ceiling is 561,000 bytes. Compression ceilings are unchanged.

## Zero-field certificate proofs (local source candidate)

The local 2.6.1 patch candidate supports BRC-52 zero-field proofs in the
`initialResponse` handshake path. A locally retained request must name the
exact issuer and certificate type with `fields=[]`. Validation checks the
subject and issuer-signed encrypted core, then accepts an empty or nullish
keyring without calling `decryptFields` or the verifier wallet's `decrypt`.
Any keyring entry is refused for that zero-field request. This proves no hidden
plaintext field value. Existing nonempty-field decryption is unchanged.

The holder still calls `proveCertificate` with the exact verifier, certificate,
and empty field list. Wallet permission denial must propagate; zero disclosure
does not bypass that permission decision. The SDK tests use real cryptography
with fixture certificate storage and permission decisions; they do not prove
wallet-toolbox or DCAP integration.

The initiator snapshots its request when starting the handshake. For zero-field support, custom
`AsyncSessionManager` implementations must preserve the optional
`PeerSession.requestedCertificates` snapshot. Legacy stores that omit it retain
existing nonempty-disclosure and no-certificate behavior, but zero-field
validation fails closed. A response from a different explicitly requested identity is refused.

Standalone `certificateResponse` messages with an empty or nullish keyring
remain unsupported, including responses to mid-session zero-field requests.
That path has no authoritative response-bound request, and the inbound
`requestedCertificates` field must not enable zero-field acceptance. The
existing nonempty standalone path is retained. This candidate does not fix
standalone request provenance ([upstream #491](https://github.com/bsv-blockchain/ts-stack/issues/491)),
listener admission ordering ([#492](https://github.com/bsv-blockchain/ts-stack/issues/492)),
or provide replay protection. An initial-response replay can still reach the
certificate listener; `verifyNonce` checks token provenance, not single use.
Consumers remain responsible for session authorization and freshness.

The initial-response implementation reuses local metadata bindings and releases
waiters directly after certificate validation. This reduces its browser artifact
without changing validation guards, callback order, or package budgets.

This is a local source candidate, not a published or deployed version. There is
no wire-format change, and full zero-field BRC-103 support remains incomplete.

## Table of Contents

1. [Objective](#objective)
2. [Getting Started](#getting-started)
3. [Features & Deliverables](#features--deliverables)
4. [Documentation](#documentation)
5. [Development and Distribution](#development-and-distribution)
6. [Contribution Guidelines](#contribution-guidelines)
7. [Support & Contacts](#support--contacts)

## Objective

The BSV Blockchain Libraries Project aims to structure and maintain a middleware layer of the BSV Blockchain technology stack. By facilitating the development and maintenance of core libraries, it serves as an essential toolkit for developers looking to build on the BSV Blockchain.

## Getting Started

### Installation

To install the SDK, run:

```bash
npm install @bsv/sdk
```

### Basic Usage

Here's a simple example of using the SDK to create and sign a transaction:

```javascript
import { PrivateKey, P2PKH, Transaction, ARC } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')

const sourceTransaction = Transaction.fromHex(
  '0200000001849c6419aec8b65d747cb72282cc02f3fc26dd018b46962f5de48957fac50528020000006a473044022008a60c611f3b48eaf0d07b5425d75f6ce65c3730bd43e6208560648081f9661b0220278fa51877100054d0d08e38e069b0afdb4f0f9d38844c68ee2233ace8e0de2141210360cd30f72e805be1f00d53f9ccd47dfd249cbb65b0d4aee5cfaf005a5258be37ffffffff03d0070000000000001976a914acc4d7c37bc9d0be0a4987483058a2d842f2265d88ac75330100000000001976a914db5b7964eecb19fcab929bf6bd29297ec005d52988ac809f7c09000000001976a914c0b0a42e92f062bdbc6a881b1777eed1213c19eb88ac00000000'
)

const version = 1
const input = {
  sourceTransaction,
  sourceOutputIndex: 0,
  unlockingScriptTemplate: new P2PKH().unlock(privKey)
}
const output = {
  lockingScript: new P2PKH().lock(privKey.toAddress()),
  change: true
}

const tx = new Transaction(version, [input], [output])
await tx.fee()
await tx.sign()

await tx.broadcast()
```

For a more detailed tutorial and advanced examples, check our [Documentation](#documentation).

## Features & Deliverables

- **Sound Cryptographic Primitives**: Secure key management, signature computations, and encryption protocols.

- **Script Level Constructs**: Network-compliant script interpreter with support for custom scripts and serialization formats.

- **Transaction Construction and Signing**: Comprehensive transaction builder API, ensuring versatile and secure transaction creation.

- **Transaction Broadcast Management**: Mechanisms to send transactions to both miners and overlays, ensuring extensibility and future-proofing.

- **Merkle Proof Verification**: Tools for representing and verifying merkle proofs, adhering to various serialization standards.

- **Serializable SPV Structures**: Structures and interfaces for full SPV verification.

- **Secure Encryption and Signed Messages**: Enhanced mechanisms for encryption and digital signatures, replacing outdated methods.

- **P2P Authentication**: Robust peer-to-peer authentication mechanisms to ensure secure connections between parties.

  Authenticated HTTP handshakes register their response waiter before sending,
  and each authenticated request has a bounded 30-second response window. A
  client retains at most 1,000 pending authenticated requests. Invalid or
  rejected peer responses reject and clean up the owning request; they do not
  become unhandled process errors or leave listeners behind.

  For BRC-105 payments, a recipient may include the optional
  `x-bsv-payment-known-txids` response header on its 402 challenge. The value is
  a comma-separated list of 64-character hexadecimal transaction IDs the
  recipient already possesses and has validated. `AuthFetch` passes at most
  256 unique lowercase IDs to the wallet's `createAction` options, including
  when payment requirements change and a new transaction is created. This
  lets compatible wallets omit known ancestors from payment BEEF. Whitespace,
  duplicates, and malformed entries are ignored; an absent or invalid-only
  header preserves existing payment behavior. Browser services must expose
  the optional response header through their existing CORS policy.
  The header is an optional SDK extension, not a standardized BRC-105 header.

- **Identity**: Comprehensive identity management system supporting identity verification and certificate management.

- **Key Value Store**: Distributed key-value store for decentralized data storage and retrieval.

Identity publication rejects a certificate unless its certifier signature
verifies affirmatively. `GlobalKVStore` likewise treats overlay responses as
untrusted and returns only entries with a valid controller signature; a
verification error or `valid: false` result is rejected.

- **Distributed Storage**: Scalable and secure distributed data storage solutions to support blockchain applications.

- **Wallet Interface**: Standardized interface for wallet operations, supporting multiple cryptocurrencies and protocols.

- **Overlay Tools**: Advanced tools for overlay network management and optimization.

- **Distributed Protocol and Certificate Registration**: Efficient systems for registering and managing distributed protocols and certificates.

## Documentation

Comprehensive documentation is available in several formats:

- **[📚 Online Documentation](https://bsv-blockchain.github.io/ts-stack/packages/sdk/)**: Our complete documentation:
  - **[🚀 Get Started](https://bsv-blockchain.github.io/ts-stack/get-started/)**: Step-by-step lessons to learn by doing
  - **[🔧 How-To Guides](https://bsv-blockchain.github.io/ts-stack/guides/)**: Practical solutions to specific problems
  - **[📚 Reference](https://bsv-blockchain.github.io/ts-stack/reference/)**: Complete technical specifications and API documentation
  - **[🏗️ Architecture](https://bsv-blockchain.github.io/ts-stack/architecture/)**: Architecture and design explanations
- **[⚡ Examples](https://docs.bsvblockchain.org/guides/sdks/ts/examples)**: Practical code examples
- **Code Annotations**: The SDK is richly documented with code-level annotations that show up in editors like VSCode

## Development and Distribution

The workspace requires Node.js 24.11 or newer and pnpm 10. Install from the
repository root, then run the SDK's complete contract:

```bash
pnpm install
pnpm --filter @bsv/sdk format:check
pnpm --filter @bsv/sdk lint
pnpm --filter @bsv/sdk typecheck
pnpm --filter @bsv/sdk test:coverage
pnpm --filter @bsv/sdk pack:check
pnpm --filter @bsv/sdk test:browser
pnpm --filter @bsv/sdk test:resource
```

`test:resource` is not part of the PR suite: it allocates more than 500 MiB to
verify the AES-GCM 2^32-bit length boundary. Run it only on a suitable isolated
machine and record release evidence when AES-GCM length handling changes.

`pack:check` installs the exact generated tarball into ESM and CommonJS
consumer projects and verifies public exports and conditional type resolution.
`test:browser` independently bundles that tarball with Vite and esbuild,
rejects Node/server dependencies, validates source maps, and enforces measured
raw, gzip, and Brotli budgets. The package publishes ESM, CommonJS, and a
classic UMD bundle; TypeScript declarations are selected through matching
conditional exports.

Publishing is performed only by the repository release workflow after these
checks pass. Local development and validation must not rewrite versions or
publish artifacts.

## Contribution Guidelines

We're always looking for contributors to help us improve the SDK. Whether it's bug reports, feature requests, or pull requests - all contributions are welcome.

1. **Fork & Clone**: Fork this repository and clone it to your local machine.
2. **Set Up**: Run `pnpm install` at the `ts-stack` repository root.
3. **Make Changes**: Create a new branch and make your changes.
4. **Test**: Run the package checks listed in
   [Development and Distribution](#development-and-distribution).
5. **Commit**: Commit your changes and push to your fork.
6. **Pull Request**: Open a pull request from your fork to this repository.
   For more details, check the
   [repository contribution guidelines](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md).

For information on past releases, check out the [changelog](./CHANGELOG.md). For future plans, check the [roadmap](./ROADMAP.md)!

## Support & Contacts

Project Owners: Thomas Giacomo and Darren Kellenschwiler

Development Team Lead: Ty Everett

For questions, bug reports, or feature requests, please open an issue on GitHub or contact us directly.

## License

TS Stack first-party material is under the [Open BSV License Version 6](./LICENSE.txt).
Incorporated material remains under the separate terms identified in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), with complete texts in
[LICENSES/](./LICENSES/). Keep all three payloads with source and binary distributions.

Thank you for being a part of the BSV Blockchain Libraries Project. Let's build the future of BSV Blockchain together!
