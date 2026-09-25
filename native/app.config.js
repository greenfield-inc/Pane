// Extends app.json. FCM needs the Firebase Android config, which stays out of
// git: put google-services.json (Firebase project pane-pwa-preview, app
// com.dcouple.pane.mobile) next to this file. Without it the app still builds,
// and Settings reports that notifications can't register on Android.
const fs = require('node:fs');
const path = require('node:path');

const googleServicesFile = path.join(__dirname, 'google-services.json');

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    ...(fs.existsSync(googleServicesFile) ? { googleServicesFile: './google-services.json' } : {}),
  },
});
