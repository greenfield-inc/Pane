// The Expo fingerprint of native code, which the native-runtime PR check
// compares (.github/workflows/native-runtime.yml). Version and build numbers
// change with every store build without changing native code, so they don't
// count. The notification service extension in targets/ is native code that
// @bacons/apple-targets adds at prebuild, outside the default sources.
const { SourceSkips } = require('@expo/fingerprint');

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: SourceSkips.ExpoConfigVersions | SourceSkips.ExpoConfigRuntimeVersionIfString,
  extraSources: [{ type: 'dir', filePath: 'targets', reasons: ['appleTargets'] }],
};
