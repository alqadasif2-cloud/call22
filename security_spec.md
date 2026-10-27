# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Zero-Trust Tenant Isolation (`uid` & `ownerId`)**:
   - Every path is strictly scoped under `/users/{uid}/...` where `request.auth != null` and `request.auth.uid == uid`.
   - Every write operation requires a verified email (`request.auth.token.email_verified == true`).
   - All mutable or listable documents (`Device`, `EncRecord`) embed `ownerId == request.auth.uid` (and `CryptoMeta` embeds `uid == request.auth.uid`), enforced at creation and locked as immutable on update.
2. **Immutable Cryptographic Root (`/users/{uid}/meta/crypto`)**:
   - Only `metaId == 'crypto'` may exist in `/users/{uid}/meta/{metaId}`.
   - `CryptoMeta` can only be created once (`allow update: if false;`) and deleted only by the verified owner (during full account/vault reset). `list` is disallowed.
3. **Master Gate Relational Integrity (`/users/{uid}/devices/{deviceId}/records/{recId}`)**:
   - An encrypted record (`EncRecord`) cannot be created, read (`get`), updated, or deleted unless its parent `/users/{uid}/devices/{deviceId}` document exists AND `get(...).data.ownerId == request.auth.uid`.
   - Deleting a parent device immediately revokes single-document access and write capability to all child `records`.
4. **Secure List Queries & Cost Guard**:
   - `allow list` on `devices` and `records` explicitly checks `resource.data.ownerId == request.auth.uid` with zero `get()` or `exists()` calls inside `list` blocks.
5. **Strict Volumetric, Key, & Temporal Integrity**:
   - All document IDs (`uid`, `deviceId`, `recId`) match `^[a-zA-Z0-9_\-]+$` with length `1..128`.
   - All `create` payloads enforce `hasAll` + `hasOnly` and server timestamps (`createdAt == request.time`, `updatedAt == request.time`).
   - All `update` payloads wrap `isValid[Entity](incoming())`, enforce immutable fields (`ownerId`, `deviceId`, `type`, `ts`, `v`, `createdAt`), enforce `updatedAt == request.time`, and restrict mutations via action-based `affectedKeys().hasOnly(...)`.

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 — Cross-Tenant Identity Spoofing (`ownerId` Mismatch)**:
   Authenticated user `alice` writes `/users/alice/devices/dev_1` with `"ownerId": "bob"`.
2. **Payload 2 — Unverified Email Spoof Write**:
   Authenticated user `alice` with `email_verified: false` attempts to create `/users/alice/meta/crypto`.
3. **Payload 3 — Shadow Field Injection on Create**:
   User `alice` creates `/users/alice/devices/dev_1` with all required keys plus `"isAdmin": true`.
4. **Payload 4 — Crypto Root Overwrite (`meta/crypto` Update)**:
   User `alice` attempts to `update` `/users/alice/meta/crypto` to swap out the PBKDF2 `salt` after creation.
5. **Payload 5 — Orphaned Record Write (Missing Parent Device)**:
   User `alice` writes `/users/alice/devices/ghost_device/records/rec_1` when `/users/alice/devices/ghost_device` does not exist.
6. **Payload 6 — ID Poisoning Attack (Invalid Path Variable)**:
   User `alice` attempts to create `/users/alice/devices/bad$id!@#` containing characters outside `^[a-zA-Z0-9_\-]+$`.
7. **Payload 7 — Denial-of-Wallet Oversized Ciphertext (`Value Poisoning`)**:
   User `alice` writes `/users/alice/devices/dev_1/records/rec_1` with a 600,000-char `data` string exceeding `maxLength: 500000`.
8. **Payload 8 — Unbounded / Invalid Array Element Injection**:
   User `alice` writes `/users/alice/devices/dev_1` with `"enabled": ["call", "sms", "clip", "contacts"]` or `"enabled": ["contacts"]`.
9. **Payload 9 — Action-Gap Immutable Field Mutation on Record Update**:
   User `alice` updates `/users/alice/devices/dev_1/records/rec_1` attempting to change `"type": "sms"` (from `"call"`) or `"ts"` alongside `"data"`.
10. **Payload 10 — Client Timestamp Forgery**:
    User `alice` creates `/users/alice/devices/dev_1` using a past client `Timestamp` (`2020-01-01T00:00:00Z`) instead of `serverTimestamp()` (`request.time`).
11. **Payload 11 — Cross-User PII / Vault Scraping (`get` & `list`)**:
    Authenticated user `mallory` attempts to `get` `/users/alice/meta/crypto` or `list` `/users/alice/devices`.
12. **Payload 12 — Unfiltered Query Scraping on `list`**:
    Authenticated user `alice` executes an unfiltered collection group or broad query without `where('ownerId', '==', 'alice')` where `resource.data.ownerId` does not match.
