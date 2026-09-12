const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

// This app is an npm workspace, so npm hoists node_modules to the repo root —
// outside Metro's project root. Metro will not serve files from outside the
// project unless the containing directory is watched, so both the watch folder
// and the module search path have to point up a level. Without this, every
// hoisted package (including @babel/runtime) fails to resolve.
const repoRoot = path.resolve(__dirname, '..');

const config = {
  watchFolders: [repoRoot],
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(repoRoot, 'node_modules'),
    ],
    sourceExts: [...defaultConfig.resolver.sourceExts, 'svg'],
    assetExts: defaultConfig.resolver.assetExts.filter(ext => ext !== 'svg'),
  },
};

module.exports = mergeConfig(defaultConfig, config);
