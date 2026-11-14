package expo.modules.panedirect

import android.content.Context

/** JNI bindings to the pane-direct Rust library (direct/src/android.rs). */
internal object PaneDirectNative {
  /** False when the app was built without the library for this ABI (scripts/build-android.sh). */
  val loaded: Boolean = try {
    System.loadLibrary("pane_direct")
    true
  } catch (_: UnsatisfiedLinkError) {
    false
  }

  external fun init(context: Context)

  /** `{"id","port"}` or `{"error"}`. */
  external fun connect(config: String): String?

  /** The next event's JSON, null on timeout, `{"t":"closed"}` once closed. */
  external fun nextEvent(id: Long, timeoutMs: Int): String?

  external fun close(id: Long)
}
