// Android: lets the app send plain HTTP to 127.0.0.1, where the pane-direct
// module (modules/pane-direct) listens and opens TLS to the computer. Android
// refuses cleartext by default, and a network security config replaces the
// manifest's usesCleartextTraffic, so this config keeps that choice in
// base-config: debug builds allow cleartext everywhere (Metro), release builds
// only when `cleartext` is set (app.config.js, an http:// update server).
// iOS allows it already through NSAllowsLocalNetworking.
const fs = require('node:fs');
const path = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const NAME = 'pane_network_security';

function securityConfig(baseCleartext) {
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="${baseCleartext}" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`;
}

module.exports = function withLoopbackHttp(config, { cleartext = false } = {}) {
  config = withDangerousMod(config, ['android', (mod) => {
    const src = path.join(mod.modRequest.platformProjectRoot, 'app', 'src');
    for (const [buildType, baseCleartext] of [['main', cleartext], ['debug', true]]) {
      const dir = path.join(src, buildType, 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${NAME}.xml`), securityConfig(baseCleartext));
    }
    return mod;
  }]);
  return withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    app.$['android:networkSecurityConfig'] = `@xml/${NAME}`;
    return mod;
  });
};
