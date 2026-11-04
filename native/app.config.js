// Extends app.json. FCM needs the Firebase Android config, which stays out of
// git: put google-services.json (Firebase project pane-pwa-preview, app
// com.dcouple.pane.mobile) next to this file. Without it the app still builds,
// and Settings reports that notifications can't register on Android.
//
// PANE_UPDATES_URL points a local build at another update server, such as one
// running on this computer (native/README.md, "Over-the-air updates"). An
// http:// URL also allows plain HTTP on Android, for that build only.
const fs = require('node:fs');
const path = require('node:path');

const googleServicesFile = path.join(__dirname, 'google-services.json');
const updatesUrl = process.env.PANE_UPDATES_URL;
const cleartext = updatesUrl?.startsWith('http://') ?? false;

module.exports = ({ config }) => ({
  ...config,
  updates: updatesUrl ? { ...config.updates, url: updatesUrl } : config.updates,
  android: {
    ...config.android,
    ...(fs.existsSync(googleServicesFile) ? { googleServicesFile: './google-services.json' } : {}),
  },
  plugins: cleartext
    ? config.plugins.map(plugin => (Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
      ? [plugin[0], { ...plugin[1], android: { ...plugin[1].android, usesCleartextTraffic: true } }]
      : plugin))
    : config.plugins,
});
