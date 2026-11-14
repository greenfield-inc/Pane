package expo.modules.panedirect

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import kotlin.concurrent.thread

private const val CLOSED = """{"t":"closed"}"""

/**
 * Runs pane-direct's `connect` in the app: `connect` returns a loopback port
 * whose plain HTTP reaches the computer over TLS to its pinned key, through a
 * direct QUIC path when one works. Each connection reports `onEvent` with its
 * id and the event's JSON.
 */
class PaneDirectModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaneDirect")

    Events("onEvent")

    OnCreate {
      if (PaneDirectNative.loaded) {
        appContext.reactContext?.applicationContext?.let { PaneDirectNative.init(it) }
      }
    }

    Constant("available") { PaneDirectNative.loaded }

    AsyncFunction("connect") { config: String ->
      if (!PaneDirectNative.loaded) throw DirectConnectException("this build has no pane-direct library for its ABI")
      val value = JSONObject(PaneDirectNative.connect(config) ?: "{}")
      if (!value.has("id")) throw DirectConnectException(value.optString("error", "unknown error"))
      val id = value.getLong("id")
      forwardEvents(id)
      mapOf("id" to id.toDouble(), "port" to value.getInt("port"))
    }

    Function("close") { id: Double ->
      if (PaneDirectNative.loaded) PaneDirectNative.close(id.toLong())
    }

    OnDestroy {
      closeAll = true
    }
  }

  @Volatile private var closeAll = false

  /** Sends the connection's events to JavaScript until it closes. */
  private fun forwardEvents(id: Long) {
    thread(name = "pane-direct-events-$id", isDaemon = true) {
      while (true) {
        val event = PaneDirectNative.nextEvent(id, 1000) ?: continue
        val closed = event == CLOSED
        // A module torn down with the app's JavaScript closes its connections.
        if (closeAll && !closed) {
          PaneDirectNative.close(id)
          continue
        }
        sendEvent("onEvent", mapOf("id" to id.toDouble(), "event" to event))
        if (closed) return@thread
      }
    }
  }
}

internal class DirectConnectException(message: String) :
  CodedException("Pane could not start a direct connection: $message")
