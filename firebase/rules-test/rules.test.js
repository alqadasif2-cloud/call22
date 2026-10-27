// اختبار حقيقي لقواعد الأمان على محاكي Firestore:
//   cd firebase && npx firebase-tools emulators:exec --only firestore --project demo-backup "npm --prefix rules-test test"
const { before, after, beforeEach, test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
} = require('firebase/firestore');

let env;

const usernameIdOf = (u) =>
  crypto.createHash('sha256').update('uname:' + u.trim().toLowerCase()).digest('hex').slice(0, 40);

const devPayload = (ownerId = 'sami_uid', over = {}) => ({
  ownerId,
  name: 'هاتفي الشخصي',
  model: 'Android 14',
  enabled: ['call', 'sms', 'clip'],
  lastSyncAt: 0,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...over,
});

const recPayload = (ownerId = 'sami_uid', deviceId = 'd1', over = {}) => ({
  ownerId,
  deviceId,
  type: 'sms',
  ts: 1700000000000,
  iv: 'BBBBBBBBBBBBBBBB',
  data: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  v: 1,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...over,
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-backup',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

// Custom Auth tokens do NOT have email or email_verified claims — verify they work seamlessly
const sami = () => env.authenticatedContext('sami_uid').firestore();
const bob = () => env.authenticatedContext('bob_uid').firestore();
const anon = () => env.unauthenticatedContext().firestore();

async function seedSami() {
  const unameId = usernameIdOf('sami123');
  await assertSucceeds(
    setDoc(doc(sami(), `usernames/${unameId}`), {
      uid: 'sami_uid',
      usernameLower: 'sami123',
      createdAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    setDoc(doc(sami(), 'users/sami_uid'), {
      uid: 'sami_uid',
      username: 'sami123',
      usernameLower: 'sami123',
      usernameId: unameId,
      createdAt: serverTimestamp(),
    })
  );
  await assertSucceeds(setDoc(doc(sami(), 'users/sami_uid/devices/d1'), devPayload('sami_uid')));
  await assertSucceeds(
    setDoc(doc(sami(), 'users/sami_uid/devices/d1/records/r1'), recPayload('sami_uid', 'd1'))
  );
}

test('حساب sami123 يسجّل بياناته ويقرأها من نفس المعرّف UID في التطبيقين', async () => {
  await seedSami();
  await assertSucceeds(getDoc(doc(sami(), 'users/sami_uid')));
  await assertSucceeds(getDoc(doc(sami(), 'users/sami_uid/devices/d1/records/r1')));
  await assertSucceeds(
    getDocs(query(collection(sami(), 'users/sami_uid/devices'), where('ownerId', '==', 'sami_uid')))
  );
  await assertSucceeds(
    getDocs(
      query(
        collection(sami(), 'users/sami_uid/devices/d1/records'),
        where('ownerId', '==', 'sami_uid')
      )
    )
  );
});

test('منع تكرار أسماء المستخدمين ومنع استعراض سجل الأسماء من التطبيقات', async () => {
  await seedSami();
  const unameId = usernameIdOf('sami123');
  // مستخدم آخر لا يستطيع حجز نفس اسم المستخدم sami123 (حتى بحروف كبيرة SAMI123)
  await assertFails(
    setDoc(doc(bob(), `usernames/${usernameIdOf('SAMI123')}`), {
      uid: 'bob_uid',
      usernameLower: 'sami123',
      createdAt: serverTimestamp(),
    })
  );
  // منع قراءة أو سرد مجموعة usernames لمنع تخمين الحسابات
  await assertFails(getDoc(doc(sami(), `usernames/${unameId}`)));
  await assertFails(getDoc(doc(bob(), `usernames/${unameId}`)));
  await assertFails(getDocs(collection(bob(), 'usernames')));
});

test('منع التطبيقات تمامًا من قراءة أو تعديل سجلات كلمات المرور أو عدادات المحاولات', async () => {
  const unameId = usernameIdOf('sami123');
  await assertFails(getDoc(doc(sami(), `authCredentials/${unameId}`)));
  await assertFails(
    setDoc(doc(sami(), `authCredentials/${unameId}`), {
      uid: 'sami_uid',
      passwordHash: 'deadbeef',
    })
  );
  await assertFails(getDoc(doc(sami(), 'authRateLimits/ip_127_0_0_1')));
  await assertFails(deleteDoc(doc(sami(), 'authRateLimits/ip_127_0_0_1')));
});

test('غير المصادق عليه ممنوع من القراءة والكتابة', async () => {
  await seedSami();
  await assertFails(getDoc(doc(anon(), 'users/sami_uid/devices/d1/records/r1')));
  await assertFails(setDoc(doc(anon(), 'users/sami_uid/devices/d2'), devPayload('sami_uid')));
});

test('مستخدم آخر لا يقرأ ولا يكتب ولا يحذف بيانات حساب غيره', async () => {
  await seedSami();
  await assertFails(getDoc(doc(bob(), 'users/sami_uid')));
  await assertFails(getDoc(doc(bob(), 'users/sami_uid/devices/d1/records/r1')));
  await assertFails(
    getDocs(query(collection(bob(), 'users/sami_uid/devices'), where('ownerId', '==', 'sami_uid')))
  );
  await assertFails(
    setDoc(doc(bob(), 'users/sami_uid/devices/d1/records/r2'), recPayload('bob_uid', 'd1'))
  );
  await assertFails(deleteDoc(doc(bob(), 'users/sami_uid/devices/d1/records/r1')));
});

test('لا كتابة سجل لجهاز غير مسجّل', async () => {
  await assertFails(
    setDoc(doc(sami(), 'users/sami_uid/devices/ghost/records/r1'), recPayload('sami_uid', 'ghost'))
  );
});

test('رفض حقول زائدة أو نوع غير معروف أو ts غير رقمي', async () => {
  await seedSami();
  await assertFails(
    setDoc(
      doc(sami(), 'users/sami_uid/devices/d1/records/r2'),
      recPayload('sami_uid', 'd1', { extra: 'x' })
    )
  );
  await assertFails(
    setDoc(
      doc(sami(), 'users/sami_uid/devices/d1/records/r3'),
      recPayload('sami_uid', 'd1', { type: 'photo' })
    )
  );
  await assertFails(
    setDoc(
      doc(sami(), 'users/sami_uid/devices/d1/records/r4'),
      recPayload('sami_uid', 'd1', { ts: 'yesterday' })
    )
  );
});

test('مفتاح التشفير: إنشاء مرة ثم لا تعديل', async () => {
  const c = {
    uid: 'sami_uid',
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    iter: 310000,
    checkIv: 'BBBBBBBBBBBBBBBB',
    check: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    v: 1,
    createdAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(doc(sami(), 'users/sami_uid/meta/crypto'), c));
  await assertFails(
    updateDoc(doc(sami(), 'users/sami_uid/meta/crypto'), {
      salt: 'ZZZZZZZZZZZZZZZZZZZZZZ==',
    })
  );
  await assertFails(getDoc(doc(bob(), 'users/sami_uid/meta/crypto')));
});
