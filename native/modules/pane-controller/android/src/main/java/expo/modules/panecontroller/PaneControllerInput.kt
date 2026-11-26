package expo.modules.panecontroller

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import kotlin.math.abs

/**
 * MainActivity hands every key and motion event to this object first
 * (plugins/withControllerInput.js). Events from a gamepad or joystick device go
 * to the module and are consumed, so B never also triggers Back and the
 * sticks never move Android's own focus. Keyboards, the system Home button and
 * everything else pass through. Nothing is consumed while JavaScript isn't
 * listening, so the app behaves as before until the controller layer starts.
 */
object PaneControllerInput {
  /** Receives raw button names ('a', 'b', 'x', 'y', 'l1', … 'up') and axis snapshots. */
  interface Listener {
    fun onButton(deviceId: Int, button: String, pressed: Boolean)
    fun onAxes(deviceId: Int, axes: Map<String, Double>)
  }

  @Volatile var listener: Listener? = null

  private val buttons = mapOf(
    KeyEvent.KEYCODE_BUTTON_A to "a",
    KeyEvent.KEYCODE_BUTTON_B to "b",
    KeyEvent.KEYCODE_BUTTON_X to "x",
    KeyEvent.KEYCODE_BUTTON_Y to "y",
    KeyEvent.KEYCODE_BUTTON_L1 to "l1",
    KeyEvent.KEYCODE_BUTTON_R1 to "r1",
    KeyEvent.KEYCODE_BUTTON_L2 to "l2",
    KeyEvent.KEYCODE_BUTTON_R2 to "r2",
    KeyEvent.KEYCODE_BUTTON_THUMBL to "l3",
    KeyEvent.KEYCODE_BUTTON_THUMBR to "r3",
    KeyEvent.KEYCODE_BUTTON_SELECT to "select",
    KeyEvent.KEYCODE_BUTTON_START to "start",
    KeyEvent.KEYCODE_DPAD_UP to "up",
    KeyEvent.KEYCODE_DPAD_DOWN to "down",
    KeyEvent.KEYCODE_DPAD_LEFT to "left",
    KeyEvent.KEYCODE_DPAD_RIGHT to "right",
  )

  /** Buttons held per device, from keys, the HAT and analog triggers alike: each change is sent once. */
  private val held = HashMap<Int, MutableSet<String>>()
  private val lastAxes = HashMap<Int, Map<String, Double>>()
  private val lastAxesAt = HashMap<Int, Long>()
  private val pendingAxes = HashMap<Int, Map<String, Double>>()
  private val main = Handler(Looper.getMainLooper())

  fun isController(device: InputDevice?): Boolean {
    if (device == null) return false
    val sources = device.sources
    return sources and InputDevice.SOURCE_GAMEPAD == InputDevice.SOURCE_GAMEPAD ||
      sources and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK
  }

  @JvmStatic
  fun onKeyEvent(event: KeyEvent): Boolean {
    val target = listener ?: return false
    if (!isController(event.device)) return false
    val name = buttons[event.keyCode] ?: return false
    if (event.action == KeyEvent.ACTION_MULTIPLE) return true
    // Repeats of a held key change nothing.
    if (event.repeatCount > 0) return true
    setButton(target, event.deviceId, name, event.action == KeyEvent.ACTION_DOWN)
    return true
  }

