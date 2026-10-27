package app.backup.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** مفتاح البيانات في الذاكرة فقط أثناء الاستخدام. */
object Session {
    @Volatile var key: ByteArray? = null
}

/**
 * يحفظ مفتاح التشفير على هذا الجهاز مغلَّفًا بمفتاح Android Keystore (غير قابل للتصدير)،
 * حتى تعمل المزامنة الخلفية دون إعادة إدخال عبارة المرور.
 */
class KeyVault(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("key_vault", Context.MODE_PRIVATE)

    private fun wrapKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return g.generateKey()
    }

    fun save(key: ByteArray) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, wrapKey())
        val ct = c.doFinal(key)
        prefs.edit().putString("iv", Crypto.b64(c.iv)).putString("k", Crypto.b64(ct)).apply()
    }

    fun load(): ByteArray? = try {
        val iv = prefs.getString("iv", null)
        val k = prefs.getString("k", null)
        if (iv == null || k == null) null else {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, Crypto.unb64(iv)))
            c.doFinal(Crypto.unb64(k))
        }
    } catch (e: Exception) {
        null
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val ALIAS = "backup_wrap_key_v1"
    }
}
