import ExpoModulesCore

/// Runs pane-direct's `connect` in the app: `connect` returns a loopback port
/// whose plain HTTP reaches the computer over TLS to its pinned key, through a
/// direct QUIC path when one works. Each connection reports `onEvent` with its
/// id and the event's JSON.
public class PaneDirectModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaneDirect")

    Events("onEvent")

    // iOS builds always link the library (ios/PaneDirect.podspec).
    Constant("available") { true }

    AsyncFunction("connect") { (config: String) -> [String: Any] in
      let result = takeString(config.withCString { pane_direct_connect($0) }) ?? "{}"
      let value = (try? JSONSerialization.jsonObject(with: Data(result.utf8))) as? [String: Any] ?? [:]
      guard let id = (value["id"] as? NSNumber)?.uint64Value, let port = value["port"] as? Int else {
        throw DirectConnectException(value["error"] as? String ?? "unknown error")
      }
      self.forwardEvents(id)
      return ["id": Double(id), "port": port]
    }

    Function("close") { (id: Double) in
      pane_direct_close(UInt64(id))
    }
  }

  /// Sends the connection's events to JavaScript until it closes.
  private func forwardEvents(_ id: UInt64) {
    Thread.detachNewThread { [weak self] in
      while true {
        guard let event = takeString(pane_direct_next_event(id, 1000)) else { continue }
        let closed = event == #"{"t":"closed"}"#
        // A module torn down with the app's JavaScript closes its connections.
        guard let self else {
          if closed { return }
          pane_direct_close(id)
          continue
        }
        self.sendEvent("onEvent", ["id": Double(id), "event": event])
        if closed { return }
      }
    }
  }
}

/// Copies and frees a string from the library; nil stays nil.
private func takeString(_ text: UnsafeMutablePointer<CChar>?) -> String? {
  guard let text else { return nil }
  defer { pane_direct_free_string(text) }
  return String(cString: text)
}

final class DirectConnectException: GenericException<String> {
  override var reason: String {
    "Pane could not start a direct connection: \(param)"
  }
}
