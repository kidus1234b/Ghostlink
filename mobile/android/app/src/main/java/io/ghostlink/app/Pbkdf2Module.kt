package io.ghostlink.app

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * PBKDF2 in native code, off the JS thread.
 *
 * Identity derivation runs three 100,000-iteration PBKDF2 passes (two of them
 * HMAC-SHA512). In pure JS that is ~2.5s on desktop V8 and minutes under
 * Hermes on a real phone — JS has no 64-bit integers, so every SHA-512 round
 * is emulated with 32-bit pairs. @noble's async PBKDF2 yields every 10ms,
 * which keeps Android's watchdog happy but still pins the JS thread for the
 * whole run, so the UI is dead the entire time. That is the "frozen for four
 * minutes" setup screen.
 *
 * PBKDF2 is implemented here directly over javax.crypto.Mac rather than
 * through SecretKeyFactory/PBEKeySpec for two reasons:
 *
 *   - PBEKeySpec takes a char[], and how a provider turns those chars into
 *     bytes is not consistent across implementations. Doing it here means the
 *     password is explicitly the UTF-8 bytes of the phrase, which is exactly
 *     what @noble hashes. The derived key must be byte-identical or every
 *     existing identity on this device stops resolving.
 *   - PBKDF2WithHmacSHA512 via SecretKeyFactory is API 26+; Mac/HmacSHA512 has
 *     been available since API 1, and this app ships minSdk 24.
 *
 * Work runs on a small background pool, so the JS thread is free while it
 * happens and the screen can animate.
 */
class Pbkdf2Module(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val pool = Executors.newFixedThreadPool(2) { r ->
    Thread(r, "ghostlink-pbkdf2").apply { isDaemon = true }
  }

  override fun getName() = "Pbkdf2"

  /**
   * @param password  the recovery phrase; hashed as its UTF-8 bytes
   * @param salt      domain-separation string; hashed as its UTF-8 bytes
   * @param iterations PBKDF2 `c`
   * @param keyLength  desired output in bytes
   * @param hash      "sha256" or "sha512"
   * @return lowercase hex of the derived key
   */
  @ReactMethod
  fun derive(
      password: String,
      salt: String,
      iterations: Int,
      keyLength: Int,
      hash: String,
      promise: Promise
  ) {
    pool.execute {
      try {
        val algorithm = when (hash.lowercase()) {
          "sha256" -> "HmacSHA256"
          "sha512" -> "HmacSHA512"
          else -> {
            promise.reject("E_HASH", "Unsupported hash: $hash")
            return@execute
          }
        }
        if (iterations < 1 || keyLength < 1 || keyLength > 1024) {
          promise.reject("E_PARAMS", "Bad iterations/keyLength")
          return@execute
        }
        val out = pbkdf2(
            password.toByteArray(Charsets.UTF_8),
            salt.toByteArray(Charsets.UTF_8),
            iterations,
            keyLength,
            algorithm
        )
        promise.resolve(out.joinToString("") { "%02x".format(it) })
      } catch (e: Throwable) {
        // Rejecting sends the caller back to the JS implementation rather than
        // leaving it without a key.
        promise.reject("E_PBKDF2", e.message ?: e.toString(), e)
      }
    }
  }

  /** RFC 8018 PBKDF2. */
  private fun pbkdf2(
      password: ByteArray,
      salt: ByteArray,
      iterations: Int,
      keyLength: Int,
      algorithm: String
  ): ByteArray {
    val mac = Mac.getInstance(algorithm)
    mac.init(SecretKeySpec(password, algorithm))
    val hLen = mac.macLength
    val blocks = (keyLength + hLen - 1) / hLen
    val out = ByteArray(keyLength)
    var offset = 0

    for (i in 1..blocks) {
      // U1 = PRF(P, S || INT_32_BE(i))
      mac.update(salt)
      mac.update(byteArrayOf(
          (i ushr 24).toByte(), (i ushr 16).toByte(), (i ushr 8).toByte(), i.toByte()))
      var u = mac.doFinal()
      val t = u.copyOf()

      // T_i = U1 xor U2 xor ... xor Uc
      for (round in 2..iterations) {
        u = mac.doFinal(u)
        for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
      }

      val take = minOf(hLen, keyLength - offset)
      System.arraycopy(t, 0, out, offset, take)
      offset += take
    }
    return out
  }
}
