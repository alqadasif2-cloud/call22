import React, { useEffect, useState } from 'react';
import { signInWithPopup, signOut, User } from 'firebase/auth';
import { KeyRound, Lock, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import { CloudRepo } from '../core/cloudRepo';
import { KeyVault } from '../core/crypto';
import {
  auth,
  friendlyErrorMessageAr,
  googleProvider,
  SessionBootstrapState,
} from '../core/firebase';
import { LocalDevicePrefs, LocalPrefsStore } from '../core/localQueue';
import { RecordType } from '../core/types';

interface SignInLandingProps {
  onSignedIn?: () => void;
  sessionNotice?: SessionBootstrapState | null;
}

export const SignInLanding: React.FC<SignInLandingProps> = ({ sessionNotice }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(friendlyErrorMessageAr(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-12 lg:py-20">
      <div className="grid grid-cols-1 items-stretch gap-10 lg:grid-cols-12">
        <div className="flex flex-col justify-center lg:col-span-7">
          <p className="text-xs font-semibold text-[#1F3A5F]">
            تشفير طرفي على الجهاز · AES-256-GCM · PBKDF2-SHA256
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl lg:text-[2.65rem] lg:leading-[1.2]">
            نسخة احتياطية شخصية مشفّرة لسجل المكالمات والرسائل النصية والحافظة
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600">
            يحتفظ هذا التطبيق بنسخة احتياطية مشفّرة من بياناتك الشخصية ويرفعها إلى مساحتك السحابية
            الخاصة، لتستعرضها أو تصدّرها متى شئت. يُشتق مفتاح التشفير على جهازك فقط من عبارة مرورك،
            ولا تغادر العبارة ولا المفتاح متصفحك أبدًا.
          </p>

          {sessionNotice?.sessionExpiredReset && (
            <div className="mt-6 max-w-xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-950">
              <div className="font-bold text-amber-900">انتهت صلاحية الجلسة السابقة (60 دقيقة)</div>
              <p className="mt-1">
                اضغط <strong>«المتابعة باستخدام حساب Google»</strong> أدناه لإصدار جلسة جديدة والاتصال
                بقاعدة البيانات فورًا.
              </p>
              {sessionNotice.tokenServiceDisabled && sessionNotice.activationUrl && (
                <p className="mt-1.5">
                  لتفعيل التجديد التلقائي للجلسات في الخلفية دون الحاجة لإعادة الدخول كل ساعة، يمكنك
                  تفعيل خدمة{' '}
                  <a
                    href={sessionNotice.activationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold underline hover:text-amber-800"
                  >
                    Token Service API في مشروع Google Cloud
                  </a>{' '}
                  بضغطة واحدة.
                </p>
              )}
            </div>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={busy}
              className="inline-flex items-center gap-2.5 rounded-lg bg-[#1F3A5F] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#162a47] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <LogIn className="h-4 w-4" />
              <span>{busy ? 'جاري تسجيل الدخول...' : 'المتابعة باستخدام حساب Google'}</span>
            </button>
          </div>

          {error && (
            <div className="mt-4 max-w-lg rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-10 grid grid-cols-1 gap-6 border-t border-slate-200 pt-8 sm:grid-cols-3">
            <div>
              <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                310,000
              </div>
              <div className="mt-1 text-xs leading-relaxed text-slate-600">
                تكرار اشتقاق مفتاح PBKDF2-HMAC-SHA256 قبل تشفير أي سجل.
              </div>
            </div>
            <div>
              <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                SHA-256
              </div>
              <div className="mt-1 text-xs leading-relaxed text-slate-600">
                معرّف حتمي يمنع تكرار السجلات محليًا وفي السحابة، مع فحص سلامة الأرشيف عند التنزيل.
              </div>
            </div>
            <div>
              <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                CSV · XML · ZIP
              </div>
              <div className="mt-1 text-xs leading-relaxed text-slate-600">
                استيراد مباشر لملفات المكالمات وSMS Backup &amp; Restore وتصدير موثّق مع manifest.json.
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-7 lg:col-span-5">
          <div>
            <div className="flex items-center gap-2.5 text-slate-900">
              <ShieldCheck className="h-5 w-5 text-[#1F3A5F]" />
              <h2 className="text-lg font-bold">ضمانات الخصوصية والشفافية</h2>
            </div>
            <div className="mt-5 divide-y divide-slate-100 text-sm text-slate-600">
              <div className="py-3.5">
                <div className="font-semibold text-slate-900">01. تشفير كامل للمحتوى قبل الرفع</div>
                <p className="mt-1 text-xs leading-relaxed">
                  أرقام الهواتف، أسماء جهات الاتصال، نصوص الرسائل، ومقتطفات الحافظة تُشفَّر بـ
                  AES-256-GCM مع ربط إضافي (AAD) بالمعرّف والنوع والزمن.
                </p>
              </div>
              <div className="py-3.5">
                <div className="font-semibold text-slate-900">02. حجب تلقائي للبيانات الحساسة</div>
                <p className="mt-1 text-xs leading-relaxed">
                  لا توجد مراقبة خلفية للحافظة؛ الحفظ يدوي فقط، ويمنع المرشّح حفظ كلمات المرور وأكواد
                  التحقق وأرقام البطاقات البنكية (خوارزمية Luhn).
                </p>
              </div>
              <div className="py-3.5">
                <div className="font-semibold text-slate-900">03. تحكم صريح في كل طبقة</div>
                <p className="mt-1 text-xs leading-relaxed">
                  إيقاف مؤقت، حذف سجل منفرد، مسح النسخة السحابية لجهاز، أو حذف الحساب بالكامل مع توضيح
                  دقيق لنطاق كل عملية.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500">
            متوافق بنيويًا وتشفيريًا مع حزمة تطبيقات أندرويد (نسخي الاحتياطي وعارض النسخ الاحتياطي).
          </div>
        </div>
      </div>
    </div>
  );
};

interface VaultPassphraseGateProps {
  user: User;
  prefs: LocalDevicePrefs;
  onUpdatePrefs: (next: LocalDevicePrefs) => void;
  onUnlocked: (key: CryptoKey) => void;
}

export const VaultPassphraseGate: React.FC<VaultPassphraseGateProps> = ({
  user,
  prefs,
  onUpdatePrefs,
  onUnlocked,
}) => {
  const [checkingCloud, setCheckingCloud] = useState(true);
  const [isCreateMode, setIsCreateMode] = useState<boolean | null>(null);
  const [pass, setPass] = useState('');
  const [passConfirm, setPassConfirm] = useState('');
  const [rememberOnBrowser, setRememberOnBrowser] = useState(true);
  const [deviceName, setDeviceName] = useState(prefs.deviceName);
  const [enabledTypes, setEnabledTypes] = useState<RecordType[]>(prefs.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCounter, setRetryCounter] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCheckingCloud(true);
      setError(null);
      try {
        const exists = await CloudRepo.hasCrypto();
        if (cancelled) return;
        if (exists) {
          const cachedKey = await KeyVault.load(user.uid);
          if (cachedKey && !cancelled) {
            onUnlocked(cachedKey);
            return;
          }
        }
        setIsCreateMode(!exists);
      } catch (err) {
        if (!cancelled) {
          setError(friendlyErrorMessageAr(err));
          setIsCreateMode(null);
        }
      } finally {
        if (!cancelled) setCheckingCloud(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user.uid, retryCounter]);

  const toggleType = (t: RecordType) => {
    setEnabledTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCreateMode === null) return;
    setBusy(true);
    setError(null);

    try {
      let key: CryptoKey | null;
      if (isCreateMode) {
        key = await CloudRepo.createCrypto(pass);
      } else {
        key = await CloudRepo.unlock(pass);
      }

      if (!key) {
        setError('عبارة المرور غير صحيحة. تأكد من إدخال العبارة ذاتها التي أنشأتها عند أول إعداد.');
        return;
      }

      if (rememberOnBrowser) {
        await KeyVault.save(user.uid, key);
      }

      if (!prefs.onboardingDone || isCreateMode) {
        const updatedPrefs: LocalDevicePrefs = {
          ...prefs,
          deviceName: deviceName.trim() || prefs.deviceName,
          enabled: enabledTypes,
          onboardingDone: true,
        };
        LocalPrefsStore.save(user.uid, updatedPrefs);
        onUpdatePrefs(updatedPrefs);
        await CloudRepo.registerOrUpdateDevice(
          updatedPrefs.deviceId,
          updatedPrefs.deviceName,
          updatedPrefs.model,
          updatedPrefs.enabled
        );
      }

      onUnlocked(key);
    } catch (err) {
      setError(friendlyErrorMessageAr(err));
    } finally {
      setBusy(false);
    }
  };

  if (checkingCloud) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20">
        <div className="rounded-xl border border-slate-200 bg-white p-8">
          <div className="h-5 w-48 rounded bg-slate-200" />
          <div className="mt-3 h-4 w-full rounded bg-slate-100" />
          <div className="mt-2 h-4 w-3/4 rounded bg-slate-100" />
          <div className="mt-6 h-10 w-full rounded-lg bg-slate-100" />
        </div>
      </div>
    );
  }

  if (isCreateMode === null) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20">
        <div className="rounded-xl border border-slate-200 bg-white p-7">
          <h2 className="text-lg font-bold text-slate-900">تعذّر التحقق من حالة الخزنة السحابية</h2>
          <p className="mt-2 text-sm text-red-700">{error}</p>
          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setRetryCounter((c) => c + 1)}
              className="rounded-lg bg-[#1F3A5F] px-4 py-2 text-sm font-semibold text-white hover:bg-[#162a47] whitespace-nowrap shrink-0"
            >
              إعادة المحاولة
            </button>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              تسجيل الخروج
            </button>
          </div>
        </div>
      </div>
    );
  }

  const canSubmit = isCreateMode
    ? pass.length >= 10 && pass === passConfirm && !busy
    : pass.length > 0 && !busy;

  return (
    <div className="mx-auto max-w-xl px-6 py-12 lg:py-16">
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-slate-200 bg-white p-7 sm:p-8"
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2.5">
            {isCreateMode ? (
              <KeyRound className="h-5 w-5 text-[#1F3A5F]" />
            ) : (
              <Lock className="h-5 w-5 text-[#1F3A5F]" />
            )}
            <h1 className="text-xl font-bold text-slate-900">
              {isCreateMode ? 'إنشاء عبارة مرور التشفير' : 'إدخال عبارة مرور التشفير'}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => signOut(auth)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 whitespace-nowrap shrink-0"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>تبديل الحساب</span>
          </button>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          {isCreateMode
            ? 'تُشفَّر بياناتك على الجهاز قبل رفعها، ولا يستطيع أحد (ولا الخادم) قراءتها دون هذه العبارة. أدخل العبارة نفسها على كل جهاز معتمد لاستعادة المفتاح. إذا فقدتها فلا يمكن فك تشفير نسخك نهائيًا. (10 أحرف على الأقل)'
            : 'أدخل عبارة المرور التي أنشأتها عند أول إعداد لفك تشفير سجلاتك السحابية وتشفير أي سجلات جديدة على هذا المتصفح.'}
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700" htmlFor="vault-pass">
              عبارة مرور التشفير {isCreateMode ? '(10 أحرف على الأقل)' : ''}
            </label>
            <input
              id="vault-pass"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="أدخل عبارة مرور قوية..."
              autoComplete={isCreateMode ? 'new-password' : 'current-password'}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
            />
          </div>

          {isCreateMode && (
            <div>
              <label
                className="block text-xs font-semibold text-slate-700"
                htmlFor="vault-pass-confirm"
              >
                تأكيد عبارة المرور
              </label>
              <input
                id="vault-pass-confirm"
                type="password"
                value={passConfirm}
                onChange={(e) => setPassConfirm(e.target.value)}
                placeholder="أعد كتابة عبارة المرور للتأكيد..."
                autoComplete="new-password"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
              />
              {passConfirm.length > 0 && pass !== passConfirm && (
                <p className="mt-1 text-xs text-red-600">العبارتان غير متطابقتين.</p>
              )}
            </div>
          )}

          {(isCreateMode || !prefs.onboardingDone) && (
            <div className="border-t border-slate-200 pt-4">
              <div className="text-sm font-semibold text-slate-900">إعداد خزنة هذا المتصفح</div>
              <div className="mt-3">
                <label className="block text-xs font-semibold text-slate-700" htmlFor="dev-name">
                  اسم الجهاز في حسابك
                </label>
                <input
                  id="dev-name"
                  type="text"
                  maxLength={100}
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
                />
              </div>

              <div className="mt-3 space-y-2">
                <div className="text-xs font-semibold text-slate-700">
                  أنواع البيانات المفعّلة للنسخ من هذا المتصفح
                </div>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={enabledTypes.includes(RecordType.CALL)}
                    onChange={() => toggleType(RecordType.CALL)}
                    className="h-4 w-4 accent-[#1F3A5F]"
                  />
                  <span>سجل المكالمات (استيراد CSV أو إضافة يدوية)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={enabledTypes.includes(RecordType.SMS)}
                    onChange={() => toggleType(RecordType.SMS)}
                    className="h-4 w-4 accent-[#1F3A5F]"
                  />
                  <span>الرسائل النصية (استيراد XML / CSV أو إضافة يدوية)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={enabledTypes.includes(RecordType.CLIP)}
                    onChange={() => toggleType(RecordType.CLIP)}
                    className="h-4 w-4 accent-[#1F3A5F]"
                  />
                  <span>نصوص الحافظة (حفظ يدوي صريح مع حجب كلمات المرور والأكواد)</span>
                </label>
              </div>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2.5 pt-1 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={rememberOnBrowser}
              onChange={(e) => setRememberOnBrowser(e.target.checked)}
              className="h-4 w-4 accent-[#1F3A5F]"
            />
            <span>حفظ المفتاح المشتق محليًا في مخزن المتصفح المعزول (يُمسح فور القفل أو الخروج)</span>
          </label>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6">
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-lg bg-[#1F3A5F] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#162a47] disabled:opacity-50"
          >
            {busy
              ? 'جاري اشتقاق المفتاح والتحقق (310,000 تكرار)...'
              : isCreateMode
              ? 'إنشاء الخزنة والمتابعة'
              : 'فتح الخزنة المشفّرة'}
          </button>
        </div>
      </form>
    </div>
  );
};