  @JvmStatic
  fun onMotionEvent(event: MotionEvent): Boolean {
    val target = listener ?: return false
    if (!isController(event.device)) return false
    if (event.source and InputDevice.SOURCE_JOYSTICK != InputDevice.SOURCE_JOYSTICK &&
      event.source and InputDevice.SOURCE_GAMEPAD != InputDevice.SOURCE_GAMEPAD
    ) return false
    if (event.actionMasked != MotionEvent.ACTION_MOVE) return true
    val id = event.deviceId

    // A D-pad that reports as a HAT arrives here instead of as keys.
    val hatX = event.getAxisValue(MotionEvent.AXIS_HAT_X)
    val hatY = event.getAxisValue(MotionEvent.AXIS_HAT_Y)
    if (event.device?.getMotionRange(MotionEvent.AXIS_HAT_X, event.source) != null) {
      setButton(target, id, "left", hatX < -0.5f)
      setButton(target, id, "right", hatX > 0.5f)
      setButton(target, id, "up", hatY < -0.5f)
      setButton(target, id, "down", hatY > 0.5f)
    }
    // Analog triggers count as pressed past halfway; pads that also send L2/R2 keys agree with this.
    val l2 = maxOf(event.getAxisValue(MotionEvent.AXIS_LTRIGGER), event.getAxisValue(MotionEvent.AXIS_BRAKE))
    val r2 = maxOf(event.getAxisValue(MotionEvent.AXIS_RTRIGGER), event.getAxisValue(MotionEvent.AXIS_GAS))
    if (hasAxis(event, MotionEvent.AXIS_LTRIGGER) || hasAxis(event, MotionEvent.AXIS_BRAKE)) setButton(target, id, "l2", l2 > 0.5f)
    if (hasAxis(event, MotionEvent.AXIS_RTRIGGER) || hasAxis(event, MotionEvent.AXIS_GAS)) setButton(target, id, "r2", r2 > 0.5f)

    val axes = mapOf(
      "leftX" to centered(event, MotionEvent.AXIS_X),
      "leftY" to centered(event, MotionEvent.AXIS_Y),
      "rightX" to centered(event, MotionEvent.AXIS_Z),
      "rightY" to centered(event, MotionEvent.AXIS_RZ),
    )
    queueAxes(target, id, axes)
    return true
  }

  fun forget(deviceId: Int) {
    held.remove(deviceId)
    lastAxes.remove(deviceId)
    lastAxesAt.remove(deviceId)
    pendingAxes.remove(deviceId)
  }

  private fun hasAxis(event: MotionEvent, axis: Int) = event.device?.getMotionRange(axis, event.source) != null

  /** The axis value with the device's own resting noise (its flat range) read as zero. */
  private fun centered(event: MotionEvent, axis: Int): Double {
    val range = event.device?.getMotionRange(axis, event.source) ?: return 0.0
    val value = event.getAxisValue(axis)
    return if (abs(value) > range.flat) value.toDouble() else 0.0
  }

  private fun setButton(target: Listener, deviceId: Int, name: String, pressed: Boolean) {
    val set = held.getOrPut(deviceId) { mutableSetOf() }
    if (pressed == set.contains(name)) return
    if (pressed) set.add(name) else set.remove(name)
    target.onButton(deviceId, name, pressed)
  }

  /** Sends axis changes at most once per 16 ms per device, always ending on the latest value. */
  private fun queueAxes(target: Listener, deviceId: Int, axes: Map<String, Double>) {
    val last = pendingAxes[deviceId] ?: lastAxes[deviceId]
    if (last != null && axes.all { (key, value) -> abs(value - (last[key] ?: 0.0)) < 0.01 }) return
    val now = SystemClock.uptimeMillis()
    val wait = (lastAxesAt[deviceId] ?: 0L) + 16 - now
    if (wait <= 0) {
      pendingAxes.remove(deviceId)
      sendAxes(target, deviceId, axes, now)
      return
    }
    val alreadyQueued = pendingAxes.containsKey(deviceId)
    pendingAxes[deviceId] = axes
    if (alreadyQueued) return
    main.postDelayed({
      val latest = pendingAxes.remove(deviceId) ?: return@postDelayed
      sendAxes(listener ?: return@postDelayed, deviceId, latest, SystemClock.uptimeMillis())
    }, wait)
  }

  private fun sendAxes(target: Listener, deviceId: Int, axes: Map<String, Double>, now: Long) {
    lastAxes[deviceId] = axes
    lastAxesAt[deviceId] = now
    target.onAxes(deviceId, axes)
  }
}
