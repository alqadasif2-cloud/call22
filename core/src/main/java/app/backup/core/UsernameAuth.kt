package app.backup.core

import android.content.Context
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.UserProfileChangeRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale

class UsernameAuthException(message: String) : Exception(message)

data class NormalizedUsername(
    val username: String,
    val usernameLower: String,
    val usernameId: String,
    val syntheticEmail: String,
)

object UsernameAuth {
    private val USERNAME_REGEX = Regex("^[a-zA-Z0-9_.\\-\\u0600-\\u06FF]{3,32}$")
    private const val PREFS_NAME = "username_auth_prefs"
    private const val RATE_WINDOW_MS = 15 * 60 * 1000L
    private const val LOCKOUT_MS = 15 * 60 * 1000L
    private const val MAX_ATTEMPTS = 5

    /** يمنع تعارض مستمع الجلسة في AuthGate أثناء اشتقاق مفتاح التشفير عند التسجيل أو الدخول. */
    @Volatile
    var inProgress: Boolean = false
        private set

    /** رابط وظيفة Cloud Function الاختيارية للمصادقة المخصصة (Custom Authentication). */
    @Volatile
    var customAuthEndpoint: String = ""

    fun normalizeUsername(raw: String): NormalizedUsername {
        val trimmed = raw.trim()
        if (trimmed.length < 3 || trimmed.length > 32) {
            throw UsernameAuthException("يجب أن يتكون اسم المستخدم من 3 إلى 32 حرفًا أو رقمًا دون مسافات.")
        }
        if (!USERNAME_REGEX.matches(trimmed)) {
            throw UsernameAuthException("اسم المستخدم يقبل الحروف والأرقام والنقطة والشرطة فقط دون مسافات.")
        }
        val lower = trimmed.lowercase(Locale.ROOT)
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("uname:$lower".toByteArray(Charsets.UTF_8))
        val hex = buildString(digest.size * 2) {
            for (b in digest) append(String.format(Locale.US, "%02x", b))
        }
        val usernameId = hex.take(40)
        return NormalizedUsername(
            username = trimmed,
            usernameLower = lower,
            usernameId = usernameId,
            syntheticEmail = "u_$usernameId@users.personalbackup.app",
        )
    }

    fun validatePassword(raw: String): String {
        if (raw.length < 8) {
            throw UsernameAuthException("يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.")
        }
        if (raw.length > 128) {
            throw UsernameAuthException("كلمة المرور تتجاوز الحد الأقصى المسموح به (128 حرفًا).")
        }
        return raw
    }

    private fun checkClientRateLimit(ctx: Context, nowMs: Long = System.currentTimeMillis()) {
        val prefs = ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val blockedUntil = prefs.getLong("blocked_until", 0L)
        if (blockedUntil > nowMs) {
            val mins = ((blockedUntil - nowMs + 59_999L) / 60_000L).coerceAtLeast(1L)
            throw UsernameAuthException("تم إيقاف المحاولات مؤقتًا لكثرة المحاولات الخاطئة. حاول مجددًا بعد $mins دقيقة.")
        }
    }

    private fun recordClientFailure(ctx: Context, nowMs: Long = System.currentTimeMillis()) {
        val prefs = ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val start = prefs.getLong("window_start", 0L)
        val prev = if (nowMs - start > RATE_WINDOW_MS) 0 else prefs.getInt("attempts", 0)
        val next = prev + 1
        val nextStart = if (prev == 0) nowMs else start
        val blockedUntil = if (next >= MAX_ATTEMPTS) nowMs + LOCKOUT_MS else 0L
        prefs.edit()
            .putInt("attempts", next)
            .putLong("window_start", nextStart)
            .putLong("blocked_until", blockedUntil)
            .apply()
    }

    private fun clearClientFailures(ctx: Context) {
        ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove("attempts")
            .remove("window_start")
            .remove("blocked_until")
            .apply()
    }

    fun savedUsername(ctx: Context): String? =
        ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString("last_username", null)

    private fun saveCurrentUsername(ctx: Context, username: String) {
        ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("last_username", username)
            .apply()
    }

