package expo.modules.panecontroller

import android.content.Context
import android.hardware.input.InputManager
import android.os.Build
import android.os.CombinedVibration
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.view.InputDevice
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Game controllers for JavaScript: `onDevice` when a pad connects or
 * disconnects, `onButton` on each press and release (raw names, see
 * PaneControllerInput), `onAxes` with the sticks at most 60 times a second.
 * It reads input only while JavaScript listens, and only while the app is in
 * front, since Android sends input to the focused window alone.
 */
class PaneControllerModule : Module() {
  private val inputManager: InputManager?
    get() = appContext.reactContext?.getSystemService(Context.INPUT_SERVICE) as InputManager?

  private val known = HashSet<Int>()

  private val deviceListener = object : InputManager.InputDeviceListener {
    override fun onInputDeviceAdded(deviceId: Int) {
      val device = InputDevice.getDevice(deviceId) ?: return
      if (!PaneControllerInput.isController(device) || !known.add(deviceId)) return
      sendEvent("onDevice", mapOf("type" to "connect", "device" to describe(device)))
    }

    override fun onInputDeviceRemoved(deviceId: Int) {
      if (!known.remove(deviceId)) return
      PaneControllerInput.forget(deviceId)
      sendEvent("onDevice", mapOf("type" to "disconnect", "device" to mapOf("id" to deviceId.toString())))
    }

    override fun onInputDeviceChanged(deviceId: Int) {
      val device = InputDevice.getDevice(deviceId) ?: return
      if (PaneControllerInput.isController(device)) onInputDeviceAdded(deviceId) else onInputDeviceRemoved(deviceId)
    }
  }

  private val inputListener = object : PaneControllerInput.Listener {
    override fun onButton(deviceId: Int, button: String, pressed: Boolean) {
      // A pad that connected before the listener did is announced on its first input.
      if (known.add(deviceId)) {
        InputDevice.getDevice(deviceId)?.let { sendEvent("onDevice", mapOf("type" to "connect", "device" to describe(it))) }
      }
      sendEvent("onButton", mapOf("deviceId" to deviceId.toString(), "button" to button, "pressed" to pressed))
    }

    override fun onAxes(deviceId: Int, axes: Map<String, Double>) {
      sendEvent("onAxes", mapOf("deviceId" to deviceId.toString(), "axes" to axes))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PaneController")

    Events("onDevice", "onButton", "onAxes")

    Constant("available") { true }

    OnStartObserving {
      known.clear()
      controllers().forEach { known.add(it.id) }
      inputManager?.registerInputDeviceListener(deviceListener, Handler(Looper.getMainLooper()))
      PaneControllerInput.listener = inputListener
    }

    OnStopObserving {
      PaneControllerInput.listener = null
      inputManager?.unregisterInputDeviceListener(deviceListener)
    }

    Function("devices") {
      controllers().map { describe(it) }
    }

    Function("rumble") { deviceId: String, durationMs: Int, strength: Double ->
      rumble(deviceId.toIntOrNull() ?: return@Function false, durationMs, strength)
    }
  }

  private fun controllers(): List<InputDevice> =
    InputDevice.getDeviceIds().mapNotNull { InputDevice.getDevice(it) }.filter { PaneControllerInput.isController(it) }

  private fun hasRumble(device: InputDevice): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && device.vibratorManager.vibratorIds.isNotEmpty()

  private fun describe(device: InputDevice): Map<String, Any> = mapOf(
    "id" to device.id.toString(),
    "name" to device.name,
    "vendorId" to device.vendorId,
    "productId" to device.productId,
    "hasRumble" to hasRumble(device),
  )

  private fun rumble(deviceId: Int, durationMs: Int, strength: Double): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    val device = InputDevice.getDevice(deviceId) ?: return false
    val manager = device.vibratorManager
    if (manager.vibratorIds.isEmpty()) return false
    val amplitude = (strength.coerceIn(0.0, 1.0) * 254).toInt() + 1
    manager.vibrate(CombinedVibration.createParallel(VibrationEffect.createOneShot(durationMs.toLong().coerceIn(1, 1000), amplitude)))
    return true
  }
}
