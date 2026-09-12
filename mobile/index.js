/**
 * This import must stay first and must stay at the top of the entry point.
 * It polyfills crypto.getRandomValues from the platform CSPRNG (Android
 * SecureRandom / iOS SecRandomCopyBytes), and src/utils/crypto.js throws rather
 * than generating guessable keys if it has not run. Anything imported above
 * this line that touches crypto on load would fail.
 */
import 'react-native-get-random-values';

/**
 * Hermes has no TextEncoder/TextDecoder. Both src/utils/crypto.js and @noble
 * need them, so this must run before any crypto is touched — without it the
 * first PBKDF2 call throws "Property 'TextEncoder' doesn't exist".
 */
import './src/utils/text-encoding-polyfill';

import {AppRegistry} from 'react-native';
import App from './App';

AppRegistry.registerComponent('GhostLinkMobile', () => App);
