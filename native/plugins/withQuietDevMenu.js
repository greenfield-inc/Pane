// Dev builds only: keep the dev menu out of the way. It still opens with a
// shake or Cmd-D. Without this, its floating button covers the header's right
// buttons, and it introduces itself and opens on launch, which the Maestro
// flows would have to dismiss. Release builds have no dev menu.
const { AndroidConfig, withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const DEFAULTS = {
  EXDevMenuShowFloatingActionButton: false,
  EXDevMenuShowsAtLaunch: false,
  EXDevMenuIsOnboardingFinished: true,
};

module.exports = function withQuietDevMenu(config) {
  config = withInfoPlist(config, (mod) => {
    Object.assign(mod.modResults, DEFAULTS);
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    for (const [key, value] of Object.entries(DEFAULTS)) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, key, String(value));
    }
    return mod;
  });
};
