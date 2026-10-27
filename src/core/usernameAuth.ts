import {
  createUserWithEmailAndPassword,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  User,
} from 'firebase/auth';
import { BLUEPRINT_LIMITS, CloudRepo } from './cloudRepo';
import { KeyVault } from './crypto';
import { auth } from './firebase';
import { LocalDevicePrefs, LocalPrefsStore } from './localQueue';
import { NormalizedUsername } from './types';

const RATE_LIMIT_KEY = 'personal_backup_auth_rate_limit_v1';
const LAST_USERNAME_KEY = 'personal_backup_last_username_v1';
const RATE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface ClientRateState {
  attempts: number;
  windowStartMs: number;
  blockedUntilMs: number;
}

export interface AuthSessionResult {
  user: User;
  vaultKey: CryptoKey;
  prefs: LocalDevicePrefs;
  username: string;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function readRateState(): ClientRateState | null {
  try {
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ClientRateState;
  } catch {
    return null;
  }
}

function checkClientRateLimit(nowMs = Date.now()): void {
  const state = readRateState();
  if (state && state.blockedUntilMs > nowMs) {
    const mins = Math.max(1, Math.ceil((state.blockedUntilMs - nowMs) / 60_000));
    throw new Error(
      `تم إيقاف المحاولات مؤقتًا لكثرة المحاولات الخاطئة. يرجى الانتظار ${mins} دقيقة ثم المحاولة مجددًا.`
    );
  }
}

function recordClientFailure(nowMs = Date.now()): void {
  try {
    const prev = readRateState();
    const expired = !prev || nowMs - prev.windowStartMs > RATE_WINDOW_MS;
    const attempts = (expired ? 0 : prev.attempts) + 1;
    const windowStartMs = expired ? nowMs : prev.windowStartMs;
    const blockedUntilMs = attempts >= MAX_ATTEMPTS ? nowMs + LOCKOUT_MS : 0;
    localStorage.setItem(
      RATE_LIMIT_KEY,
      JSON.stringify({ attempts, windowStartMs, blockedUntilMs })
    );
  } catch {
    // Ignore storage quota errors
  }
}

function clearClientFailures(): void {
  try {
    localStorage.removeItem(RATE_LIMIT_KEY);
  } catch {
    // Ignore
  }
}

function getCustomAuthEndpoint(): string {
  const envUrl = import.meta.env.VITE_CUSTOM_AUTH_URL;
  return typeof envUrl === 'string' ? envUrl.trim() : '';
}

async function invokeCustomAuthEndpoint(
  endpoint: string,
  payload: Record<string, string>,
  idToken?: string
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || json.ok !== true) {
    const errMsg =
      typeof json.error === 'string' && json.error
        ? json.error
        : `تعذّرت المصادقة مع الخادم (${resp.status}).`;
    throw new Error(errMsg);
  }
  return json;
}

let activeAuthInProgress = false;

