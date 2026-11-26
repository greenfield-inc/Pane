// Hands game controller input to modules/pane-controller before Android's
// view system sees it: MainActivity's dispatchKeyEvent and
// dispatchGenericMotionEvent ask the module first and stop there when it
// takes the event (pads only; keyboards and the system keys pass on).
// Expo's activity hooks see only keys a view passed on, and no stick motion.
// It also keeps the activity alive when a pad connects (configChanges `navigation`).
const { AndroidConfig, withAndroidManifest, withMainActivity } = require('expo/config-plugins');

const MARKER = '// pane-controller: game controller input';

const OVERRIDES = `
  ${MARKER}
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean =
    expo.modules.panecontroller.PaneControllerInput.onKeyEvent(event) || super.dispatchKeyEvent(event)

  override fun dispatchGenericMotionEvent(event: android.view.MotionEvent): Boolean =
    expo.modules.panecontroller.PaneControllerInput.onMotionEvent(event) || super.dispatchGenericMotionEvent(event)
`;

function addControllerInput(source) {
  if (source.includes(MARKER)) return source;
  const classStart = source.match(/class MainActivity\s*:\s*ReactActivity\(\)\s*\{/);
  if (!classStart) throw new Error('withControllerInput: MainActivity.kt has no `class MainActivity : ReactActivity() {` to add controller input to. Update plugins/withControllerInput.js for the new template.');
  const at = classStart.index + classStart[0].length;
  return source.slice(0, at) + OVERRIDES + source.slice(at);
}

// Pairing a pad that reports a D-pad changes the `navigation` configuration; without it in
// configChanges, Android would restart the activity and the app would reopen on Home.
function withNavigationConfigChange(config) {
  return withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    const changes = (activity.$['android:configChanges'] ?? '').split('|').filter(Boolean);
    if (!changes.includes('navigation')) activity.$['android:configChanges'] = [...changes, 'navigation'].join('|');
    return mod;
  });
}

module.exports = function withControllerInput(config) {
  config = withNavigationConfigChange(config);
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt') throw new Error('withControllerInput: MainActivity is not Kotlin.');
    mod.modResults.contents = addControllerInput(mod.modResults.contents);
    return mod;
  });
};
module.exports.addControllerInput = addControllerInput;
