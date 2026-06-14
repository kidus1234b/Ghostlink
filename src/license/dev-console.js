// DevConsole — diagnostics only (license generation moved to license-generator app)
(function(exports) {
  'use strict';

  class DevConsole {
    constructor() {
      this._visible = false;
    }

    show() {
      console.log('[GhostLink] License keys are generated via the separate license-generator app.');
      console.log('[GhostLink] Open license-generator/index.html locally (admin only).');
    }

    hide() {
      this._visible = false;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.DevConsole = DevConsole;
  exports.GhostLink.devConsole = new DevConsole();

})(typeof globalThis !== 'undefined' ? globalThis : this);
