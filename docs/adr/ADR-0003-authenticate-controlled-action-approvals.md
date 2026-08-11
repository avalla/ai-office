# ADR-0003: Authenticate controlled-action approvals cryptographically

- Status: Deferred to M10
- Date: 2026-08-11

## Context

M6C will allow a human to approve an immutable controlled-action binding before
the daemon can acquire a one-shot execution lease. Neither a caller-supplied
label such as `--actor alice` nor ownership of the daemon Unix socket proves
human identity or user presence. An agent can run under the same OS account and
may be able to invoke ordinary daemon commands.

The application must receive verified evidence from a trusted approval port:

- a stable approver identity;
- the exact verified approval-binding hash;
- authentication evidence that cannot be created from an asserted actor name.

This ADR chooses the minimum production authentication boundary. It does not
implement approval persistence, credentials, commands, or user interfaces.

## Considered options

### Option A: restricted local operator

The daemon and project run on an owner-only machine/account. Approval is exposed
through a separate interactive surface that agents are operationally forbidden
to invoke.

Advantages:

- smallest implementation and packaging cost;
- no key lifecycle or hardware dependency.

Limitations:

- the separation is an operational assumption, not cryptographic evidence;
- a same-account agent that reaches the approval surface can impersonate the
  operator;
- Unix-socket ownership proves account access, not human presence.

This option is acceptable only for an explicitly trusted same-account
deployment. It is not sufficient for production controlled mutation under the
assessment threat model.

### Option B: cryptographic approval credential

Create a dedicated Ed25519 approval key. The public key and stable key identity
are registered with the daemon. A separate interactive approval client displays
the exact binding, obtains a human passphrase/user-presence ceremony, decrypts
the private key only in that process, and signs a domain-separated message
containing the binding hash and approval context. The daemon verifies the
signature and passes structured verified evidence to the application.

Required lifecycle:

- **creation:** generate the key in the approval client with a CSPRNG; encrypt
  the private key at rest using a memory-hard password KDF and authenticated
  encryption; persist only the public key and key ID in daemon authority data;
- **use:** require an interactive ceremony for every approval or a narrowly
  bounded, visibly unlocked session; never accept a signature over an
  application-supplied replacement hash;
- **rotation:** register a new key through an authenticated old-key ceremony,
  give it a new key ID, and retain the old public key for historical signature
  verification;
- **revocation:** append a revocation with an effective security-watermark time;
  reject leases whose approval was signed by a key revoked before lease
  acquisition, while preserving historical evidence;
- **recovery:** use an offline recovery credential or require explicit
  re-enrolment that invalidates pending approvals. Never recover by exporting an
  unencrypted private key or accepting an actor string;
- **loss/compromise:** revoke the key, invalidate its unexecuted approvals, and
  require re-approval with a newly enrolled key.

Advantages:

- provides verifiable evidence independent of caller-controlled text;
- works on local machines without mandatory hardware;
- binds the exact approval hash and supports rotation/revocation.

Limitations:

- passphrase quality and approval-client isolation become security controls;
- a fully compromised same-account process can attempt input capture or process
  inspection;
- secure storage and recovery require careful product design.

### Option C: hardware/user-presence credential

Use FIDO2/WebAuthn or a security key whose authenticator signs an approval
challenge after a user-presence or user-verification ceremony.

Advantages:

- private key material is non-exportable;
- hardware user presence is stronger against same-account software agents;
- mature credential IDs and counters can strengthen audit evidence.

Limitations:

- higher dependency, platform, packaging, and support cost;
- headless/local CLI flows need CTAP/WebAuthn integration;
- credential loss, backup authenticators, attestation policy, rotation, and
  recovery remain product concerns.

This is the preferred hardening path for deployments whose agents share a user
account with the approver, but it is not required for the first local product if
the residual same-account compromise risk is explicitly accepted.

## Decision

Recommend **Option B as the minimum production approval mechanism**, with the
approval port designed so Option C can be added without changing the domain.
Option A alone does not satisfy the M6C threat model.

The trusted approval port returns a value conceptually equivalent to:

```text
VerifiedApprovalEvidence {
  approverIdentity
  keyId
  bindingHash
  signature
  authenticationMethod
  verifiedAt
}
```

The port verifies the signature, key status, domain separation, exact binding,
and authentication ceremony before the application sees this value. CLI/daemon
transport DTOs may carry opaque evidence for verification, but `--actor` and
all other claimed identity strings have zero authorization value.

If encrypted-key lifecycle and an interactive user-presence boundary cannot be
implemented proportionately, all real filesystem mutations remain disabled.
There is no restricted-operator fallback silently enabled by configuration.

## Consequences

- M6C.1 must define a trusted approval-authentication port separately from
  approval persistence.
- Approval rows store verifiable evidence/key identity, not only actor text.
- Key rotation and revocation participate in final execution-time
  revalidation.
- Recovery invalidates pending authority rather than bypassing verification.
- Hardware credentials can implement the same port later.
- This ADR does not authorize filesystem execution; the native boundary ADR and
  all other M6C gates remain independent requirements.
