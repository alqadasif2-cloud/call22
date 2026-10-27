package app.backup.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** AES-256-GCM + PBKDF2-HMAC-SHA256. المفتاح لا يغادر الجهاز أبدًا. */
object Crypto {
    const val ITERATIONS = 310_000
    private val rnd = SecureRandom()

    class Box(val iv: ByteArray, val data: ByteArray)

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { rnd.nextBytes(it) }

    fun deriveKey(pass: CharArray, salt: ByteArray, iterations: Int = ITERATIONS): ByteArray {
        val spec = PBEKeySpec(pass, salt, iterations, 256)
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    fun encrypt(key: ByteArray, plain: ByteArray, aad: ByteArray): Box {
        val iv = randomBytes(12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return Box(iv, c.doFinal(plain))
    }

    fun decrypt(key: ByteArray, iv: ByteArray, data: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return c.doFinal(data)
    }

    fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
    fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

    fun sha256Hex(s: String): String = sha256Hex(s.toByteArray(Charsets.UTF_8))
    fun sha256Hex(b: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
}
