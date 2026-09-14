# Bounded wallet sync transfers, version 1

This optional transport carries complete BRC-40 request/response objects across
HTTP message limits. It does not change the BRC-40 entity order, inclusive
watermark, ID maps, tombstones, merge rules, or completion condition. Ordinary
pages continue to use `getSyncChunk` and `processSyncChunk`.

## Negotiation and limits

For HTTP/1.1 reverse proxies, keep the proxy's idle connection reuse shorter
than the server's five-second keep-alive timeout. For example, a Caddy upstream
transport can use `keepalive 2s`. Caddy documents that a longer proxy timeout can
cause connection resets and HTTP 502 responses for POST requests; successful
GET health checks do not rule this out. Fix the connection lifetime mismatch
rather than enabling unconditional write retries. See the
[Caddy transport documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#the-http-transport).

A migrated Knex-backed `StorageServer` advertises `syncTransfer` in runtime
settings: `{ version: 1, maxBytes, partBytes, inlineBytes, binaryTransport? }`.
`binaryTransport: { version: 1, inlineBytes }` advertises raw HTTP sync. These are
transport capabilities, not persisted settings columns. `syncTransfers: false` disables
advertisement and transfer RPCs during a mixed-version deployment. A client
must not infer support from compact checkpoints or binary JSON alone.

`inlineBytes` bounds the serialized JSON-RPC message, not the raw transfer frame.
Base64 expansion can push a frame below 4 MiB over a 4 MiB inline ceiling.
`StorageServer` accepts `syncTransferInlineBytes` (1024–67108864 bytes), clamped to
the existing HTTP-derived ceiling. For example, 262144 favors bounded transfers
on slower links. Its default retains the existing advertised ceiling; other RPC
limits, authentication deadlines, validation and schema are unchanged. Old peers
without transfer negotiation retain their existing response behavior.

New clients prefer raw binary when the provider advertises version 1. They POST
frames to `/sync/v1` using `application/octet-stream`, for ordinary sync pages
and all six transfer methods. Responses use the same frame and include the
BRC-103-signed `x-bsv-binary-encoding: sync-v1` header, already exposed by the
default browser CORS policy. BRC-103 authentication verifies
the exact request bytes before decoding; existing authorization, pricing,
validation and checkpoint logic then process the original RPC object. The body
is raw bytes on HTTP, with no base64 wrapper. Ordinary wallet RPCs remain JSON.

Raw inline pages default to at most 1 MiB. This avoids staging ordinary medium
pages across several authenticated round trips. `binaryTransport.inlineBytes` bounds
the raw RPC envelope, independently of the legacy JSON ceiling. Larger pages use
parts of at most 256 KiB plus bounded framing metadata. Both ceilings and part
size respect configured HTTP body/response limits. `StorageClient` and
`StorageMobile` accept `binarySync: false` to keep a connection on JSON.

For a rolling deployment, set `syncBinaryTransport: false` until every replica
and reverse proxy serves `/sync/v1`, then enable advertisement and reconnect
clients. Legacy providers and unknown future transport versions continue using
the existing authenticated JSON transfer methods. A failed write is never
silently resent using another transport. The new route does not require a new
migration beyond the transfer tables already introduced in 2.13.0; rolling back
from this release to 2.13.0 preserves those tables and committed wallet data.

Local IndexedDB copies separately upgrade automatically to schema 7. Timestamp
and ownership indexes let the source select keys before materializing a page,
without repeatedly loading preceding transaction/proof bytes. Key metadata scales
with the wallet; ownership queries have at most 128 requests in flight. The
upgrade preserves existing records and duplicate transaction IDs. A retained copy
requires a schema-7-compatible client afterward; older clients cannot open it.
This local index upgrade adds no SQLite/MySQL wallet migration.

Version 1 accepts frames up to 64 MiB. With older peers, parts are carried by the
existing authenticated binary-JSON codec. The frame itself stores binary fields
directly, avoiding a second base64 encoding. The server
uses smaller parts for smaller request or response limits, and leaves this
feature disabled when either limit is below 4096 bytes. This is bounded transfer of
large records, not unlimited-size or constant-memory database streaming: the
current storage and merge APIs still materialize a complete record/page. Records
above the advertised limit fail explicitly; they are never skipped.

## Framing and integrity

A frame starts with a four-byte unsigned big-endian JSON-header byte length,
followed by that many UTF-8 bytes encoded with the existing binary-JSON escaping
rules. The header is `{ version: 1, value, fields }`. Each `fields` entry is
`{ path, length }`: `path` identifies a null placeholder in `value` using object
keys or numeric array indices. Raw field bytes follow the header in entry order.
Dates retain their existing ISO JSON representation. Only actual byte views are
extracted; sync callers first select the declared binary fields with
`syncChunkBinary`. Ordinary numeric arrays retain their semantics.

Decoders reject invalid lengths, missing/duplicate placeholders, unsafe paths,
more than 4096 byte fields, paths deeper than 64 levels, trailing bytes, and
unsupported versions. The manifest SHA-256 covers the entire frame. A receiver
must verify it before decoding and merging. BRC-103 authentication additionally
binds every request/response to the authenticated session.

## RPC sequence

After negotiation a `getSyncChunk` request can include `syncTransferVersion: 1`.
If its normal response exceeds the advertised inline ceiling (or HTTP ceiling), the server returns
`{ syncTransfer: manifest }` in the JSON-RPC result instead of HTTP 413. The
client reads, verifies and decodes the staged frame before exposing the ordinary
`SyncChunk` to its caller. If an inline read fails with a transient network error
(including browser `Load failed`), a provider advertising transfer support is
retried through `beginReadSyncTransfer` and bounded parts. Authentication and
semantic errors still fail. Immutable part reads/writes have at most three
attempts with backoff; committing a wallet mutation is never blindly retried. Requests without the hint keep their legacy response
shape. This avoids repeated oversized responses and repeated source queries.

Every transfer method takes one object in `params`, including the authenticated
`identityKey`. Method arguments below are additional fields in that object.

- `beginReadSyncTransfer`: `{ args: RequestSyncChunkArgs }` returns a manifest.
  The source validates the ordinary sync request and stages an immutable frame.
- `readSyncTransferPart`: `{ transferId, offset }` returns `{ offset, bytes }`.
  Offsets are aligned to `partBytes`; the final part may be shorter.
- `beginWriteSyncTransfer`: `{ digest, totalBytes }` returns a manifest plus
  `receivedBytes`. Identical staged uploads resume after process restarts.
- `writeSyncTransferPart`: `{ transferId, offset, bytes }` returns the next byte
  offset. An identical replay is accepted; changed or out-of-order bytes fail.
- `commitSyncTransfer`: `{ transferId }` verifies a complete frame containing
  `{ args, chunk }`, validates the wallet/storage identities and proofs, then
  invokes the existing atomic page merge with a matching-checkpoint guard.
- `releaseSyncTransfer`: `{ transferId }` removes only staging data.

Manifests contain `{ transferId, digest, totalBytes, partBytes, expiresAt }`.
Identifiers and hashes are 64 lowercase hexadecimal characters. Expiry is Unix
milliseconds. Transfer identifiers never grant access: all lookups also require
the authenticated wallet identity. Unknown/expired and another user's transfers
produce the same unavailable response.

## Recovery and resource ownership

The additive `2026-09-09-001` migration creates `sync_transfers` and
`sync_transfer_parts`. Eight fixed staging slots, at most two per identity,
bound storage to at most 512 MiB of frame data, plus metadata/database overhead.
Allocation and part updates serialize through a database row lock, shared across
replicas. Expired staging is reclaimed on subsequent allocation. The fixed
15-minute expiry bounds retention but may require restarting an expired record.
Staging is storage-global operational data and is excluded from BRC-38 exports.

Uploads retain acknowledged pieces across client/server restart. Interrupted
downloads can retry individual immutable pieces within an attempt; after an app
restart, sync resumes at the last durable BRC-40 record checkpoint and may
re-download the incomplete record. No partial record becomes wallet data.

A lost commit acknowledgement is not automatically replayed by the client.
Retrying sync first rereads the writer checkpoint. A staged commit requires its
watermark and offsets to match the current durable checkpoint under the page
transaction; stale commits cannot advance counters twice. Completed transfer
results are retained until release/expiry, including after a server restart.

When upgrading from a release **before 2.13.0**, run the wallet migration before
enabling transfer support on every replica. For rollback to a pre-transfer runtime, stop transfer traffic, preserve the current database, then use the
new runtime's Knex migration source to run **only** this migration down (including
its ledger entry) before restarting the old runtime. This removes incomplete
staging, not wallet records or committed checkpoints; clients can resume those
records. Merely leaving an unknown migration in the ledger can prevent an older
runtime from starting. Never restore an older database over later wallet writes.
The SQLite migration is transactional; table/slot creation is also restart-safe
for MySQL's implicit DDL commits.

