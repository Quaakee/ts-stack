# Bounded byte snapshot consolidation

The Atlas maintained fork reduces temporary allocation while preserving the
existing authentication and wallet-response trust boundaries. This is a local,
content-addressed fork artifact, not an npm publication or an upstream version
upgrade. Its base is `4ab82d768114f8fb6d98a7cc044e5affbdab020c`.

Authentication snapshots capture each array element's own data descriptor once
and retain its value instead of retaining a descriptor object for every byte.
Captured array construction and indexed classification keep the resulting buffer
away from replaceable array methods. Sparse/accessor checks, traversal order,
node/depth limits and the existing 16 MiB accounting remain unchanged.

HTTP wallet responses still undergo raw validation, historical byte recovery,
shape validation, status/error handling and operation-specific validation in that
order. A fresh private scope tracks buffers copied during this one synchronous
boundary. Later graph walks reuse those buffers while charging every node and
aggregate byte again, including new historical byte arrays. Captured intrinsic
operations keep owned data private across normalization and the response status
getter. Public validators always create fresh defensive copies; returned data
cannot become trusted input to a later call merely because it was owned before.

No authentication, signature, hash, schema, transaction, resource or affirmative
wallet-result check is removed. No wire, persistence, runtime, public package-root
API or account migration is required. A custom HTTP adapter continues to receive
the same validation errors and status ordering. Historical numeric records in
recognized byte fields retain existing recovery; opaque records remain records.

The change has compatible PATCH impact if proposed for a future upstream
publication. This private fork retains the existing `2.8.2` package identity and
exact peer compatibility, with a new immutable tarball digest and source
provenance. It does not replace the old artifact at the same path. Atlas's
governed TypeScript consumers must move their pins together; frozen relay
conformance tooling and separately frozen provider inputs remain separate.

Security regression suites cover aliasing, mutation after snapshotting, changing
Proxy descriptors, hostile methods and prototype setters, malformed/truncated
cryptographic results, shared buffers, full-size media parity, and post-recovery
resource accounting. Performance evidence must compare the exact old and new
artifacts. Synthetic Node/WebKit timing is not installed application acceptance
or a measurement of network, native wallet, decryption, or visible frame latency.
