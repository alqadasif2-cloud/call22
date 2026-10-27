import { initializeApp } from 'firebase/app';
import { getAuth, signOut } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { getPrebootSessionState, SessionBootstrapState } from './prebootAuthGuard';
import { FirestoreErrorInfo, OperationType } from './types';

export type { SessionBootstrapState };

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export function isTokenServiceDisabledError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('token-service-api-has-not-been-used') ||
    msg.includes('securetoken.googleapis.com')
  );
}

export function isAuthProviderNotEnabledError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('auth/operation-not-allowed') ||
    msg.includes('admin_only_operation') ||
    msg.includes('operation_not_allowed')
  );
}

/**
 * Validates initial connectivity to Firestore server as required by Firebase integration guidelines.
 */
async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

let bootstrapPromise: Promise<SessionBootstrapState> | null = null;

export function bootstrapFirebaseSession(): Promise<SessionBootstrapState> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async (): Promise<SessionBootstrapState> => {
      const initial = getPrebootSessionState();
      let sessionExpiredReset = initial.sessionExpiredReset;
      let tokenServiceDisabled = initial.tokenServiceDisabled;
      let activationUrl = initial.activationUrl;

      try {
        await auth.authStateReady();
        if (auth.currentUser) {
          try {
            await auth.currentUser.getIdToken(false);
          } catch (tokenErr) {
            sessionExpiredReset = true;
            if (isTokenServiceDisabledError(tokenErr)) {
              tokenServiceDisabled = true;
              const projNum = firebaseConfig.messagingSenderId || firebaseConfig.projectId;
              activationUrl = `https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=${projNum}`;
            }
            await signOut(auth);
          }
        }
      } catch {
        // Proceed to connectivity test
      }

      await testConnection();

      return {
        sessionExpiredReset,
        tokenServiceDisabled,
        activationUrl,
      };
    })();
  }
  return bootstrapPromise;
}

/**
 * Standardized Firestore permission/operation error handler producing structured JSON diagnostics.
 */
export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Maps Firebase Auth & Firestore errors to clear Arabic user-facing messages without leaking sensitive payloads.
 */
export function friendlyErrorMessageAr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (isAuthProviderNotEnabledError(err)) {
    return 'طريقة المصادقة بكلمة المرور غير مفعّلة بعد في مشروع Firebase. فعّل خيار Email/Password من لوحة تحكم Firebase (Authentication ← Sign-in method) ثم أعد المحاولة.';
  }

  if (isTokenServiceDisabledError(err)) {
    return 'انتهت صلاحية الجلسة السابقة. يرجى تسجيل الدخول باسم المستخدم وكلمة المرور للمتابعة.';
  }

  if (raw.includes('Quota exceeded')) {
    return 'تم تجاوز حصة القراءة/الكتابة اليومية المجانية في Firestore. ستُعاد الحصة تلقائيًا في اليوم التالي.';
  }

  if (raw.startsWith('{') && raw.includes('"operationType"')) {
    try {
      const parsed = JSON.parse(raw) as FirestoreErrorInfo;
      if (isTokenServiceDisabledError(parsed.error)) {
        return 'انتهت صلاحية الجلسة السحابية؛ يرجى تسجيل الدخول مجددًا.';
      }
      if (parsed.error.includes('Quota exceeded')) {
        return 'تم تجاوز حصة الاستخدام اليومية المجانية لقاعدة البيانات السحابية.';
      }
      if (parsed.error.includes('Missing or insufficient permissions')) {
        return 'رفضت قواعد الأمان السحابية هذه العملية. تأكد من صلاحية الجلسة وأن البيانات تتبع لحسابك.';
      }
      if (parsed.error.includes('offline') || parsed.error.includes('unavailable')) {
        return 'تعذّر الوصول إلى الخادم السحابي حاليًا. تحقق من اتصال الإنترنت وأعد المحاولة.';
      }
    } catch {
      // Fall through
    }
  }

  if (raw.includes('auth/email-already-in-use') || raw.includes('username-already-in-use')) {
    return 'اسم المستخدم مستخدم بالفعل. اختر اسمًا آخر.';
  }
  if (
    raw.includes('auth/invalid-credential') ||
    raw.includes('auth/wrong-password') ||
    raw.includes('auth/user-not-found') ||
    raw.includes('auth/invalid-login-credentials') ||
    raw.includes('invalid-credentials')
  ) {
    return 'اسم المستخدم أو كلمة المرور غير صحيحة.';
  }
  if (raw.includes('auth/weak-password')) {
    return 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.';
  }
  if (raw.includes('auth/too-many-requests') || raw.includes('too-many-requests')) {
    return 'تم إيقاف المحاولات مؤقتًا لكثرة المحاولات الخاطئة. يرجى الانتظار قليلًا ثم المحاولة مجددًا.';
  }
  if (raw.includes('auth/network-request-failed')) {
    return 'لا يوجد اتصال بالإنترنت. تحقق من الشبكة وأعد المحاولة.';
  }
  if (raw.includes('auth/requires-recent-login')) {
    return 'يلزم تأكيد تسجيل دخول حديث لإتمام حذف الحساب.';
  }

  return raw.length <= 180 && /[\u0600-\u06FF]/.test(raw)
    ? raw
    : 'تعذّر إتمام العملية السحابية. تحقق من الاتصال وأعد المحاولة.';
}