## Standards scope

BRC-40 is transport-agnostic. This framing is an optional transport extension;
its reassembled objects retain BRC-40 semantics. Legacy peers still use ordinary
pages and cannot transfer records above their message limits.

BRC-38 specifies canonical portable wallet exports, and BRC-39 specifies their
password-encrypted wrapper. This transport changes neither file format. A live
IndexedDB replica is not itself a BRC-38 or BRC-39 export file. Passing portable
export/import regression tests is evidence for those tested paths, not a blanket
claim that every wallet feature or legacy migration is strictly conformant.

## Reproducing the transport comparison

Run `pnpm --filter @bsv/wallet-toolbox bench:sync-transport`. It uploads and
restores a synthetic 3.75 MiB record through authenticated loopback HTTP using
identical 256 KiB parts, alternating raw and base64 JSON across six trials.
It reports actual request/response body bytes and verifies restored hashes and
unchanged repeat sync. HTTP headers and TLS overhead are excluded. Wall times
depend on the machine and concurrent work; this is not a production throughput
claim or a full-wallet benchmark. The fixture never funds or broadcasts a transaction.

## Artifact cost requiring review

The raw HTTP exchange adds portable code to the existing framing, integrity,
adaptive controller and proof-provider support. Exact packed macOS consumers
measured the following bytes for the 2.14.0 candidate. Relative to the prior
recorded artifacts, raw growth is 1,725 bytes (Vite), 1,521 (esbuild), 1,692
(Metro), and 2,718 (Hermes). Browser gzip growth is below 500 bytes. No dependency
is added. Only exceeded raw/Brotli ceilings advance; existing gzip allowances
remain. Hermes compression varies slightly with build paths.

