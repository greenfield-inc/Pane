// Expo configures Metro for pnpm workspaces (watchFolders, node_modules lookup)
// on its own; `@shared/*` resolves through the tsconfig paths.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
