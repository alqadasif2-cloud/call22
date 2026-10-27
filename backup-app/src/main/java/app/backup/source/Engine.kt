package app.backup.source

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.backup.core.CloudRepo
import app.backup.core.Net
import app.backup.core.PlainRecord
import app.backup.core.RecordCodec
import app.backup.core.RecordType
import app.backup.core.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

object Perms {
    fun forType(t: RecordType): String? = when (t) {
        RecordType.CALL -> Manifest.permission.READ_CALL_LOG
        RecordType.SMS -> Manifest.permission.READ_SMS
        RecordType.CLIP -> null
    }

    fun granted(ctx: Context, p: String) =
        ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    fun typeAllowed(ctx: Context, t: RecordType): Boolean = forType(t)?.let { granted(ctx, it) } ?: true
}

sealed interface SyncResult {
    data object Done : SyncResult
    data object Offline : SyncResult
    data object NeedsLogin : SyncResult
    data class Failed(val reason: String) : SyncResult
}

object Engine {
    /** المراحل 3-4: حفظ محلي ثم إضافة إلى قائمة الانتظار (syncState=0). يعيد عدد السجلات الجديدة فعلًا. */
    suspend fun store(dao: RecordDao, batch: List<PlainRecord>): Int {
        val rows = batch.filter { Validator.ok(it) }.map {
            RecordEntity(it.id, it.type.id, it.ts, it.fields.toString(), 0, System.currentTimeMillis())
        }
        if (rows.isEmpty()) return 0
        return dao.insertAll(rows).count { it != -1L }
    }

    /** المرحلة 1: قراءة البيانات المسموح بها فقط. لا تُفترض بيانات لم تُقرأ فعليًا. */
    suspend fun scan(ctx: Context, dao: RecordDao): Int {
        val deviceId = Prefs.deviceId
        val en = Prefs.enabled.value
        var added = 0
        val notes = mutableListOf<String>()

        if (RecordType.CALL.id in en) {
            if (!Perms.typeAllowed(ctx, RecordType.CALL)) notes += "صلاحية سجل المكالمات غير ممنوحة"
            else try {
                var max = Prefs.cursor("call")
                CallLogCollector.collect(ctx, deviceId, max) { b ->
                    added += store(dao, b); max = maxOf(max, b.maxOf { it.ts })
                }
                Prefs.setCursor("call", max)
            } catch (e: SecurityException) { notes += "منع النظام الوصول إلى سجل المكالمات" }
        }
        if (RecordType.SMS.id in en) {
            if (!Perms.typeAllowed(ctx, RecordType.SMS)) notes += "صلاحية الرسائل غير ممنوحة"
            else try {
                var max = Prefs.cursor("sms")
                SmsCollector.collect(ctx, deviceId, max) { b ->
                    added += store(dao, b); max = maxOf(max, b.maxOf { it.ts })
                }
                Prefs.setCursor("sms", max)
            } catch (e: SecurityException) { notes += "منع النظام الوصول إلى الرسائل" }
        }
        Prefs.notice.value = notes.joinToString("، ").ifEmpty { null }
        Prefs.setLastScan(System.currentTimeMillis())
        return added
    }

    /** المراحل 5-6: رفع على دفعات، ولا يُعلَّم أي سجل «مرفوعًا» إلا بعد تأكيد الخادم للدفعة. */
    suspend fun upload(ctx: Context, dao: RecordDao): SyncResult {
        val (activeUid, key) = Session.ensureLoaded(ctx) ?: return SyncResult.NeedsLogin
        if (!Net.isOnline(ctx)) return SyncResult.Offline
        val repo = CloudRepo(explicitUid = activeUid)
        val deviceId = Prefs.deviceId
        return try {
            repo.registerDevice(deviceId, Prefs.deviceName.value, Build.MODEL, Prefs.enabled.value.toList())
            while (true) {
                val batch = dao.pending(200)
                if (batch.isEmpty()) break
                val enc = batch.map { RecordCodec.encrypt(key, it.toPlain(deviceId)) }
                val ok = withTimeoutOrNull(60_000) { repo.upload(deviceId, enc) }
                if (ok == null) return SyncResult.Failed("انتهت مهلة الرفع")
                dao.markSynced(batch.map { it.id })
            }
            val now = System.currentTimeMillis()
            repo.markSynced(deviceId, now)
            Prefs.setLastSync(now)
            SyncResult.Done
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // لا نسجّل أي محتوى؛ اسم نوع الخطأ فقط
            SyncResult.Failed(e.javaClass.simpleName)
        }
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        if (Prefs.paused.value) return Result.success()
        val dao = AppDb.get(applicationContext).dao()
        Engine.scan(applicationContext, dao)
        return when (Engine.upload(applicationContext, dao)) {
            SyncResult.Done, SyncResult.NeedsLogin -> Result.success()
            SyncResult.Offline -> { Scheduler.enqueueResume(applicationContext); Result.success() }
            is SyncResult.Failed -> Result.retry()
        }
    }
}

object Scheduler {
    private val needsNet = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** 15 دقيقة هو الحد الأدنى لنظام أندرويد للمهام الدورية؛ قد يؤخّرها وضع توفير الطاقة. */
    fun start(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            "periodic", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build(),
        )
    }

    fun syncNow(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniqueWork("now", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<SyncWorker>().build())
    }

    /** استئناف الرفع تلقائيًا عند عودة الاتصال. */
    fun enqueueResume(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniqueWork(
            "resume", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(needsNet)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build(),
        )
    }

    fun stop(ctx: Context) { WorkManager.getInstance(ctx).cancelAllWork() }
}
