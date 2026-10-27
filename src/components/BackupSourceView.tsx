import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardPaste,
  CloudUpload,
  FileUp,
  Pause,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { CloudRepo } from '../core/cloudRepo';
import { encryptRecord } from '../core/crypto';
import { TimeFmt } from '../core/csvAndTime';
import { friendlyErrorMessageAr } from '../core/firebase';
import { Importer, isValidPlainRecord, RecBuilder } from '../core/importer';
import { clipResultMessageAr, recordTypeLongAr } from '../core/labels';
import { LocalDevicePrefs, LocalPrefsStore, LocalQueueDb } from '../core/localQueue';
import { looksSensitive } from '../core/sensitive';
import { ClipResult, LocalQueuedRecord, PlainRecord, RecordType } from '../core/types';

interface BackupSourceViewProps {
  uid: string;
  vaultKey: CryptoKey;
  prefs: LocalDevicePrefs;
  onUpdatePrefs: (next: LocalDevicePrefs) => void;
  onCloudChanged: () => void;
}

export const BackupSourceView: React.FC<BackupSourceViewProps> = ({
  uid,
  vaultKey,
  prefs,
  onUpdatePrefs,
  onCloudChanged,
}) => {
  const [localRows, setLocalRows] = useState<LocalQueuedRecord[]>([]);
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(prefs.deviceName);

  const [clipInput, setClipInput] = useState('');

  const [manualKind, setManualKind] = useState<'call' | 'sms'>('call');
  const [callNumber, setCallNumber] = useState('');
  const [callName, setCallName] = useState('');
  const [callType, setCallType] = useState('incoming');
  const [callDuration, setCallDuration] = useState('60');

  const [smsAddress, setSmsAddress] = useState('');
  const [smsType, setSmsType] = useState('inbox');
  const [smsBody, setSmsBody] = useState('');

  const callsFileRef = useRef<HTMLInputElement | null>(null);
  const smsFileRef = useRef<HTMLInputElement | null>(null);

  const refreshLocalStats = useCallback(async () => {
    const rows = await LocalQueueDb.listAll(uid);
    setLocalRows(rows);
  }, [uid]);

  useEffect(() => {
    void refreshLocalStats();
  }, [refreshLocalStats]);

  useEffect(() => {
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  /**
   * Encrypts pending local records with AES-256-GCM and commits batches to Cloud Firestore.
   * Marks records as synced ONLY after Firestore batch.commit() confirms durability.
   */
  const runSyncNow = useCallback(
    async (overridePrefs?: LocalDevicePrefs) => {
      const activePrefs = overridePrefs ?? prefs;
      if (activePrefs.paused) {
        setStatusNotice('النسخ الاحتياطي متوقف مؤقتًا. اضغط «استئناف» للمتابعة.');
        return;
      }
      if (!navigator.onLine) {
        setErrorNotice('لا يوجد اتصال بالإنترنت حاليًا. ستبقى السجلات محفوظة محليًا بانتظار الرفع.');
        return;
      }

      setSyncing(true);
      setErrorNotice(null);
      try {
        await CloudRepo.registerOrUpdateDevice(
          activePrefs.deviceId,
          activePrefs.deviceName,
          activePrefs.model,
          activePrefs.enabled
        );

        let uploadedCount = 0;
        while (true) {
          const pending = await LocalQueueDb.pendingBatch(uid, 200);
          if (pending.length === 0) break;
          const encryptedBatch = await Promise.all(
            pending.map((row) => encryptRecord(vaultKey, LocalQueueDb.toPlainRecord(row)))
          );
          await CloudRepo.uploadBatch(activePrefs.deviceId, encryptedBatch);
          await LocalQueueDb.markSynced(
            uid,
            pending.map((r) => r.id)
          );
          uploadedCount += pending.length;
        }

        const now = Date.now();
        await CloudRepo.markDeviceSynced(activePrefs.deviceId, now);
        const updated: LocalDevicePrefs = { ...activePrefs, lastSyncAt: now };
        LocalPrefsStore.save(uid, updated);
        onUpdatePrefs(updated);
        await refreshLocalStats();
        onCloudChanged();
        setStatusNotice(
          uploadedCount > 0
            ? `تم تشفير ورفع ${uploadedCount} سجل فعلي إلى قاعدة Firestore السحابية وتأكيد حفظ الدفعة.`
            : 'تم تحديث حالة الجهاز في السحابة؛ جميع السجلات المحلية مرفوعة ومؤكّدة.'
        );
      } catch (err) {
        setErrorNotice(friendlyErrorMessageAr(err));
      } finally {
        setSyncing(false);
      }
    },
    [prefs, uid, vaultKey, onUpdatePrefs, refreshLocalStats, onCloudChanged]
  );

  useEffect(() => {
    if (online && !prefs.paused) {
      const pendingCount = localRows.filter((r) => r.syncState === 0).length;
      if (pendingCount > 0 && !syncing) {
        void runSyncNow();
      }
    }
  }, [online]);

  const handleSaveDeviceName = async () => {
    const trimmed = editingName.trim().slice(0, 100);
    if (!trimmed || trimmed === prefs.deviceName) return;
    const next = { ...prefs, deviceName: trimmed };
    LocalPrefsStore.save(uid, next);
    onUpdatePrefs(next);
    try {
      await CloudRepo.registerOrUpdateDevice(next.deviceId, next.deviceName, next.model, next.enabled);
      onCloudChanged();
      setStatusNotice('تم تحديث اسم الجهاز في السحابة.');
    } catch (err) {
      setErrorNotice(friendlyErrorMessageAr(err));
    }
  };

  const handleToggleType = async (type: RecordType) => {
    const nextEnabled = prefs.enabled.includes(type)
      ? prefs.enabled.filter((t) => t !== type)
      : [...prefs.enabled, type];
    const next = { ...prefs, enabled: nextEnabled };
    LocalPrefsStore.save(uid, next);
    onUpdatePrefs(next);
    try {
      await CloudRepo.registerOrUpdateDevice(next.deviceId, next.deviceName, next.model, next.enabled);
      onCloudChanged();
    } catch {
      // Synced on next run
    }
  };

  const handleTogglePause = () => {
    const next = { ...prefs, paused: !prefs.paused };
    LocalPrefsStore.save(uid, next);
    onUpdatePrefs(next);
    if (!next.paused) {
      void runSyncNow(next);
    }
  };

  const saveClipboardText = async (rawText: string) => {
    setErrorNotice(null);
    if (!prefs.enabled.includes(RecordType.CLIP)) {
      setStatusNotice(clipResultMessageAr(ClipResult.DISABLED));
      return;
    }
    const trimmed = rawText.trim();
    if (!trimmed) {
      setStatusNotice(clipResultMessageAr(ClipResult.EMPTY));
      return;
    }
    if (trimmed.length > 100_000) {
      setStatusNotice(clipResultMessageAr(ClipResult.TOO_LONG));
      return;
    }
    if (looksSensitive(trimmed)) {
      setErrorNotice(clipResultMessageAr(ClipResult.SENSITIVE));
      return;
    }

    const rec = await RecBuilder.clip(prefs.deviceId, trimmed, Date.now());
    const inserted = await LocalQueueDb.insertIgnore(uid, [rec]);
    const nextPrefs = { ...prefs, lastScanAt: Date.now() };
    LocalPrefsStore.save(uid, nextPrefs);
    onUpdatePrefs(nextPrefs);
    await refreshLocalStats();

    if (inserted === 0) {
      setStatusNotice(clipResultMessageAr(ClipResult.DUPLICATE));
      return;
    }

    setClipInput('');
    setStatusNotice(clipResultMessageAr(ClipResult.SAVED));
    if (!nextPrefs.paused && navigator.onLine) {
      await runSyncNow(nextPrefs);
    }
  };

  const handleReadSystemClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      await saveClipboardText(text);
    } catch {
      setErrorNotice(
        'لم يسمح المتصفح بقراءة الحافظة تلقائيًا؛ الصق النص في الحقل أدناه ثم اضغط «حفظ النص».'
      );
    }
  };

  const handleDeleteLocalClip = async (row: LocalQueuedRecord) => {
    setErrorNotice(null);
    try {
      if (row.syncState === 1) {
        await CloudRepo.deleteRecord(prefs.deviceId, row.id);
        onCloudChanged();
      }
      await LocalQueueDb.deleteOne(uid, row.id);
      await refreshLocalStats();
      setStatusNotice('حُذف نص الحافظة محليًا ومن السحابة.');
    } catch {
      setErrorNotice('تعذّر حذف النسخة السحابية للسجل، لذا أُبقي محليًا لضمان اتساق الحالة.');
    }
  };

  const handleFilesImport = async (fileList: FileList, category: 'calls' | 'sms') => {
    setErrorNotice(null);
    setStatusNotice(null);
    const files = Array.from(fileList);
    if (files.length === 0) return;

    try {
      const allValid: PlainRecord[] = [];
      let totalInvalid = 0;

      for (const file of files) {
        const text = await file.text();
        const parsed = await Importer.parseBackupFile(prefs.deviceId, file.name, text, category);
        const valid = parsed.records.filter((r) => isValidPlainRecord(r));
        allValid.push(...valid);
        totalInvalid += parsed.skipped + (parsed.records.length - valid.length);
      }

      const added = await LocalQueueDb.insertIgnore(uid, allValid);
      const duplicateCount = allValid.length - added;

      const nextPrefs = { ...prefs, lastScanAt: Date.now() };
      LocalPrefsStore.save(uid, nextPrefs);
      onUpdatePrefs(nextPrefs);
      await refreshLocalStats();

      setStatusNotice(
        `تم استيراد ${added} سجل جديد، وتخطّي ${totalInvalid} سجل غير صالح، و${duplicateCount} سجل مكرر.`
      );

      if (added > 0 && !nextPrefs.paused && navigator.onLine) {
        await runSyncNow(nextPrefs);
      }
    } catch (err) {
      setErrorNotice(
        `فشل الاستيراد: الملف غير مطابق للصيغة المتوقعة (${
          err instanceof Error ? err.message : 'خطأ في القراءة'
        }).`
      );
    }
  };

  const handleManualLogSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorNotice(null);
    const now = Date.now();
    if (manualKind === 'call') {
      if (!prefs.enabled.includes(RecordType.CALL)) {
        setErrorNotice('تفعيل «سجل المكالمات» مطلوب أولًا.');
        return;
      }
      const dur = Number.parseInt(callDuration, 10) || 0;
      const rec = await RecBuilder.call(
        prefs.deviceId,
        callNumber,
        now,
        callType,
        dur,
        callName || null
      );
      const added = await LocalQueueDb.insertIgnore(uid, [rec]);
      await refreshLocalStats();
      setCallNumber('');
      setCallName('');
      setStatusNotice(added > 0 ? 'أُضيف سجل المكالمة محليًا.' : 'سجل المكالمة موجود مسبقًا.');
      if (added > 0 && !prefs.paused && navigator.onLine) await runSyncNow();
    } else {
      if (!prefs.enabled.includes(RecordType.SMS)) {
        setErrorNotice('تفعيل «الرسائل النصية» مطلوب أولًا.');
        return;
      }
      if (!smsAddress.trim() || !smsBody.trim()) {
        setErrorNotice('أدخل رقم المرسل/المستلم ونص الرسالة.');
        return;
      }
      const rec = await RecBuilder.sms(prefs.deviceId, smsAddress, smsBody, now, smsType);
      const added = await LocalQueueDb.insertIgnore(uid, [rec]);
      await refreshLocalStats();
      setSmsAddress('');
      setSmsBody('');
      setStatusNotice(added > 0 ? 'أُضيفت الرسالة النصية محليًا.' : 'الرسالة موجودة مسبقًا.');
      if (added > 0 && !prefs.paused && navigator.onLine) await runSyncNow();
    }
  };

  const totalLocal = localRows.length;
  const pendingLocal = localRows.filter((r) => r.syncState === 0).length;
  const recentClips = localRows.filter((r) => r.type === RecordType.CLIP).slice(0, 15);

  const syncStatusLabel = prefs.paused
    ? 'متوقف مؤقتًا بأمر المستخدم'
    : syncing
    ? 'جاري التشفير والرفع إلى السحابة...'
    : pendingLocal > 0
    ? `بانتظار رفع ${pendingLocal} سجل`
    : 'نشط ومتصل بالسحابة';

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">النسخ الاحتياطي والاستيراد</h1>
          <p className="mt-1 text-sm text-slate-600">
            تُشفَّر جميع السجلات بـ AES-256-GCM داخل متصفحك قبل رفعها إلى قاعدة Firestore السحابية
            الخاصة بحسابك.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => void runSyncNow()}
            disabled={prefs.paused || syncing}
            className="inline-flex items-center gap-2 rounded-lg bg-[#1F3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162a47] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <CloudUpload className="h-3.5 w-3.5" />
            <span>{syncing ? 'جاري المزامنة...' : 'المزامنة الآن'}</span>
          </button>

          <button
            type="button"
            onClick={handleTogglePause}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            {prefs.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            <span>{prefs.paused ? 'استئناف النسخ' : 'إيقاف مؤقت'}</span>
          </button>
        </div>
      </div>

      {statusNotice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {statusNotice}
        </div>
      )}

      {errorNotice && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorNotice}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
          <h2 className="text-base font-bold text-slate-900">الحالة الفعلية للجهاز</h2>
          <div className="mt-4 divide-y divide-slate-100 text-sm">
            <div className="flex items-center justify-between gap-4 py-2.5">
              <span className="text-slate-600">اسم الجهاز</span>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  maxLength={100}
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  className="w-44 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-900 focus:border-[#1F3A5F] focus:outline-none sm:w-56"
                />
                {editingName.trim() !== prefs.deviceName && (
                  <button
                    type="button"
                    onClick={() => void handleSaveDeviceName()}
                    className="rounded-md bg-[#1F3A5F] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#162a47] whitespace-nowrap shrink-0"
                  >
                    حفظ
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">حالة النسخ</span>
              <span className="font-semibold text-slate-900">{syncStatusLabel}</span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">الاتصال بالإنترنت</span>
              <span className={online ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>
                {online ? 'متصل' : 'غير متصل (تُحفظ السجلات محليًا)'}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">السجلات المحفوظة محليًا</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                {totalLocal}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">بانتظار الرفع</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                {pendingLocal}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">آخر مزامنة ناجحة</span>
              <span className="font-mono text-xs text-slate-800 tabular-nums">
                {TimeFmt.human(prefs.lastSyncAt)}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-slate-600">آخر فحص / استيراد للبيانات</span>
              <span className="font-mono text-xs text-slate-800 tabular-nums">
                {TimeFmt.human(prefs.lastScanAt)}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-5">
          <h2 className="text-base font-bold text-slate-900">أنواع البيانات المفعّلة</h2>
          <p className="mt-1 text-xs text-slate-500">
            يمكنك تفعيل أو إيقاف أي نوع في أي وقت دون المساس بما رُفع سابقًا.
          </p>
          <div className="mt-4 divide-y divide-slate-100">
            {[RecordType.CALL, RecordType.SMS, RecordType.CLIP].map((t) => {
              const checked = prefs.enabled.includes(t);
              return (
                <label
                  key={t}
                  className="flex cursor-pointer items-center justify-between gap-4 py-3.5 text-sm"
                >
                  <span className="font-medium text-slate-800">{recordTypeLongAr(t)}</span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => void handleToggleType(t)}
                    className="h-4 w-4 accent-[#1F3A5F]"
                  />
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* Manual Clipboard Section */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">الحافظة اليدوية المحمية</h2>
            <p className="mt-1 text-xs text-slate-600">
              لا يراقب التطبيق الحافظة في الخلفية. احفظ ما نسخته بإجراء صريح، مع حجب تلقائي لكلمات
              المرور وأكواد التحقق وأرقام البطاقات.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleReadSystemClipboard()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap shrink-0"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>حفظ محتوى الحافظة الحالي</span>
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
          <textarea
            rows={2}
            value={clipInput}
            onChange={(e) => setClipInput(e.target.value)}
            placeholder="أو الصق نصًا أو ملاحظة هنا لحفظها مشفّرة في السحابة..."
            className="w-full rounded-lg border border-slate-200 px-3.5 py-2 text-sm text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void saveClipboardText(clipInput)}
            disabled={!clipInput.trim()}
            className="rounded-lg bg-[#1F3A5F] px-5 py-2 text-xs font-semibold text-white hover:bg-[#162a47] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            حفظ النص
          </button>
        </div>

        {recentClips.length > 0 && (
          <div className="mt-5 divide-y divide-slate-100 border-t border-slate-200 pt-3">
            {recentClips.map((c) => {
              let preview = '';
              try {
                preview = String((JSON.parse(c.json) as { text?: string }).text ?? '');
              } catch {
                preview = '';
              }
              return (
                <div key={c.id} className="flex items-start justify-between gap-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-slate-800">{preview}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono tabular-nums">{TimeFmt.human(c.ts)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{c.syncState === 1 ? 'مرفوع ومؤكّد في السحابة' : 'بانتظار الرفع'}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDeleteLocalClip(c)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600 whitespace-nowrap shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>حذف</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Real File Import + Direct Record Logger */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6">
          <h2 className="text-base font-bold text-slate-900">استيراد ملفات الهاتف الفعلية</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            يدعم الاستيراد المباشر لملفات النسخ الاحتياطي المصدَّرة من تطبيقات الهاتف مثل{' '}
            <strong>SMS Backup &amp; Restore</strong> مع منع تلقائي للتكرار عبر بصمة SHA-256:
          </p>
          <div className="mt-3 space-y-1.5 text-xs text-slate-600">
            <div>
              <strong className="text-slate-900">سجل المكالمات:</strong> ملفات{' '}
              <span className="font-mono">XML</span> (<span className="font-mono">calls-*.xml</span>) أو{' '}
              <span className="font-mono">CSV</span> (<span className="font-mono">number,type,date,duration,name</span>) أو{' '}
              <span className="font-mono">JSON</span>.
            </div>
            <div>
              <strong className="text-slate-900">الرسائل النصية:</strong> ملفات{' '}
              <span className="font-mono">XML</span> (<span className="font-mono">sms-*.xml</span>) أو{' '}
              <span className="font-mono">CSV</span> (<span className="font-mono">address,body,date,type</span>) أو{' '}
              <span className="font-mono">JSON</span>.
            </div>
          </div>

          <input
            ref={callsFileRef}
            type="file"
            multiple
            accept=".xml,.csv,.json,text/xml,application/xml,text/csv,application/json"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleFilesImport(e.target.files, 'calls');
              }
              e.target.value = '';
            }}
          />
          <input
            ref={smsFileRef}
            type="file"
            multiple
            accept=".xml,.csv,.json,text/xml,application/xml,text/csv,application/json"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleFilesImport(e.target.files, 'sms');
              }
              e.target.value = '';
            }}
          />

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => callsFileRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1F3A5F] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#162a47] whitespace-nowrap shrink-0"
            >
              <FileUp className="h-3.5 w-3.5" />
              <span>استيراد مكالمات (XML / CSV / JSON)</span>
            </button>
            <button
              type="button"
              onClick={() => smsFileRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <FileUp className="h-3.5 w-3.5" />
              <span>استيراد رسائل (XML / CSV / JSON)</span>
            </button>
          </div>
        </div>

        <form
          onSubmit={handleManualLogSubmit}
          className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6"
        >
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-bold text-slate-900">تدوين مكالمة أو رسالة مباشرة</h2>
            <div className="inline-flex rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setManualKind('call')}
                className={`rounded-md px-3 py-1 text-xs font-semibold whitespace-nowrap shrink-0 ${
                  manualKind === 'call'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                مكالمة
              </button>
              <button
                type="button"
                onClick={() => setManualKind('sms')}
                className={`rounded-md px-3 py-1 text-xs font-semibold whitespace-nowrap shrink-0 ${
                  manualKind === 'sms'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                رسالة نصية
              </button>
            </div>
          </div>

          {manualKind === 'call' ? (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700">رقم الهاتف</label>
                <input
                  type="text"
                  dir="ltr"
                  value={callNumber}
                  onChange={(e) => setCallNumber(e.target.value)}
                  placeholder="+9665..."
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  الاسم (اختياري)
                </label>
                <input
                  type="text"
                  value={callName}
                  onChange={(e) => setCallName(e.target.value)}
                  placeholder="اسم جهة الاتصال"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">نوع المكالمة</label>
                <select
                  value={callType}
                  onChange={(e) => setCallType(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
                >
                  <option value="incoming">واردة</option>
                  <option value="outgoing">صادرة</option>
                  <option value="missed">فائتة</option>
                  <option value="rejected">مرفوضة</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">المدة (بالثواني)</label>
                <input
                  type="number"
                  min={0}
                  value={callDuration}
                  onChange={(e) => setCallDuration(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 tabular-nums focus:border-[#1F3A5F] focus:outline-none"
                />
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    رقم المرسل / المستلم
                  </label>
                  <input
                    type="text"
                    dir="ltr"
                    value={smsAddress}
                    onChange={(e) => setSmsAddress(e.target.value)}
                    placeholder="+9665..."
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
                />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">نوع الرسالة</label>
                  <select
                    value={smsType}
                    onChange={(e) => setSmsType(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
                  >
                    <option value="inbox">واردة</option>
                    <option value="sent">مرسلة</option>
                    <option value="draft">مسودة</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">نص الرسالة</label>
                <textarea
                  rows={2}
                  value={smsBody}
                  onChange={(e) => setSmsBody(e.target.value)}
                  placeholder="محتوى الرسالة النصية..."
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900 focus:border-[#1F3A5F] focus:outline-none"
                />
              </div>
            </div>
          )}

          <div className="mt-4">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>حفظ السجل ورفعه مشفّرًا</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
