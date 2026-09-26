/**
 * Workaround for electron-builder + npm workspaces (hoisted node_modules).
 *
 * electron-builder decides whether to run "installing production
 * dependencies" by checking whether <appDir>/node_modules exists. With npm
 * workspaces every dependency is hoisted to the repository root, so
 * electron/node_modules never exists, electron-builder runs a production
 * install, and npm — honoring the workspace lockfile — prunes DEV
 * dependencies (7zip-bin, electron itself) from the root node_modules,
 * which then makes the build fail when it tries to use them.
 *
 * Creating the directory beforehand makes electron-builder treat the app as
 * already installed and skip that step. Dependencies are still resolved
 * from the hoisted workspace root when the asar is assembled.
 */
const fs = require('fs');
fs.mkdirSync(__dirname + '/../node_modules', { recursive: true });
