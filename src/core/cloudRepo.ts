import { deleteUser, EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  b64,
  CHECK_AAD,
  CHECK_PLAIN,
  decryptBox,
  deriveVaultKey,
  encryptBox,
  PBKDF2_ITERATIONS,
  randomBytes,
  unb64,
} from './crypto';
import { auth, db, handleFirestoreError } from './firebase';
import { DeviceInfo, EncRecord, NormalizedUsername, OperationType, RecordType } from './types';

/**
 * Volumetric & Pattern Constants synced verbatim with firebase-blueprint.json & firestore.rules
 */
export const BLUEPRINT_LIMITS = {
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  ID_MAX_LEN: 128,
  USERNAME_PATTERN: /^[a-zA-Z0-9_.\-\u0600-\u06FF]+$/,
  USERNAME_MIN_LEN: 3,
  USERNAME_MAX_LEN: 32,
  DEVICE_NAME_MAX_LEN: 100,
  DEVICE_MODEL_MAX_LEN: 100,
  CIPHERTEXT_MAX_LEN: 500_000,
  IV_MAX_LEN: 64,
  ALLOWED_TYPES: [RecordType.CALL, RecordType.SMS, RecordType.CLIP] as const,
};

function requireUid(): string {
  const uid = auth.currentUser?.uid;
  if (!uid || !BLUEPRINT_LIMITS.ID_PATTERN.test(uid) || uid.length > BLUEPRINT_LIMITS.ID_MAX_LEN) {
    throw new Error('يلزم تسجيل الدخول أولًا.');
  }
  return uid;
}

function assertValidId(id: string, label: string): void {
  if (!id || id.length > BLUEPRINT_LIMITS.ID_MAX_LEN || !BLUEPRINT_LIMITS.ID_PATTERN.test(id)) {
    throw new Error(`معرّف غير صالح (${label}).`);
  }
}

export interface LiveCloudCheckResult {
  latencyMs: number;
  hasCryptoDoc: boolean;
  iterations: number | null;
}

