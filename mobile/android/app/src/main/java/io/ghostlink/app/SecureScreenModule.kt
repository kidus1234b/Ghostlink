package io.ghostlink.app

import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

/**
 * Sets FLAG_SECURE on the activity window.
 *
 * With it, Android refuses to screenshot the window, excludes it from screen
 * recording, and renders a blank card instead of a live preview in the recent
 * apps switcher. The recovery phrase is shown on three screens — the reveal,
 * the restore entry, and the verification quiz — and on all three it is the
 * whole identity in plain text. A screenshot of any of them, sitting in a
 * gallery that syncs to a cloud, hands the identity to whoever can read that
 * gallery.
 *
 * The flag is per-window, not per-screen, so it is set on entering one of
 * those screens and cleared on leaving. Reference counted: React may mount the
 * next secure screen before unmounting the previous one, and a naive
 * clear-on-unmount would drop the flag while a phrase was still visible.
 */
class SecureScreenModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var holders = 0

  override fun getName() = "SecureScreen"

  /** Take a reference and set the flag. Safe to call from several screens. */
  @ReactMethod
  fun acquire(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      // The caller must be able to tell "protected" from "could not protect".
      promise.reject("no_activity", "No current activity to secure")
      return
    }
    activity.runOnUiThread {
      holders += 1
      activity.window.setFlags(
          WindowManager.LayoutParams.FLAG_SECURE,
          WindowManager.LayoutParams.FLAG_SECURE
      )
    }
    promise.resolve(true)
  }

  /** Release a reference; the flag clears when the last holder goes. */
  @ReactMethod
  fun release(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      holders = maxOf(0, holders - 1)
      if (holders == 0) {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }
    promise.resolve(true)
  }

  /** Whether the window is currently protected. Used by tests and diagnostics. */
  @ReactMethod
  fun isSecure(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    val flags = activity.window.attributes.flags
    promise.resolve((flags and WindowManager.LayoutParams.FLAG_SECURE) != 0)
  }
}
