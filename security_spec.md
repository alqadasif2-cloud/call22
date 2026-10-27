# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Zero-Trust Tenant Isolation (`uid` & `ownerId`)**:
   - Every user backup path is strictly scoped under `/users/{uid}/...` where `request.auth != null` and `request.auth.uid == uid`.
   - Zero rules rely on `request.auth.token.email`; authentication works seamlessly with both Firebase Custom Authentication tokens (`admin.auth().createCustomToken(uid)`) and Firebase Identity Platform Username/Password accounts across `backup-app`, `viewer-app`, and Web.
   - All mutable or listable documents (`Device`, `EncRecord`) embed `ownerId == request.auth.uid` (and `UserProfile`, `UsernameClaim`, `CryptoMeta` embed `uid == request.auth.uid`), enforced at creation and locked as immutable on update.
2. **Server-Only Password & Rate-Limit Vault (`/authCredentials` & `/authRateLimits`)**:
   - `/authCredentials/{usernameId}` (containing `scrypt` password hashes + 32-byte random salts) and `/authRateLimits/{limitId}` (brute-force protection state) enforce `allow read, write: if false;`. No client APK or browser can ever read, list, create, update, or delete password records or rate-limit counters; only Cloud Functions via Firebase Admin SDK may access them.
3. **Global Username Uniqueness & Anti-Enumeration (`/usernames/{usernameId}` & `/users/{uid}`)**:
   - `/usernames/{usernameId}` (`usernameId = sha256("uname:" + usernameLower).slice(0, 40)`) allows `create` only once when the document does not yet exist (`allow update: if false;`), atomically preventing duplicate usernames.
   - `/usernames/{usernameId}` forbids `get` and `list` (`allow get, list: if false;`) so clients cannot scrape or enumerate registered usernames; `delete` is allowed solely if `existing().uid == request.auth.uid` (during account deletion).
   - `/users/{uid}` stores the immutable account profile (`uid`, `username`, `usernameLower`, `usernameId`, `createdAt`) readable and deletable solely by `isOwner(uid)`.
4. **Immutable Cryptographic Root (`/users/{uid}/meta/crypto`)**:
   - Only `metaId == 'crypto'` may exist in `/users/{uid}/meta/{metaId}`.
   - `CryptoMeta` can only be created once (`allow update: if false;`) and deleted only by `isOwner(uid)` (during full account deletion). `list` is disallowed.
5. **Master Gate Relational Integrity (`/users/{uid}/devices/{deviceId}/records/{recId}`)**:
   - An encrypted record (`EncRecord`) cannot be created, read (`get`), updated, or deleted unless its parent `/users/{uid}/devices/{deviceId}` document exists AND `get(...).data.ownerId == request.auth.uid`.
   - `allow list` on `devices` and `records` explicitly checks `resource.data.ownerId == request.auth.uid` with zero `get()` or `exists()` calls inside `list` blocks.

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 — Client Read/Write of Password Records (`/authCredentials`)**:
   Authenticated user `sami_uid` attempts `get` or `set` on `/authCredentials/<usernameId>` to read or overwrite password hashes.
2. **Payload 2 — Client Tampering with Brute-Force Rate Limits (`/authRateLimits`)**:
   Authenticated or unauthenticated attacker attempts `delete` or `set` on `/authRateLimits/<limitId>` to reset lockout counters.
3. **Payload 3 — Duplicate Username Hijack (`/usernames/{usernameId}`)**:
   User `mallory_uid` attempts `setDoc` on `/usernames/<sami_username_id>` already claimed by `sami_uid`, or attempts `getDoc` to enumerate usernames.
4. **Payload 4 — Cross-Tenant Identity Spoofing (`ownerId` Mismatch)**:
   Authenticated user `sami_uid` writes `/users/sami_uid/devices/dev_1` with `"ownerId": "mallory_uid"`.
5. **Payload 5 — Shadow Field Injection on Create**:
   User `sami_uid` creates `/users/sami_uid/devices/dev_1` or `/users/sami_uid` with all required keys plus `"isAdmin": true`.
6. **Payload 6 — Crypto Root Overwrite (`meta/crypto` Update)**:
   User `sami_uid` attempts to `update` `/users/sami_uid/meta/crypto` to swap out the PBKDF2 `salt` after creation.
7. **Payload 7 — Orphaned Record Write (Missing Parent Device)**:
   User `sami_uid` writes `/users/sami_uid/devices/ghost_device/records/rec_1` when `/users/sami_uid/devices/ghost_device` does not exist.
8. **Payload 8 — ID Poisoning Attack (Invalid Path Variable)**:
   User `sami_uid` attempts to create `/users/sami_uid/devices/bad$id!@#` containing characters outside `^[a-zA-Z0-9_\-]+$`.
9. **Payload 9 — Denial-of-Wallet Oversized Ciphertext (`Value Poisoning`)**:
   User `sami_uid` writes `/users/sami_uid/devices/dev_1/records/rec_1` with a 600,000-char `data` string exceeding `maxLength: 500000`.
10. **Payload 10 — Unbounded / Invalid Array Element Injection**:
    User `sami_uid` writes `/users/sami_uid/devices/dev_1` with `"enabled": ["call", "sms", "clip", "contacts"]` or `"enabled": ["contacts"]`.
11. **Payload 11 — Action-Gap Immutable Field Mutation & Timestamp Forgery**:
    User `sami_uid` updates `/users/sami_uid/devices/dev_1/records/rec_1` attempting to mutate `"type"` or `"ts"`, or creates a device with a forged past client `Timestamp`.
12. **Payload 12 — Cross-Account Backup Scraping (`get` & `list`)**:
    Authenticated user `mallory_uid` attempts to `get` `/users/sami_uid`, `get` `/users/sami_uid/meta/crypto`, or `list` `/users/sami_uid/devices` and `/users/sami_uid/devices/dev_1/records`.
