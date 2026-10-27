package app.backup.source

import android.content.Context
import android.provider.CallLog
import android.provider.Telephony
import app.backup.core.PlainRecord
import app.backup.core.RecordIds
import app.backup.core.RecordType
import app.backup.core.Sensitive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

object CallTypes {
    fun fromInt(i: Int) = when (i) {
        CallLog.Calls.INCOMING_TYPE -> "incoming"
        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
        CallLog.Calls.MISSED_TYPE -> "missed"
        CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
        CallLog.Calls.REJECTED_TYPE -> "rejected"
        CallLog.Calls.BLOCKED_TYPE -> "blocked"
        else -> "other"
    }
}

object SmsTypes {
    fun fromInt(i: Int) = when (i) {
        1 -> "inbox"; 2 -> "sent"; 3 -> "draft"; 4 -> "outbox"; 5 -> "failed"; 6 -> "queued"; else -> "other"
    }
}

object Rec {
    fun call(deviceId: String, number: String, ts: Long, type: String, durationSec: Long, name: String?): PlainRecord {
        val f = JSONObject().put("number", number).put("type", type).put("durationSec", durationSec)
        if (!name.isNullOrBlank()) f.put("name", name)
        return PlainRecord(RecordIds.make(deviceId, RecordType.CALL, number, ts, type, durationSec), deviceId, RecordType.CALL, ts, f)
    }

    fun sms(deviceId: String, address: String, body: String, ts: Long, type: String): PlainRecord {
        val f = JSONObject().put("address", address).put("body", body).put("type", type)
        return PlainRecord(RecordIds.make(deviceId, RecordType.SMS, address, ts, type, body), deviceId, RecordType.SMS, ts, f)
    }

    fun clip(deviceId: String, text: String, ts: Long): PlainRecord {
        // المعرّف من النص فقط: نفس النص لا يُحفظ مرتين
        return PlainRecord(RecordIds.make(deviceId, RecordType.CLIP, text), deviceId, RecordType.CLIP, ts, JSONObject().put("text", text))
    }
}

/** المرحلة 2 من خط المعالجة: التحقق من صحة البيانات. */
object Validator {
    fun ok(r: PlainRecord): Boolean {
        if (r.ts <= 0L) return false
        return when (r.type) {
            RecordType.CALL -> true // الرقم قد يكون فارغًا للمتصل المخفي
            RecordType.SMS -> r.fields.optString("address").isNotBlank()
            RecordType.CLIP -> r.fields.optString("text").isNotBlank()
        }
    }
}

object CallLogCollector {
    /** يقرأ السجلات من التاريخ [since] فصاعدًا عبر الواجهة الرسمية CallLog (يتطلب READ_CALL_LOG). */
    suspend fun collect(ctx: Context, deviceId: String, since: Long, sink: suspend (List<PlainRecord>) -> Unit) =
        withContext(Dispatchers.IO) {
            val proj = arrayOf(
                CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.CACHED_NAME,
            )
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI, proj, "${CallLog.Calls.DATE} >= ?", arrayOf(since.toString()),
                "${CallLog.Calls.DATE} ASC",
            )?.use { c ->
                val buf = ArrayList<PlainRecord>(500)
                while (c.moveToNext()) {
                    buf += Rec.call(
                        deviceId, c.getString(0) ?: "", c.getLong(2), CallTypes.fromInt(c.getInt(1)), c.getLong(3), c.getString(4),
                    )
                    if (buf.size >= 500) { sink(buf.toList()); buf.clear() }
                }
                if (buf.isNotEmpty()) sink(buf.toList())
            }
            Unit
        }
}

object SmsCollector {
    /** يقرأ الرسائل عبر Telephony.Sms (يتطلب READ_SMS). */
    suspend fun collect(ctx: Context, deviceId: String, since: Long, sink: suspend (List<PlainRecord>) -> Unit) =
        withContext(Dispatchers.IO) {
            val proj = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE)
            ctx.contentResolver.query(
                Telephony.Sms.CONTENT_URI, proj, "${Telephony.Sms.DATE} >= ?", arrayOf(since.toString()),
                "${Telephony.Sms.DATE} ASC",
            )?.use { c ->
                val buf = ArrayList<PlainRecord>(500)
                while (c.moveToNext()) {
                    buf += Rec.sms(deviceId, c.getString(0) ?: "", c.getString(1) ?: "", c.getLong(2), SmsTypes.fromInt(c.getInt(3)))
                    if (buf.size >= 500) { sink(buf.toList()); buf.clear() }
                }
                if (buf.isNotEmpty()) sink(buf.toList())
            }
            Unit
        }
}

enum class ClipResult { SAVED, DUPLICATE, SENSITIVE, EMPTY, TOO_LONG, DISABLED }

object ClipSaver {
    /** يُستدعى فقط بإجراء صريح من المستخدم (زر الحفظ أو المشاركة). لا توجد مراقبة للحافظة. */
    suspend fun save(ctx: Context, text: String?): ClipResult {
        if (RecordType.CLIP.id !in Prefs.enabled.value) return ClipResult.DISABLED
        val t = text?.trim().orEmpty()
        if (t.isEmpty()) return ClipResult.EMPTY
        if (t.length > 100_000) return ClipResult.TOO_LONG
        if (Sensitive.looksSensitive(t)) return ClipResult.SENSITIVE
        val rec = Rec.clip(Prefs.deviceId, t, System.currentTimeMillis())
        val inserted = Engine.store(AppDb.get(ctx).dao(), listOf(rec))
        if (inserted == 0) return ClipResult.DUPLICATE
        Scheduler.syncNow(ctx)
        return ClipResult.SAVED
    }
}
