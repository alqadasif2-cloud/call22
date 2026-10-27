import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import fs from 'node:fs';

/**
 * Adversarial Security Rules Verification Suite ("Dirty Dozen" Payloads)
 * Verifies that all 12 attack vectors defined in security_spec.md return PERMISSION_DENIED.
 */
export async function runRulesSecuritySuite(): Promise<void> {
  const testEnv: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: 'demo-cal1-security-test',
    firestore: {
      rules: fs.readFileSync('firestore.rules', 'utf8'),
    },
  });

  try {
    const aliceCtx = testEnv.authenticatedContext('alice_uid', {
      email: 'alice@example.com',
      email_verified: true,
    });
    const unverifiedAliceCtx = testEnv.authenticatedContext('alice_uid', {
      email: 'alice@example.com',
      email_verified: false,
    });
    const malloryCtx = testEnv.authenticatedContext('mallory_uid', {
      email: 'mallory@example.com',
      email_verified: true,
    });

    const aliceDb = aliceCtx.firestore();
    const unverifiedDb = unverifiedAliceCtx.firestore();
    const malloryDb = malloryCtx.firestore();

    // Baseline valid setup for Alice
    await assertSucceeds(
      setDoc(doc(aliceDb, 'users/alice_uid/meta/crypto'), {
        uid: 'alice_uid',
        salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
        iter: 310000,
        checkIv: 'BBBBBBBBBBBBBBBB',
        check: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        v: 1,
        createdAt: serverTimestamp(),
      })
    );

    await assertSucceeds(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/dev_1'), {
        ownerId: 'alice_uid',
        name: 'Pixel 8',
        model: 'Android 14',
        enabled: ['call', 'sms', 'clip'],
        lastSyncAt: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 1. Cross-Tenant Identity Spoofing (ownerId mismatch)
    await assertFails(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/dev_spoof'), {
        ownerId: 'mallory_uid',
        name: 'Spoofed',
        model: 'Web',
        enabled: ['clip'],
        lastSyncAt: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 2. Unverified Email Spoof Write
    await assertFails(
      setDoc(doc(unverifiedDb, 'users/alice_uid/devices/dev_unverified'), {
        ownerId: 'alice_uid',
        name: 'Unverified Phone',
        model: 'Web',
        enabled: ['clip'],
        lastSyncAt: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 3. Shadow Field Injection on Create
    await assertFails(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/dev_shadow'), {
        ownerId: 'alice_uid',
        name: 'Shadow Device',
        model: 'Web',
        enabled: ['clip'],
        lastSyncAt: 0,
        isAdmin: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 4. Crypto Root Overwrite (meta/crypto update forbidden)
    await assertFails(
      updateDoc(doc(aliceDb, 'users/alice_uid/meta/crypto'), {
        salt: 'ZZZZZZZZZZZZZZZZZZZZZZ==',
      })
    );

    // 5. Orphaned Record Write (Missing Parent Device)
    await assertFails(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/non_existent_dev/records/rec_1'), {
        ownerId: 'alice_uid',
        deviceId: 'non_existent_dev',
        type: 'clip',
        ts: 1700000000000,
        iv: 'BBBBBBBBBBBBBBBB',
        data: 'CCCCCCCCCCCCCCCCCCCCCCCC',
        v: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 6. ID Poisoning Attack (Invalid characters in document ID)
    await assertFails(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/bad$id!'), {
        ownerId: 'alice_uid',
        name: 'Bad ID',
        model: 'Web',
        enabled: ['clip'],
        lastSyncAt: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 7. Denial-of-Wallet Oversized Ciphertext (> 500,000 chars)
    await assertFails(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/dev_1/records/rec_huge'), {
        ownerId: 'alice_uid',
        deviceId: 'dev_1',
        type: 'clip',
        ts: 1700000000000,
        iv: 'BBBBBBBBBBBBBBBB',
        data: 'A'.repeat(500005),
        v: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 8. Invalid Array Element Injection in enabled types
    await assertFails(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/dev_bad_array'), {
        ownerId: 'alice_uid',
        name: 'Bad Array',
        model: 'Web',
        enabled: ['call', 'contacts'],
        lastSyncAt: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // Valid record creation for update tests
    await assertSucceeds(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/dev_1/records/rec_valid_1'), {
        ownerId: 'alice_uid',
        deviceId: 'dev_1',
        type: 'call',
        ts: 1700000000000,
        iv: 'BBBBBBBBBBBBBBBB',
        data: 'CCCCCCCCCCCCCCCCCCCCCCCC',
        v: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 9. Action-Gap Immutable Field Mutation on Record Update (attempting to mutate type)
    await assertFails(
      updateDoc(doc(aliceDb, 'users/alice_uid/devices/dev_1/records/rec_valid_1'), {
        type: 'sms',
        updatedAt: serverTimestamp(),
      })
    );

    // 10. Client Timestamp Forgery
    await assertFails(
      setDoc(doc(aliceDb, 'users/alice_uid/devices/dev_forged_time'), {
        ownerId: 'alice_uid',
        name: 'Forged Time',
        model: 'Web',
        enabled: ['clip'],
        lastSyncAt: 0,
        createdAt: Timestamp.fromMillis(1577836800000),
        updatedAt: Timestamp.fromMillis(1577836800000),
      })
    );

    // 11. Cross-User Vault Scraping (Mallory reading Alice's crypto meta)
    await assertFails(getDoc(doc(malloryDb, 'users/alice_uid/meta/crypto')));

    // 12. Cross-User List Query Scraping (Mallory listing Alice's devices even with forged filter)
    await assertFails(
      getDocs(
        query(collection(malloryDb, 'users/alice_uid/devices'), where('ownerId', '==', 'alice_uid'))
      )
    );
  } finally {
    await testEnv.cleanup();
  }
}
