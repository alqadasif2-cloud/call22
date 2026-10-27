import React, { useState } from 'react';
import { signOut, User } from 'firebase/auth';
import { CheckCircle2, Lock, LogOut, RotateCcw, Server, Shield, Trash2 } from 'lucide-react';
import firebaseConfig from '../../firebase-applet-config.json';
import { CloudRepo, LiveCloudCheckResult } from '../core/cloudRepo';
import { KeyVault, PBKDF2_ITERATIONS } from '../core/crypto';
import { auth, friendlyErrorMessageAr } from '../core/firebase';
import { LocalDevicePrefs, LocalPrefsStore, LocalQueueDb } from '../core/localQueue';
import { ConfirmModal } from './Dialogs';

interface SecurityAndAccountViewProps {
  user: User;
  prefs: LocalDevicePrefs;
  onLockVault: () => void;
  onCloudChanged: () => void;
}

type ConfirmKind = 'cloud' | 'local' | 'device' | 'account' | null;

export const SecurityAndAccountView: React.FC<SecurityAndAccountViewProps> = ({
  user,
  prefs,
  onLockVault,
  onCloudChanged,
}) => {
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);
  const [busy, setBusy] = useState(false);
  const [checkingServer, setCheckingServer] = useState(false);
  const [serverCheck, setServerCheck] = useState<LiveCloudCheckResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleVerifyLiveServer = async () => {
    setCheckingServer(true);
    setError(null);
    try {
      const res = await CloudRepo.verifyLiveCloudRoundtrip();
      setServerCheck(res);
    } catch (err) {
      setError(friendlyErrorMessageAr(err));
    } finally {
      setCheckingServer(false);
    }
  };

  const handleResetSyncQueue = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const count = await LocalQueueDb.resetAllToPending(user.uid);
      setNotice(
        `أُعيدت ${count} سجلات محلية إلى قائمة الرفع. انتقل إلى «النسخ والاستيراد» واضغط «المزامنة الآن» لإعادة رفعها.`
      );
    } catch (err) {
      setError(friendlyErrorMessageAr(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLockNow = async () => {
    await KeyVault.clear(user.uid);
    onLockVault();
  };

  const handleSignOut = async () => {
    await KeyVault.clear(user.uid);
    await signOut(auth);
  };

  const handleExecuteConfirmedAction = async () => {
    if (!confirmKind) return;
    setBusy(true);
    setNotice(null);
    setError(null);

    try {
      switch (confirmKind) {
        case 'cloud': {
          await CloudRepo.deleteDeviceRecords(prefs.deviceId);
          onCloudChanged();
          setNotice(
            'حُذفت النسخة السحابية لهذا المتصفح فقط. السجلات المحلية باقية ولن تُرفع مجددًا إلا إذا اخترت «إعادة رفع كل السجلات المحلية».'
          );
          break;
        }
        case 'local': {
          await LocalQueueDb.deleteAllForUser(user.uid);
          setNotice('حُذفت السجلات المحلية من هذا المتصفح فقط، والنسخة السحابية باقية كما هي.');
          break;
        }
        case 'device': {
          await CloudRepo.deleteDevice(prefs.deviceId);
          await KeyVault.clear(user.uid);
          await signOut(auth);
          return;
        }
        case 'account': {
          await CloudRepo.deleteAccountAndVault();
          await LocalQueueDb.deleteAllForUser(user.uid);
          LocalPrefsStore.clear(user.uid);
          await KeyVault.clear(user.uid);
          return;
        }
      }
      setConfirmKind(null);
    } catch (err) {
      setError(friendlyErrorMessageAr(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">الأمان والتحكم في البيانات</h1>
          <p className="mt-1 text-sm text-slate-600">
            تحقق مباشر من الخادم السحابي الفعلي، قفل الجلسة، والتحكم الدقيق في البيانات المحلية
            والسحابية.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleVerifyLiveServer()}
          disabled={checkingServer}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <Server className="h-3.5 w-3.5 text-[#1F3A5F]" />
          <span>{checkingServer ? 'جاري التحقق من الخادم...' : 'فحص الاتصال الفعلي بـ Firestore'}</span>
        </button>
      </div>

      {serverCheck && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-950">
          <div className="flex items-center gap-2 font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              اتصال سحابي حي ومؤكّد بقاعدة بيانات Google Cloud Firestore (زمن استجابة الخادم المباشر:{' '}
              <span className="font-mono tabular-nums">{serverCheck.latencyMs}ms</span>)
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-emerald-900">
            <span>
              معرّف المشروع السحابي:{' '}
              <strong dir="ltr" className="font-mono">
                {firebaseConfig.projectId}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              حالة وثيقة التشفير الجذرية (<span className="font-mono">meta/crypto</span>):{' '}
              <strong>{serverCheck.hasCryptoDoc ? 'محفوظة وموثّقة على الخادم' : 'غير منشأة'}</strong>
            </span>
          </div>
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6">
          <div className="flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-[#1F3A5F]" />
            <h2 className="text-base font-bold text-slate-900">مواصفات الخزنة والحساب الفعلي</h2>
          </div>

          <div className="mt-4 divide-y divide-slate-100 text-sm">
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">البريد الإلكتروني الموثّق</span>
              <span dir="ltr" className="font-mono text-xs text-slate-900">
                {user.email || user.uid}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">مشروع Firebase الفعلي</span>
              <span dir="ltr" className="font-mono text-xs font-semibold text-slate-900">
                {firebaseConfig.projectId}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">معرّف هذا المتصفح</span>
              <span dir="ltr" className="font-mono text-xs text-slate-900">
                {prefs.deviceId}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">خوارزمية التشفير</span>
              <span className="font-mono text-xs font-semibold text-slate-900">
                AES-256-GCM + AAD (128-bit Tag)
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">اشتقاق المفتاح</span>
              <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                PBKDF2-SHA256 ({PBKDF2_ITERATIONS.toLocaleString('en-US')} iter)
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">منع التكرار والتحقق</span>
              <span className="font-mono text-xs font-semibold text-slate-900">
                SHA-256 Deterministic ID
              </span>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={() => void handleLockNow()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1F3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162a47] whitespace-nowrap shrink-0"
            >
              <Lock className="h-3.5 w-3.5" />
              <span>قفل الخزنة ومسح المفتاح من الذاكرة</span>
            </button>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>تسجيل الخروج</span>
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6">
          <h2 className="text-base font-bold text-slate-900">التحكم في البيانات والحذف</h2>
          <p className="mt-1 text-xs text-slate-600">
            كل إجراء يوضح بدقة ما إذا كان يطال السحابة أو المتصفح المحلي؛ الملفات التي نزّلتها إلى
            جهازك لا تُمس أبدًا.
          </p>

          <div className="mt-5 space-y-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResetSyncQueue()}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5 text-right text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <span>إعادة رفع كل السجلات المحلية (بدون تكرار بفضل المعرّف الحتمي)</span>
              <RotateCcw className="h-4 w-4 shrink-0 text-slate-500" />
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmKind('local')}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5 text-right text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <span>حذف السجلات المحلية من قاعدة هذا المتصفح فقط</span>
              <Trash2 className="h-4 w-4 shrink-0 text-slate-500" />
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmKind('cloud')}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5 text-right text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <span>حذف النسخة السحابية لهذا المتصفح فقط</span>
              <Trash2 className="h-4 w-4 shrink-0 text-slate-500" />
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmKind('device')}
              className="flex w-full items-center justify-between rounded-lg border border-red-200 bg-red-50/40 px-4 py-2.5 text-right text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <span>إزالة هذا الجهاز من الحساب وتسجيل الخروج</span>
              <Trash2 className="h-4 w-4 shrink-0 text-red-600" />
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmKind('account')}
              className="flex w-full items-center justify-between rounded-lg border border-red-200 bg-red-50/40 px-4 py-2.5 text-right text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <span>حذف الحساب وكل النسخ الاحتياطية في السحابة نهائيًا</span>
              <Trash2 className="h-4 w-4 shrink-0 text-red-600" />
            </button>
          </div>
        </div>
      </div>

      {confirmKind === 'cloud' && (
        <ConfirmModal
          title="حذف النسخة السحابية لهذا المتصفح"
          description="سيُحذف كل ما رُفع من هذا المتصفح من السحابة فقط. لن تُحذف السجلات المحلية في المتصفح، ولا أي ملفات نزّلتها سابقًا إلى ذاكرة جهازك."
          confirmLabel="حذف النسخة السحابية"
          danger
          busy={busy}
          onConfirm={() => void handleExecuteConfirmedAction()}
          onClose={() => setConfirmKind(null)}
        />
      )}

      {confirmKind === 'local' && (
        <ConfirmModal
          title="حذف السجلات المحلية"
          description="ستُحذف السجلات من قاعدة بيانات هذا المتصفح فقط. النسخة السحابية والملفات التي نزّلتها سابقًا لن تتأثر."
          confirmLabel="حذف السجلات المحلية"
          danger
          busy={busy}
          onConfirm={() => void handleExecuteConfirmedAction()}
          onClose={() => setConfirmKind(null)}
        />
      )}

      {confirmKind === 'device' && (
        <ConfirmModal
          title="إزالة الجهاز وتسجيل الخروج"
          description="ستُحذف بيانات هذا الجهاز من السحابة ويُسجَّل خروجك فورًا. السجلات المحلية على هذا المتصفح والملفات المنزَّلة تبقى دون مساس."
          confirmLabel="إزالة الجهاز"
          danger
          busy={busy}
          onConfirm={() => void handleExecuteConfirmedAction()}
          onClose={() => setConfirmKind(null)}
        />
      )}

      {confirmKind === 'account' && (
        <ConfirmModal
          title="حذف الحساب وكل بياناته نهائيًا"
          description="سيُطلب تأكيد هويتك عبر نافذة Google، ثم تُحذف جميع أجهزتك ونسخك الاحتياطية ومفتاح التحقق وحسابك نهائيًا من السحابة. الملفات التي نزّلتها سابقًا إلى ذاكرة جهازك لن تُحذف."
          confirmLabel="تأكيد الهوية وحذف الحساب"
          danger
          busy={busy}
          onConfirm={() => void handleExecuteConfirmedAction()}
          onClose={() => setConfirmKind(null)}
        />
      )}
    </div>
  );
};
