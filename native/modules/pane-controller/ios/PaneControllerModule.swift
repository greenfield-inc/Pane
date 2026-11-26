import CoreHaptics
import ExpoModulesCore
import GameController

/// Game controllers for JavaScript: `onDevice` when a pad connects or
/// disconnects, `onButton` on each press and release by Apple's element name
/// ('a' is `buttonA`), `onAxes` with the sticks at most 60 times a second.
/// iOS sends controller input only while the app is in front.
public class PaneControllerModule: Module {
  private var observers: [NSObjectProtocol] = []
  private var engines: [ObjectIdentifier: CHHapticEngine] = [:]
  private var lastAxesAt: [ObjectIdentifier: CFTimeInterval] = [:]
  private var pendingAxes: Set<ObjectIdentifier> = []

  public func definition() -> ModuleDefinition {
    Name("PaneController")

    Events("onDevice", "onButton", "onAxes")

    Constant("available") { true }

    OnStartObserving {
      DispatchQueue.main.async { self.start() }
    }

    OnStopObserving {
      DispatchQueue.main.async { self.stop() }
    }

    Function("devices") { () -> [[String: Any]] in
      GCController.controllers().filter { $0.extendedGamepad != nil }.map { self.describe($0) }
    }

    Function("rumble") { (deviceId: String, durationMs: Int, strength: Double) -> Bool in
      guard let controller = GCController.controllers().first(where: { self.id($0) == deviceId }) else { return false }
      return self.rumble(controller, durationMs: durationMs, strength: strength)
    }
  }

  private func start() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] note in
      guard let self, let controller = note.object as? GCController else { return }
      self.attach(controller)
    })
    observers.append(center.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] note in
      guard let self, let controller = note.object as? GCController else { return }
      self.engines.removeValue(forKey: ObjectIdentifier(controller))
      self.sendEvent("onDevice", ["type": "disconnect", "device": ["id": self.id(controller)]])
    })
    GCController.controllers().forEach { attach($0) }
  }

  private func stop() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
    for controller in GCController.controllers() {
      controller.extendedGamepad?.leftThumbstick.valueChangedHandler = nil
      controller.extendedGamepad?.rightThumbstick.valueChangedHandler = nil
      forEachButton(controller) { element, _ in element.pressedChangedHandler = nil }
    }
  }

  private func attach(_ controller: GCController) {
    guard let pad = controller.extendedGamepad else { return }
    let deviceId = id(controller)
    sendEvent("onDevice", ["type": "connect", "device": describe(controller)])
    forEachButton(controller) { element, name in
      element.pressedChangedHandler = { [weak self] _, _, pressed in
        self?.sendEvent("onButton", ["deviceId": deviceId, "button": name, "pressed": pressed])
      }
    }
    pad.leftThumbstick.valueChangedHandler = { [weak self] _, _, _ in self?.queueAxes(controller) }
    pad.rightThumbstick.valueChangedHandler = { [weak self] _, _, _ in self?.queueAxes(controller) }
  }

  /// Every button the controller layer reads, by name. Home is left to the system.
  private func forEachButton(_ controller: GCController, _ body: (GCControllerButtonInput, String) -> Void) {
    guard let pad = controller.extendedGamepad else { return }
    body(pad.buttonA, "a")
    body(pad.buttonB, "b")
    body(pad.buttonX, "x")
    body(pad.buttonY, "y")
    body(pad.leftShoulder, "l1")
    body(pad.rightShoulder, "r1")
    body(pad.leftTrigger, "l2")
    body(pad.rightTrigger, "r2")
    if let button = pad.leftThumbstickButton { body(button, "l3") }
    if let button = pad.rightThumbstickButton { body(button, "r3") }
    if let button = pad.buttonOptions { body(button, "select") }
    body(pad.buttonMenu, "start")
    body(pad.dpad.up, "up")
    body(pad.dpad.down, "down")
    body(pad.dpad.left, "left")
    body(pad.dpad.right, "right")
  }

  /// Sends the sticks at most once per 16 ms per controller, always ending on the latest value.
  private func queueAxes(_ controller: GCController) {
    let key = ObjectIdentifier(controller)
    if pendingAxes.contains(key) { return }
    let wait = (lastAxesAt[key] ?? 0) + 0.016 - CACurrentMediaTime()
    if wait <= 0 {
      sendAxes(controller)
      return
    }
    pendingAxes.insert(key)
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
      self?.pendingAxes.remove(key)
      self?.sendAxes(controller)
    }
  }

  private func sendAxes(_ controller: GCController) {
    guard let pad = controller.extendedGamepad else { return }
    lastAxesAt[ObjectIdentifier(controller)] = CACurrentMediaTime()
    // GameController's +Y is up; the controller layer's is down.
    sendEvent("onAxes", [
      "deviceId": id(controller),
      "axes": [
        "leftX": Double(pad.leftThumbstick.xAxis.value),
        "leftY": Double(-pad.leftThumbstick.yAxis.value),
        "rightX": Double(pad.rightThumbstick.xAxis.value),
        "rightY": Double(-pad.rightThumbstick.yAxis.value),
      ],
    ])
  }

  private func id(_ controller: GCController) -> String {
    String(UInt(bitPattern: ObjectIdentifier(controller).hashValue))
  }

  private func describe(_ controller: GCController) -> [String: Any] {
    [
      "id": id(controller),
      "name": controller.vendorName ?? controller.productCategory,
      "appleCategory": controller.productCategory,
      "hasRumble": controller.haptics != nil,
    ]
  }

  private func rumble(_ controller: GCController, durationMs: Int, strength: Double) -> Bool {
    let key = ObjectIdentifier(controller)
    let engine: CHHapticEngine
    if let existing = engines[key] {
      engine = existing
    } else {
      guard let created = controller.haptics?.createEngine(withLocality: .default) else { return false }
      created.isAutoShutdownEnabled = true
      engines[key] = created
      engine = created
    }
    do {
      try engine.start()
      let event = CHHapticEvent(
        eventType: .hapticContinuous,
        parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(max(0, min(1, strength))))],
        relativeTime: 0,
        duration: Double(max(1, min(1000, durationMs))) / 1000
      )
      try engine.makePlayer(with: CHHapticPattern(events: [event], parameters: [])).start(atTime: CHHapticTimeImmediate)
      return true
    } catch {
      return false
    }
  }
}
