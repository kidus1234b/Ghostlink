const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

const config = {
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
  resolver: {
    sourceExts: [...defaultConfig.resolver.sourceExts, 'svg'],
    assetExts: defaultConfig.resolver.assetExts.filter(ext => ext !== 'svg'),
  },
};

module.exports = mergeConfig(defaultConfig, config);
