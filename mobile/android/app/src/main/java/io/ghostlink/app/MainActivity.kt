package io.ghostlink.app

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "GhostLinkMobile"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Deliberately passes null instead of the saved instance state.
   *
   * React Native keeps its own view state in JavaScript. If Android is allowed
   * to restore the native fragment hierarchy — after a rotation, a theme
   * change, or when the process is recreated from the background — it tries to
   * rebuild react-native-screens' ScreenStackFragment itself and cannot:
   *
   *   Unable to instantiate fragment com.swmansion.rnscreens.ScreenStackFragment:
   *   calling Fragment constructor caused an exception
   *
   * which kills the activity on relaunch. Dropping the saved state lets React
   * Navigation rebuild the stack from JS, which is the only place that knows
   * what it should look like. This is the standard requirement for
   * react-native-screens on Android.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
