package app.backup.core

import com.google.firebase.FirebaseNetworkException
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.auth.FirebaseAuthRecentLoginRequiredException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.FirebaseAuthWeakPasswordException
import com.google.firebase.firestore.AggregateSource
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.MemoryCacheSettings
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

object CloudInit {
    /** نستخدم Room كمخزن محلي وحيد، لذا نعطّل كاش Firestore الدائم كي لا تُعلَّق الكتابات بصمت دون تأكيد الخادم. */
    fun configure() {
        runCatching {
            FirebaseFirestore.getInstance().firestoreSettings = FirebaseFirestoreSettings.Builder()
                .setLocalCacheSettings(MemoryCacheSettings.newBuilder().build())
                .build()
        }
    }
}

object AuthMessages {
    fun of(e: Throwable): String = when (e) {
        is FirebaseAuthInvalidCredentialsException, is FirebaseAuthInvalidUserException -> "البريد أو كلمة المرور غير صحيحة"
        is FirebaseAuthUserCollisionException -> "هذا البريد مسجّل مسبقًا"
        is FirebaseAuthWeakPasswordException -> "كلمة المرور ضعيفة"
        is FirebaseAuthRecentLoginRequiredException -> "يلزم تسجيل دخول حديث. سجّل الخروج ثم الدخول وأعد المحاولة"
        is FirebaseNetworkException -> "لا يوجد اتصال بالإنترنت"
        else -> "تعذّر إتمام العملية (${e.javaClass.simpleName})"
    }
}

data class PageResult(val items: List<EncRecord>, val cursor: DocumentSnapshot?, val exhausted: Boolean)

class CloudRepo(
    private val db: FirebaseFirestore = FirebaseFirestore.getInstance(),
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
) {
    private val uid: String get() = auth.currentUser?.uid ?: throw IllegalStateException("not signed in")
    private fun user() = db.collection("users").document(uid)
    private fun cryptoDoc() = user().collection("meta").document("crypto")
    private fun devices() = user().collection("devices")
    private fun records(deviceId: String) = devices().document(deviceId).collection("records")

    // ---------- التشفير ----------
    suspend fun hasCrypto(): Boolean = cryptoDoc().get().await().exists()

    suspend fun createCrypto(pass: CharArray): ByteArray {
        val salt = Crypto.randomBytes(16)
        val key = withContext(Dispatchers.Default) { Crypto.deriveKey(pass, salt) }
        val box = Crypto.encrypt(key, CHECK_PLAIN, CHECK_AAD)
        cryptoDoc().set(
            mapOf(
                "salt" to Crypto.b64(salt), "iter" to Crypto.ITERATIONS,
                "checkIv" to Crypto.b64(box.iv), "check" to Crypto.b64(box.data), "v" to 1,
            )
        ).await()
        return key
    }

    /** يعيد المفتاح، أو null إذا كانت العبارة خاطئة. */
    suspend fun unlock(pass: CharArray): ByteArray? {
        val d = cryptoDoc().get().await()
        if (!d.exists()) return null
        val salt = Crypto.unb64(d.getString("salt")!!)
        val iter = (d.getLong("iter") ?: Crypto.ITERATIONS.toLong()).toInt()
        val key = withContext(Dispatchers.Default) { Crypto.deriveKey(pass, salt, iter) }
        return try {
            Crypto.decrypt(key, Crypto.unb64(d.getString("checkIv")!!), Crypto.unb64(d.getString("check")!!), CHECK_AAD)
            key
        } catch (e: Exception) {
            null
        }
    }

    // ---------- الأجهزة ----------
    suspend fun registerDevice(id: String, name: String, model: String, enabled: List<String>) {
        devices().document(id).set(
            mapOf("name" to name, "model" to model, "enabled" to enabled, "updatedAt" to FieldValue.serverTimestamp()),
            SetOptions.merge(),
        ).await()
    }

    suspend fun markSynced(deviceId: String, at: Long) {
        devices().document(deviceId).update("lastSyncAt", at).await()
    }

    suspend fun listDevices(): List<DeviceInfo> = devices().get().await().documents.map {
        DeviceInfo(
            id = it.id,
            name = it.getString("name") ?: it.id,
            model = it.getString("model") ?: "",
            enabled = (it.get("enabled") as? List<*>)?.map { x -> x.toString() } ?: emptyList(),
            lastSyncAt = it.getLong("lastSyncAt"),
        )
    }

    suspend fun count(deviceId: String, type: RecordType? = null, from: Long? = null, to: Long? = null): Long {
        var q: Query = records(deviceId)
        if (type != null) q = q.whereEqualTo("type", type.id)
        if (from != null) q = q.whereGreaterThanOrEqualTo("ts", from)
        if (to != null) q = q.whereLessThanOrEqualTo("ts", to)
        return q.count().get(AggregateSource.SERVER).await().count
    }

    // ---------- السجلات ----------
    /** يُستدعى بدفعات ≤ 400. المعرّف حتمي فالتكرار يستبدل نفس الوثيقة ولا ينشئ نسخة ثانية. */
    suspend fun upload(deviceId: String, recs: List<EncRecord>) {
        require(recs.size <= 400)
        val b = db.batch()
        recs.forEach {
            b.set(
                records(deviceId).document(it.id),
                mapOf("type" to it.type, "ts" to it.ts, "iv" to it.iv, "data" to it.data, "v" to 1),
            )
        }
        b.commit().await()
    }

    suspend fun page(
        deviceId: String, type: RecordType, from: Long?, to: Long?, after: DocumentSnapshot?, size: Long = 50,
    ): PageResult {
        var q: Query = records(deviceId).whereEqualTo("type", type.id)
        if (from != null) q = q.whereGreaterThanOrEqualTo("ts", from)
        if (to != null) q = q.whereLessThanOrEqualTo("ts", to)
        q = q.orderBy("ts", Query.Direction.DESCENDING)
        if (after != null) q = q.startAfter(after)
        val snap = q.limit(size).get().await()
        val items = snap.documents.map {
            EncRecord(it.id, it.getString("type")!!, it.getLong("ts")!!, it.getString("iv")!!, it.getString("data")!!)
        }
        return PageResult(items, snap.documents.lastOrNull(), items.size < size)
    }

    // ---------- الحذف ----------
    suspend fun deleteRecord(deviceId: String, id: String) {
        records(deviceId).document(id).delete().await()
    }

    suspend fun deleteRecords(deviceId: String) {
        while (true) {
            val snap = records(deviceId).limit(400).get().await()
            if (snap.isEmpty) break
            val b = db.batch()
            snap.documents.forEach { b.delete(it.reference) }
            b.commit().await()
        }
    }

    suspend fun deleteDevice(deviceId: String) {
        deleteRecords(deviceId)
        devices().document(deviceId).delete().await()
    }

    /** يعيد المصادقة بكلمة المرور، يحذف كل بيانات السحابة، ثم يحذف الحساب نفسه. */
    suspend fun deleteAccount(password: String) {
        val u = auth.currentUser ?: throw IllegalStateException("not signed in")
        u.reauthenticate(EmailAuthProvider.getCredential(u.email!!, password)).await()
        listDevices().forEach { deleteDevice(it.id) }
        cryptoDoc().delete().await()
        u.delete().await()
    }

    private companion object {
        val CHECK_PLAIN = "backup-check-v1".toByteArray()
        val CHECK_AAD = "check".toByteArray()
    }
}