export const CloudRepo = {
  // ---------------- Account Profile & Username Claim (/users/{uid} & /usernames/{usernameId}) ----------------

  async getCurrentUsername(): Promise<string | null> {
    const uid = requireUid();
    const path = `users/${uid}`;
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      if (snap.exists() && typeof snap.data().username === 'string') {
        return snap.data().username as string;
      }
      return auth.currentUser?.displayName || null;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  },

  async ensureUserProfile(norm: NormalizedUsername, isNewRegistration: boolean): Promise<void> {
    const uid = requireUid();
    const userPath = `users/${uid}`;
    let existingUser;
    try {
      existingUser = await getDoc(doc(db, 'users', uid));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, userPath);
    }
    if (existingUser.exists()) return;

    const claimPath = `usernames/${norm.usernameId}`;
    if (isNewRegistration) {
      try {
        await setDoc(doc(db, 'usernames', norm.usernameId), {
          uid,
          usernameLower: norm.usernameLower,
          createdAt: serverTimestamp(),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Missing or insufficient permissions') || msg.includes('permission-denied')) {
          if (auth.currentUser) {
            try {
              await deleteUser(auth.currentUser);
            } catch {
              // Best-effort cleanup
            }
          }
          throw new Error('اسم المستخدم مستخدم بالفعل. اختر اسمًا آخر.');
        }
        handleFirestoreError(error, OperationType.CREATE, claimPath);
      }
    } else {
      try {
        await setDoc(doc(db, 'usernames', norm.usernameId), {
          uid,
          usernameLower: norm.usernameLower,
          createdAt: serverTimestamp(),
        });
      } catch {
        // Already claimed on registration
      }
    }

    try {
      await setDoc(doc(db, 'users', uid), {
        uid,
        username: norm.username,
        usernameLower: norm.usernameLower,
        usernameId: norm.usernameId,
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, userPath);
    }
  },

  // ---------------- Cryptographic Root (/users/{uid}/meta/crypto) ----------------

  async hasCrypto(): Promise<boolean> {
    const uid = requireUid();
    const path = `users/${uid}/meta/crypto`;
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'meta', 'crypto'));
      return snap.exists();
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  },

  /**
   * Queries Google Cloud Firestore server directly (bypassing any local cache) to verify live persistence.
   */
  async verifyLiveCloudRoundtrip(): Promise<LiveCloudCheckResult> {
    const uid = requireUid();
    const path = `users/${uid}/meta/crypto`;
    const start = performance.now();
    try {
      const snap = await getDocFromServer(doc(db, 'users', uid, 'meta', 'crypto'));
      const latencyMs = Math.max(1, Math.round(performance.now() - start));
      return {
        latencyMs,
        hasCryptoDoc: snap.exists(),
        iterations: snap.exists() ? Number(snap.data().iter ?? PBKDF2_ITERATIONS) : null,
      };
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  },

  async createCrypto(passphrase: string): Promise<CryptoKey> {
    const uid = requireUid();
    const salt = randomBytes(16);
    const key = await deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS);
    const box = await encryptBox(key, CHECK_PLAIN, CHECK_AAD);

    const path = `users/${uid}/meta/crypto`;
    const payload = {
      uid,
      salt: b64(salt),
      iter: PBKDF2_ITERATIONS,
      checkIv: b64(box.iv),
      check: b64(box.data),
      v: 1,
      createdAt: serverTimestamp(),
    };

    try {
      await setDoc(doc(db, 'users', uid, 'meta', 'crypto'), payload);
      return key;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  },

  async unlock(passphrase: string): Promise<CryptoKey | null> {
    const uid = requireUid();
    const path = `users/${uid}/meta/crypto`;
    let snap;
    try {
      snap = await getDoc(doc(db, 'users', uid, 'meta', 'crypto'));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }

    if (!snap.exists()) return null;
    const data = snap.data();
    const salt = unb64(String(data.salt ?? ''));
    const iter = Number(data.iter ?? PBKDF2_ITERATIONS);
    const checkIv = unb64(String(data.checkIv ?? ''));
    const checkData = unb64(String(data.check ?? ''));

    const candidateKey = await deriveVaultKey(passphrase, salt, iter);
    try {
      const plain = await decryptBox(candidateKey, checkIv, checkData, CHECK_AAD);
      const matches =
        plain.byteLength === CHECK_PLAIN.byteLength &&
        plain.every((byte, idx) => byte === CHECK_PLAIN[idx]);
      return matches ? candidateKey : null;
    } catch {
      return null;
    }
  },

  // ---------------- Devices (/users/{uid}/devices/{deviceId}) ----------------

  async registerOrUpdateDevice(
    deviceId: string,
    name: string,
    model: string,
    enabled: RecordType[]
  ): Promise<void> {
    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');

    const safeName = (name.trim() || 'جهاز بدون اسم').slice(0, BLUEPRINT_LIMITS.DEVICE_NAME_MAX_LEN);
    const safeModel = (model.trim() || 'Web Vault').slice(0, BLUEPRINT_LIMITS.DEVICE_MODEL_MAX_LEN);
    const safeEnabled = Array.from(new Set(enabled))
      .filter((t) => BLUEPRINT_LIMITS.ALLOWED_TYPES.includes(t))
      .slice(0, 3);

    const path = `users/${uid}/devices/${deviceId}`;
    const ref = doc(db, 'users', uid, 'devices', deviceId);

    let existingSnap;
    try {
      existingSnap = await getDoc(ref);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }

    if (!existingSnap.exists()) {
      try {
        await setDoc(ref, {
          ownerId: uid,
          name: safeName,
          model: safeModel,
          enabled: safeEnabled,
          lastSyncAt: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }
    } else {
      try {
        await updateDoc(ref, {
          name: safeName,
          model: safeModel,
          enabled: safeEnabled,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, path);
      }
    }
  },

  async markDeviceSynced(deviceId: string, syncedAtMs: number): Promise<void> {
    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');
    const path = `users/${uid}/devices/${deviceId}`;
    try {
      await updateDoc(doc(db, 'users', uid, 'devices', deviceId), {
        lastSyncAt: Math.max(0, Math.trunc(syncedAtMs)),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  },

  async listDevices(): Promise<DeviceInfo[]> {
    const uid = requireUid();
    const path = `users/${uid}/devices`;
    try {
      const q = query(collection(db, 'users', uid, 'devices'), where('ownerId', '==', uid));
      const snap = await getDocs(q);
      return snap.docs
        .map((d) => {
          const raw = d.data();
          const lastSync = Number(raw.lastSyncAt ?? 0);
          return {
            id: d.id,
            ownerId: String(raw.ownerId ?? uid),
            name: String(raw.name ?? d.id),
            model: String(raw.model ?? ''),
            enabled: Array.isArray(raw.enabled)
              ? (raw.enabled.filter((x) =>
                  [RecordType.CALL, RecordType.SMS, RecordType.CLIP].includes(x as RecordType)
                ) as RecordType[])
              : [],
            lastSyncAt: lastSync > 0 ? lastSync : null,
          };
        })
        .sort((a, b) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0));
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  },

  subscribeDevices(
    onData: (devices: DeviceInfo[]) => void,
    onError: (err: Error) => void
  ): Unsubscribe {
    const uid = requireUid();
    const path = `users/${uid}/devices`;
    const q = query(collection(db, 'users', uid, 'devices'), where('ownerId', '==', uid));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => {
            const raw = d.data();
            const lastSync = Number(raw.lastSyncAt ?? 0);
            return {
              id: d.id,
              ownerId: String(raw.ownerId ?? uid),
              name: String(raw.name ?? d.id),
              model: String(raw.model ?? ''),
              enabled: Array.isArray(raw.enabled)
                ? (raw.enabled.filter((x) =>
                    [RecordType.CALL, RecordType.SMS, RecordType.CLIP].includes(x as RecordType)
                  ) as RecordType[])
                : [],
              lastSyncAt: lastSync > 0 ? lastSync : null,
            };
          })
          .sort((a, b) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0));
        onData(list);
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, path);
        } catch (wrapped) {
          onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
        }
      }
    );
  },

  // ---------------- Records (/users/{uid}/devices/{deviceId}/records/{recId}) ----------------

  async listDeviceRecords(deviceId: string): Promise<EncRecord[]> {
    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');
    const path = `users/${uid}/devices/${deviceId}/records`;
    try {
      const q = query(
        collection(db, 'users', uid, 'devices', deviceId, 'records'),
        where('ownerId', '==', uid)
      );
      const snap = await getDocs(q);
      return snap.docs
        .map((d) => {
          const raw = d.data();
          return {
            id: d.id,
            deviceId,
            type: raw.type as RecordType,
            ts: Number(raw.ts ?? 0),
            iv: String(raw.iv ?? ''),
            data: String(raw.data ?? ''),
          };
        })
        .sort((a, b) => b.ts - a.ts);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  },

  subscribeDeviceRecords(
    deviceId: string,
    onData: (records: EncRecord[]) => void,
    onError: (err: Error) => void
  ): Unsubscribe {
    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');
    const path = `users/${uid}/devices/${deviceId}/records`;
    const q = query(
      collection(db, 'users', uid, 'devices', deviceId, 'records'),
      where('ownerId', '==', uid)
    );
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => {
            const raw = d.data();
            return {
              id: d.id,
              deviceId,
              type: raw.type as RecordType,
              ts: Number(raw.ts ?? 0),
              iv: String(raw.iv ?? ''),
              data: String(raw.data ?? ''),
            };
          })
          .sort((a, b) => b.ts - a.ts);
        onData(list);
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, path);
        } catch (wrapped) {
          onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
        }
      }
    );
  },

  /**
   * Uploads encrypted records in atomic batches (<= 200).
   * Preserves deterministic ID deduplication and respects immutable createdAt on re-uploads.
   */
  async uploadBatch(deviceId: string, records: EncRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (records.length > 400) {
      throw new Error('حجم الدفعة يتجاوز الحد الأقصى المسموح به (400 سجل).');
    }

    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');
    const basePath = `users/${uid}/devices/${deviceId}/records`;

    const existingIds = new Set<string>();
    try {
      const q = query(
        collection(db, 'users', uid, 'devices', deviceId, 'records'),
        where('ownerId', '==', uid)
      );
      const snap = await getDocs(q);
      snap.docs.forEach((d) => existingIds.add(d.id));
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, basePath);
    }

    const batch = writeBatch(db);
    for (const rec of records) {
      assertValidId(rec.id, 'recId');
      if (rec.data.length > BLUEPRINT_LIMITS.CIPHERTEXT_MAX_LEN) {
        throw new Error('حجم السجل المشفّر يتجاوز الحد الأقصى المسموح به.');
      }
      const ref = doc(db, 'users', uid, 'devices', deviceId, 'records', rec.id);
      if (existingIds.has(rec.id)) {
        batch.update(ref, {
          iv: rec.iv,
          data: rec.data,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(ref, {
          ownerId: uid,
          deviceId,
          type: rec.type,
          ts: Math.trunc(rec.ts),
          iv: rec.iv,
          data: rec.data,
          v: 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, basePath);
    }
  },

  async deleteRecord(deviceId: string, recId: string): Promise<void> {
    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');
    assertValidId(recId, 'recId');
    const path = `users/${uid}/devices/${deviceId}/records/${recId}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'devices', deviceId, 'records', recId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  },

  async deleteDeviceRecords(deviceId: string): Promise<number> {
    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');
    const path = `users/${uid}/devices/${deviceId}/records`;

    let allDocs;
    try {
      const q = query(
        collection(db, 'users', uid, 'devices', deviceId, 'records'),
        where('ownerId', '==', uid)
      );
      allDocs = (await getDocs(q)).docs;
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }

    for (let i = 0; i < allDocs.length; i += 350) {
      const slice = allDocs.slice(i, i + 350);
      const batch = writeBatch(db);
      slice.forEach((d) => batch.delete(d.ref));
      try {
        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, path);
      }
    }
    return allDocs.length;
  },

  async deleteDevice(deviceId: string): Promise<void> {
    const uid = requireUid();
    assertValidId(deviceId, 'deviceId');
    await CloudRepo.deleteDeviceRecords(deviceId);
    const path = `users/${uid}/devices/${deviceId}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'devices', deviceId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  },

  async deleteAccountAndVault(
    password: string,
    customDeleteFn?: (pw: string) => Promise<boolean>
  ): Promise<void> {
    const user = auth.currentUser;
    if (!user) throw new Error('يلزم تسجيل الدخول أولًا.');
    const trimmed = password.trim();
    if (!trimmed) throw new Error('يرجى إدخال كلمة المرور لتأكيد حذف الحساب.');
    const uid = user.uid;

    if (user.email && user.providerData.some((p) => p.providerId === 'password')) {
      const cred = EmailAuthProvider.credential(user.email, trimmed);
      await reauthenticateWithCredential(user, cred);
    } else if (await CloudRepo.hasCrypto()) {
      const verified = await CloudRepo.unlock(trimmed);
      if (!verified) {
        throw new Error('كلمة المرور غير صحيحة.');
      }
    }

    let claimedUsernameId: string | null = null;
    try {
      const profileSnap = await getDoc(doc(db, 'users', uid));
      if (profileSnap.exists() && typeof profileSnap.data().usernameId === 'string') {
        claimedUsernameId = profileSnap.data().usernameId as string;
      }
    } catch {
      // Proceed with deletion
    }

    const devices = await CloudRepo.listDevices();
    for (const dev of devices) {
      await CloudRepo.deleteDevice(dev.id);
    }

    const cryptoPath = `users/${uid}/meta/crypto`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'meta', 'crypto'));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, cryptoPath);
    }

    const deletedByCustomFn = customDeleteFn ? await customDeleteFn(trimmed) : false;
    if (!deletedByCustomFn) {
      if (claimedUsernameId) {
        try {
          await deleteDoc(doc(db, 'usernames', claimedUsernameId));
        } catch {
          // Best-effort release
        }
      }
      try {
        await deleteDoc(doc(db, 'users', uid));
      } catch {
        // Best-effort profile cleanup
      }
      await deleteUser(user);
    }
  },
};