    private suspend fun callCustomAuthFunction(
        endpoint: String,
        action: String,
        username: String,
        password: String,
        idToken: String? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 20_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (!idToken.isNullOrBlank()) {
                setRequestProperty("Authorization", "Bearer $idToken")
            }
        }
        try {
            val payload = JSONObject()
                .put("action", action)
                .put("username", username)
                .put("password", password)
                .toString()
            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val bodyText = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(bodyText) }.getOrElse { JSONObject() }
            if (code !in 200..299 || !json.optBoolean("ok", false)) {
                val msg = json.optString("error").ifBlank { "تعذّرت المصادقة مع الخادم ($code)." }
                throw UsernameAuthException(msg)
            }
            json
        } finally {
            conn.disconnect()
        }
    }

    /** إنشاء حساب جديد باسم المستخدم وكلمة المرور وتهيئة مفتاح التشفير وحفظ الجلسة مباشرةً. */
    suspend fun register(
        context: Context,
        rawUsername: String,
        rawPassword: String,
        auth: FirebaseAuth = FirebaseAuth.getInstance(),
    ): String {
        val appCtx = context.applicationContext
        val norm = normalizeUsername(rawUsername)
        val validPw = validatePassword(rawPassword)
        checkClientRateLimit(appCtx)

        inProgress = true
        try {
            val endpoint = customAuthEndpoint.trim()
            if (endpoint.isNotEmpty()) {
                val res = callCustomAuthFunction(endpoint, "register", norm.username, validPw)
                auth.signInWithCustomToken(res.getString("customToken")).await()
            } else {
                auth.createUserWithEmailAndPassword(norm.syntheticEmail, validPw).await()
                runCatching {
                    val req = UserProfileChangeRequest.Builder().setDisplayName(norm.username).build()
                    auth.currentUser?.updateProfile(req)?.await()
                }
            }

            val repo = CloudRepo(auth = auth)
            repo.ensureUserProfile(norm, isNewRegistration = endpoint.isEmpty())

            val key = if (repo.hasCrypto()) {
                repo.unlock(validPw.toCharArray())
                    ?: throw UsernameAuthException("تعذّر التحقق من مفتاح التشفير للحساب.")
            } else {
                repo.createCrypto(validPw.toCharArray())
            }

            KeyVault(appCtx).save(key)
            Session.key = key
            saveCurrentUsername(appCtx, norm.username)
            clearClientFailures(appCtx)
            return norm.username
        } catch (e: Exception) {
            if (e !is UsernameAuthException) {
                recordClientFailure(appCtx)
            }
            throw e
        } finally {
            inProgress = false
        }
    }

    /** تسجيل الدخول باسم المستخدم وكلمة المرور وفك قفل الخزنة وحفظ الجلسة مباشرةً. */
    suspend fun login(
        context: Context,
        rawUsername: String,
        rawPassword: String,
        auth: FirebaseAuth = FirebaseAuth.getInstance(),
    ): String {
        val appCtx = context.applicationContext
        val norm = normalizeUsername(rawUsername)
        val validPw = validatePassword(rawPassword)
        checkClientRateLimit(appCtx)

        inProgress = true
        try {
            val endpoint = customAuthEndpoint.trim()
            if (endpoint.isNotEmpty()) {
                val res = callCustomAuthFunction(endpoint, "login", norm.username, validPw)
                auth.signInWithCustomToken(res.getString("customToken")).await()
            } else {
                auth.signInWithEmailAndPassword(norm.syntheticEmail, validPw).await()
            }

            val repo = CloudRepo(auth = auth)
            repo.ensureUserProfile(norm, isNewRegistration = false)

            val key = if (repo.hasCrypto()) {
                repo.unlock(validPw.toCharArray()) ?: run {
                    auth.signOut()
                    recordClientFailure(appCtx)
                    throw UsernameAuthException("اسم المستخدم أو كلمة المرور غير صحيحة.")
                }
            } else {
                repo.createCrypto(validPw.toCharArray())
            }

            KeyVault(appCtx).save(key)
            Session.key = key
            val resolvedName = repo.getCurrentUsername() ?: norm.username
            saveCurrentUsername(appCtx, resolvedName)
            clearClientFailures(appCtx)
            return resolvedName
        } catch (e: Exception) {
            if (e !is UsernameAuthException) {
                recordClientFailure(appCtx)
            }
            throw e
        } finally {
            inProgress = false
        }
    }

    suspend fun deleteCustomAuthAccountIfConfigured(password: String, auth: FirebaseAuth): Boolean {
        val endpoint = customAuthEndpoint.trim()
        if (endpoint.isEmpty()) return false
        val user = auth.currentUser ?: throw IllegalStateException("not signed in")
        val idToken = user.getIdToken(false).await().token
            ?: throw UsernameAuthException("تعذّر التحقق من الجلسة الحالية.")
        callCustomAuthFunction(endpoint, "deleteAccount", "", password, idToken)
        auth.signOut()
        return true
    }

    fun signOut(context: Context, auth: FirebaseAuth = FirebaseAuth.getInstance()) {
        Session.key = null
        KeyVault(context.applicationContext).clear()
        auth.signOut()
    }
}
