# @bsv/did

`@bsv/did` is a BSV SDK compatibility layer for SD-JWT VC credentials and optional `did:key` identifiers.

It does not change the SDK. It uses BSV secp256k1 keys as JOSE `ES256K` keys, exposes those keys as `cnf.jwk` holder-binding material, and produces SD-JWT VC presentations with optional Key Binding JWTs.

## Standards

- [RFC 9901: Selective Disclosure for JSON Web Tokens](https://www.rfc-editor.org/rfc/rfc9901.html)
- [SD-JWT-based Verifiable Credentials, draft-ietf-oauth-sd-jwt-vc-16](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-sd-jwt-vc)
- [DID Core v1.0](https://www.w3.org/TR/did-core/)
- [did:key Method v0.9](https://w3c-ccg.github.io/did-key-spec/)

## Important Algorithm Note

JOSE `ES256` means ECDSA over P-256. BSV identity keys are secp256k1, so this package emits `ES256K`.

That is the correct JOSE algorithm for BSV keys. Some EUDI/eIDAS profiles might require P-256 `ES256`; those profiles will need a P-256 holder/issuer key mode in addition to BSV identity-key mode.

## Install

```sh
pnpm add @bsv/did
```

## DID Key

```ts
import { PrivateKey } from '@bsv/sdk'
import { BsvDid } from '@bsv/did'

const privateKey = PrivateKey.fromRandom()
const did = BsvDid.fromPublicKey(privateKey.toPublicKey().toDER() as number[])
const didDocument = BsvDid.toDidDocument(did)
const qrSvg = BsvDid.generateQrCode(did, 'did')
```

## Issue an SD-JWT VC

```ts
import { PrivateKey } from '@bsv/sdk'
import { BsvDid, SdJwtVcIssuer } from '@bsv/did'

const issuerPrivateKey = PrivateKey.fromRandom()
const holderPrivateKey = PrivateKey.fromRandom()
const issuer = BsvDid.fromPublicKey(issuerPrivateKey.toPublicKey().toDER() as number[])

const vc = await SdJwtVcIssuer.create({
  issuer,
  issuerPrivateKey,
  holderPublicKey: holderPrivateKey.toPublicKey(),
  vct: 'https://credentials.example.com/identity_credential',
  claims: {
    given_name: 'Alice',
    family_name: 'Ng',
    email: 'alice@example.com',
    is_over_21: true
  },
  disclosureFrame: {
    given_name: true,
    email: true,
    is_over_21: true
  }
})
```

The issued `vc.sdJwt` contains the issuer-signed JWT, all Disclosures, and a final `~`, following RFC 9901 section 4.

## Present Selectively

```ts
import { SdJwtVcHolder, SdJwtVcPresenter } from '@bsv/did'

const presentation = await SdJwtVcHolder.generatePresentation(vc, ['given_name', 'is_over_21'], {
  holderPrivateKey,
  audience: 'https://verifier.example',
  nonce: 'verifier-nonce',
  verificationOptions: {
    expectedIssuer: issuer,
    expectedVct: 'https://credentials.example.com/identity_credential'
  }
})

const wirePayload = SdJwtVcPresenter.present(presentation)
```

When `holderPrivateKey` is supplied, the holder creates a KB-JWT with `sd_hash`, `aud`, `nonce`, and `iat`.

## Verify

```ts
import { SdJwtVcVerifier } from '@bsv/did'

const result = await SdJwtVcVerifier.verify(wirePayload, {
  expectedIssuer: issuer,
  expectedVct: 'https://credentials.example.com/identity_credential',
  expectedAudience: 'https://verifier.example',
  expectedNonce: 'verifier-nonce',
  requireKeyBinding: true
})

if (result.verified) {
  console.log(result.disclosedClaims)
}
```

If the issuer is a `did:key`, the verifier derives the signing key from `iss` and rejects a configured key that does not match it. Otherwise, pass an `issuerPublicKey` obtained from a local trust policy. A JWT's own `jwk`, `jku`, or certificate header is never an issuer trust anchor.

`verified` means that the signed issuer identity, credential type, validity window, disclosures, and requested Key Binding policy all passed. A self-certifying `did:key` proves which key signed; it does not by itself authorize that issuer for an application. Set `expectedIssuer` and `expectedVct`, or apply an equivalent local allowlist, before granting access. If `aud` is present in the credential itself, set `expectedCredentialAudience`.

For replay-safe authorization, Key Binding requires both the verifier's exact audience and a transaction-specific nonce. The high-level verifier enforces both whenever Key Binding is required; the low-level helpers continue to accept legacy KB-JWTs with omitted `aud` or `nonce`, but those unbound tokens must not be used to authorize a transaction. KB-JWTs are rejected when their `iat` is in the future or older than five minutes by default; `clockToleranceSeconds`, `maxKeyBindingAgeSeconds`, and `now` allow bounded policy and deterministic tests. Supplying an expected audience or nonce automatically requires Key Binding.

The verifier validates `iat`, `nbf`, and `exp`, but it does not retrieve or evaluate a credential status list or type-metadata document. A signed `status` claim remains application input: check it under the relevant credential policy before authorization.

The Holder validates the issuer-signed credential and all supplied Disclosures before it selects claims or creates a KB-JWT. For non-`did:key` issuers, provide the trusted issuer key through `verificationOptions`. The Holder also proves that the supplied holder private key matches the signed `cnf.jwk`. Nested disclosure requests use full dotted paths such as `address.locality`; unknown or ambiguous paths fail rather than disclosing claims with the same short name elsewhere.

## Input and ownership limits

Compact JWT, JSON, disclosure count/size/depth, identifier, in-memory store, and QR inputs have fixed defensive limits. JSON must be strict UTF-8 without duplicate keys, accessors, sparse arrays, cycles, non-finite numbers, or unpaired Unicode surrogates. SD-JWT processing rejects duplicate digest placement, cleartext/disclosed-name collisions, reserved claim names, nested `_sd_alg`, malformed array placeholders, and disconnected Disclosures. RFC 9901 recursive object and array Disclosures are processed with their complete ancestor chain.

Returned payloads, Disclosure arrays, stored credentials, keys, and JWK-derived objects are owned copies. `SdJwtVcHolder.store` is only a bounded process-local convenience store; adding a credential does not make its issuer trusted and it is not durable storage. QR colors are restricted to hexadecimal CSS colors so generated SVG cannot contain external paint-server URLs.

## Public API

- `BsvDid`
- `SdJwtVcIssuer`
- `SdJwtVcHolder`
- `SdJwtVcPresenter`
- `SdJwtVcVerifier`
- `publicKeyToJwk`, `privateKeyToJwk`, `jwkToPublicKey`
- `parseSdJwt`, `serializeSdJwt`, `parseDisclosure`, `disclosureDigest`

## License

Open BSV License Version 6. See [LICENSE.txt](./LICENSE.txt).