export const UsernameAuth = {
  get inProgress(): boolean {
    return activeAuthInProgress;
  },

  getSavedUsername(): string {
    try {
      return localStorage.getItem(LAST_USERNAME_KEY) || '';
    } catch {
      return '';
    }
  },

  saveUsername(username: string): void {
    try {
      localStorage.setItem(LAST_USERNAME_KEY, username);
    } catch {
      // Ignore
    }
  },

  async normalizeUsername(raw: string): Promise<NormalizedUsername> {
    const trimmed = raw.trim();
    if (
      trimmed.length < BLUEPRINT_LIMITS.USERNAME_MIN_LEN ||
      trimmed.length > BLUEPRINT_LIMITS.USERNAME_MAX_LEN
    ) {
      throw new Error('يجب أن يتكون اسم المستخدم من 3 إلى 32 حرفًا أو رقمًا دون مسافات.');
    }
    if (!BLUEPRINT_LIMITS.USERNAME_PATTERN.test(trimmed)) {
      throw new Error('اسم المستخدم يقبل الحروف والأرقام والنقطة والشرطة فقط دون مسافات.');
    }
    const usernameLower = trimmed.toLowerCase();
    const hex = await sha256Hex(`uname:${usernameLower}`);
    const usernameId = hex.slice(0, 40);
    return {
      username: trimmed,
      usernameLower,
      usernameId,
      syntheticEmail: `u_${usernameId}@users.personalbackup.app`,
    };
  },

  validatePassword(raw: string): string {
    if (raw.length < 8) {
      throw new Error('يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.');
    }
    if (raw.length > 128) {
      throw new Error('كلمة المرور تتجاوز الحد الأقصى المسموح به (128 حرفًا).');
    }
    return raw;
  },

  async register(rawUsername: string, rawPassword: string): Promise<AuthSessionResult> {
    const norm = await UsernameAuth.normalizeUsername(rawUsername);
    const validPw = UsernameAuth.validatePassword(rawPassword);
    checkClientRateLimit();

    activeAuthInProgress = true;
    try {
      const endpoint = getCustomAuthEndpoint();
      let signedInUser: User;

      if (endpoint) {
        const res = await invokeCustomAuthEndpoint(endpoint, {
          action: 'register',
          username: norm.username,
          password: validPw,
        });
        const cred = await signInWithCustomToken(auth, String(res.customToken));
        signedInUser = cred.user;
      } else {
        const cred = await createUserWithEmailAndPassword(auth, norm.syntheticEmail, validPw);
        signedInUser = cred.user;
        try {
          await updateProfile(signedInUser, { displayName: norm.username });
        } catch {
          // Non-fatal
        }
      }

      await CloudRepo.ensureUserProfile(norm, !endpoint);

      const hasVault = await CloudRepo.hasCrypto();
      const key = hasVault
        ? await CloudRepo.unlock(validPw)
        : await CloudRepo.createCrypto(validPw);

      if (!key) {
        throw new Error('تعذّر إعداد مفتاح التشفير للحساب.');
      }

      await KeyVault.save(signedInUser.uid, key);

      const loadedPrefs = LocalPrefsStore.load(signedInUser.uid);
      const nextPrefs: LocalDevicePrefs = {
        ...loadedPrefs,
        onboardingDone: true,
      };
      LocalPrefsStore.save(signedInUser.uid, nextPrefs);
      await CloudRepo.registerOrUpdateDevice(
        nextPrefs.deviceId,
        nextPrefs.deviceName,
        nextPrefs.model,
        nextPrefs.enabled
      );

      UsernameAuth.saveUsername(norm.username);
      clearClientFailures();

      return {
        user: signedInUser,
        vaultKey: key,
        prefs: nextPrefs,
        username: norm.username,
      };
    } catch (err) {
      recordClientFailure();
      throw err;
    } finally {
      activeAuthInProgress = false;
    }
  },

  async login(rawUsername: string, rawPassword: string): Promise<AuthSessionResult> {
    const norm = await UsernameAuth.normalizeUsername(rawUsername);
    const validPw = UsernameAuth.validatePassword(rawPassword);
    checkClientRateLimit();

    activeAuthInProgress = true;
    try {
      const endpoint = getCustomAuthEndpoint();
      let signedInUser: User;

      if (endpoint) {
        const res = await invokeCustomAuthEndpoint(endpoint, {
          action: 'login',
          username: norm.username,
          password: validPw,
        });
        const cred = await signInWithCustomToken(auth, String(res.customToken));
        signedInUser = cred.user;
      } else {
        const cred = await signInWithEmailAndPassword(auth, norm.syntheticEmail, validPw);
        signedInUser = cred.user;
      }

      await CloudRepo.ensureUserProfile(norm, false);

      const hasVault = await CloudRepo.hasCrypto();
      const key = hasVault
        ? await CloudRepo.unlock(validPw)
        : await CloudRepo.createCrypto(validPw);

      if (!key) {
        await firebaseSignOut(auth);
        recordClientFailure();
        throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
      }

      await KeyVault.save(signedInUser.uid, key);

      const loadedPrefs = LocalPrefsStore.load(signedInUser.uid);
      const nextPrefs: LocalDevicePrefs = {
        ...loadedPrefs,
        onboardingDone: true,
      };
      if (!loadedPrefs.onboardingDone) {
        LocalPrefsStore.save(signedInUser.uid, nextPrefs);
        await CloudRepo.registerOrUpdateDevice(
          nextPrefs.deviceId,
          nextPrefs.deviceName,
          nextPrefs.model,
          nextPrefs.enabled
        );
      }

      const resolvedUsername = (await CloudRepo.getCurrentUsername()) || norm.username;
      UsernameAuth.saveUsername(resolvedUsername);
      clearClientFailures();

      return {
        user: signedInUser,
        vaultKey: key,
        prefs: nextPrefs,
        username: resolvedUsername,
      };
    } catch (err) {
      recordClientFailure();
      throw err;
    } finally {
      activeAuthInProgress = false;
    }
  },

  async deleteCustomAuthAccountIfConfigured(password: string): Promise<boolean> {
    const endpoint = getCustomAuthEndpoint();
    if (!endpoint) return false;
    const current = auth.currentUser;
    if (!current) throw new Error('يلزم تسجيل الدخول أولًا.');
    const idToken = await current.getIdToken(false);
    await invokeCustomAuthEndpoint(endpoint, { action: 'deleteAccount', password }, idToken);
    await firebaseSignOut(auth);
    return true;
  },

  async signOut(): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (uid) {
      await KeyVault.clear(uid);
    }
    await firebaseSignOut(auth);
  },
};
