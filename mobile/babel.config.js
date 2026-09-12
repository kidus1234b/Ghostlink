module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Must stay last: the reanimated plugin rewrites worklets and expects to
    // run after every other transform.
    [
      'react-native-reanimated/plugin',
      {
        relativeSourceLocation: true,
      },
    ],
  ],
};