The subsequent IndexedDB source paging and customization guard add 3,727 Vite
and 2,915 esbuild raw bytes relative to the initial raw-transport candidate. Only
these two raw ceilings initially increased; gzip and Brotli limits were unchanged.
A native large-wallet sample returned the identical 64-record page in 270 ms
versus 5,539 ms through the original reader. This is one source-query comparison,
not whole-wallet throughput evidence.

Reusing ownership joins inside a readonly page snapshot adds another 683 Vite
and 431 esbuild raw bytes. It prevents repeated prefix joins within the source's
size-aware queries, while each new page sees later writes. This explicit cost
advances the exceeded Vite raw/gzip/Brotli and esbuild gzip/Brotli ceilings shown below;
the checker remains strict. A concurrent-reader guard keeps callers from mutating
the same cached prefix. No new dependency or server code enters the browser.

| Artifact | Raw | Gzip | Brotli | Raw ceiling | Gzip ceiling | Brotli ceiling |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vite | 1,722,285 | 406,733 | 318,029 | 1,723,000 | 406,800 | 318,300 |
| esbuild | 1,343,667 | 369,610 | 297,093 | 1,344,000 | 369,700 | 297,200 |
| Metro | 1,768,739 | 449,430 | 348,088 | 1,770,000 | 455,000 | 360,000 |
| Hermes | 3,589,715 | 1,441,493 | 1,133,833 | 3,591,000 | 1,460,500 | 1,135,000 |

Before upstream integration, Linux CI measured Vite gzip at 404,970 and Hermes
gzip at 1,457,902, above the corresponding macOS measurements. The combined
ceilings retain that platform allowance and the upstream security artifact costs.
The combined Linux esbuild artifact measured 369,222 gzip bytes; its ceiling is
369,700 bytes after the source-page snapshot addition. The complete hosted platform checks must pass these limits before
review.

Browser composition contains only the existing SDK, wallet client, noble hashes,
hash-wasm and IndexedDB dependencies. No Node storage or new dependency enters
the graph. Server staging and RPC proof orchestration remain outside
browser/mobile exports. The SDK's combined esbuild consumer measures 560,560 raw
bytes against a 561,000-byte ceiling; its compressed ceilings are unchanged.

These are explicit feature costs requiring maintainer review under the repository
artifact-growth policy, not claims of reduced application bundle size.
