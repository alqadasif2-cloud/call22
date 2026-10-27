// اختبار حقيقي لقواعد الأمان على محاكي Firestore:
//   cd firebase && npx firebase-tools emulators:exec --only firestore --project demo-backup "npm --prefix rules-test test"
const { before, after, beforeEach, test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, deleteDoc, collection, getDocs } = require('firebase/firestore');

let env;
const rec = (over = {}) => ({ type: 'sms', ts: 1700000000000, iv: 'aXY=', data: 'ZGF0YQ==', v: 1, ...over });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-backup',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const anon = () => env.unauthenticatedContext().firestore();

async function seed() {
  await assertSucceeds(setDoc(doc(alice(), 'users/alice/devices/d1'), { name: 'هاتفي', model: 'X', enabled: ['sms'] }));
  await assertSucceeds(setDoc(doc(alice(), 'users/alice/devices/d1/records/r1'), rec()));
}

test('المالك يكتب ويقرأ جهازه وسجلاته', async () => {
  await seed();
  await assertSucceeds(getDoc(doc(alice(), 'users/alice/devices/d1/records/r1')));
  await assertSucceeds(getDocs(collection(alice(), 'users/alice/devices')));
});

test('غير المصادق عليه ممنوع من القراءة والكتابة', async () => {
  await seed();
  await assertFails(getDoc(doc(anon(), 'users/alice/devices/d1/records/r1')));
  await assertFails(setDoc(doc(anon(), 'users/alice/devices/d2'), { name: 'x' }));
});

test('مستخدم آخر لا يقرأ ولا يكتب ولا يحذف بيانات غيره', async () => {
  await seed();
  await assertFails(getDoc(doc(bob(), 'users/alice/devices/d1/records/r1')));
  await assertFails(getDocs(collection(bob(), 'users/alice/devices/d1/records')));
  await assertFails(setDoc(doc(bob(), 'users/alice/devices/d1/records/r2'), rec()));
  await assertFails(deleteDoc(doc(bob(), 'users/alice/devices/d1/records/r1')));
});

test('لا كتابة سجل لجهاز غير مسجّل', async () => {
  await assertFails(setDoc(doc(alice(), 'users/alice/devices/ghost/records/r1'), rec()));
});

test('رفض حقول زائدة أو نوع غير معروف أو ts غير رقمي', async () => {
  await seed();
  await assertFails(setDoc(doc(alice(), 'users/alice/devices/d1/records/r2'), rec({ extra: 'x' })));
  await assertFails(setDoc(doc(alice(), 'users/alice/devices/d1/records/r3'), rec({ type: 'photo' })));
  await assertFails(setDoc(doc(alice(), 'users/alice/devices/d1/records/r4'), rec({ ts: 'yesterday' })));
});

test('لا وصول لأي مسار خارج البنية المعتمدة', async () => {
  await assertFails(setDoc(doc(alice(), 'public/x'), { a: 1 }));
  await assertFails(getDoc(doc(alice(), 'public/x')));
  await assertFails(setDoc(doc(alice(), 'users/alice/other/x'), { a: 1 }));
});

test('مفتاح التشفير: إنشاء مرة ثم لا تعديل', async () => {
  const c = { salt: 's', iter: 310000, checkIv: 'a', check: 'b', v: 1 };
  await assertSucceeds(setDoc(doc(alice(), 'users/alice/meta/crypto'), c));
  await assertFails(setDoc(doc(alice(), 'users/alice/meta/crypto'), { ...c, salt: 'other' }));
  await assertFails(getDoc(doc(bob(), 'users/alice/meta/crypto')));
});
