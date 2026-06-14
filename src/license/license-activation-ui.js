// LicenseActivationUI — UI component for license activation
// Provides a UI for activating GhostLink Pro licenses
(function(exports) {
  'use strict';

  /**
   * Default CSS styles
   * @type {string}
   */
  const DEFAULT_STYLES = `
    .gl-license-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999998;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .gl-license-modal {
      background: #1a1a2e;
      border: 1px solid #3a3a5e;
      border-radius: 12px;
      padding: 24px;
      width: 420px;
      max-width: 90vw;
      color: #e0e0e0;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }
    .gl-license-modal h2 {
      margin: 0 0 8px 0;
      font-size: 20px;
      color: #00ff88;
    }
    .gl-license-modal .subtitle {
      color: #888;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .gl-license-modal input[type="text"] {
      width: 100%;
      padding: 12px;
      background: #0a0a1e;
      border: 1px solid #3a3a5e;
      border-radius: 6px;
      color: #e0e0e0;
      font-size: 14px;
      font-family: monospace;
      box-sizing: border-box;
      margin-bottom: 12px;
    }
    .gl-license-modal input[type="text"]::placeholder {
      color: #555;
      font-family: monospace;
    }
    .gl-license-modal .btn {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: bold;
      cursor: pointer;
      margin-bottom: 8px;
    }
    .gl-license-modal .btn-primary {
      background: #00ff88;
      color: #1a1a2e;
    }
    .gl-license-modal .btn-primary:hover {
      background: #00dd77;
    }
    .gl-license-modal .btn-primary:disabled {
      background: #3a5e4a;
      cursor: not-allowed;
    }
    .gl-license-modal .btn-secondary {
      background: #2a2a4e;
      color: #e0e0e0;
    }
    .gl-license-modal .btn-secondary:hover {
      background: #3a3a5e;
    }
    .gl-license-modal .error {
      color: #ff4466;
      font-size: 13px;
      margin-bottom: 12px;
      padding: 10px;
      background: rgba(255, 68, 102, 0.1);
      border-radius: 6px;
      display: none;
    }
    .gl-license-modal .error.show {
      display: block;
    }
    .gl-license-modal .success {
      color: #00ff88;
      font-size: 13px;
      margin-bottom: 12px;
      padding: 10px;
      background: rgba(0, 255, 136, 0.1);
      border-radius: 6px;
      display: none;
    }
    .gl-license-modal .success.show {
      display: block;
    }
    .gl-license-modal .info {
      color: #888;
      font-size: 12px;
      text-align: center;
      margin-top: 16px;
    }
    .gl-license-modal .info a {
      color: #00ff88;
      text-decoration: none;
    }
  `;

  /**
   * LicenseActivationUI — UI component for license activation
   * @class
   */
  class LicenseActivationUI {
    /**
     * Creates a new LicenseActivationUI
     * @param {Object} [options={}] - Configuration options
     * @param {Object} [options.licenseManager] - LicenseManager instance
     * @param {Object} [options.featureGate] - FeatureGateManager instance
     */
    constructor(options = {}) {
      /** @type {Object} LicenseManager instance */
      this._licenseManager = options.licenseManager || null;
      /** @type {Object} FeatureGateManager instance */
      this._featureGate = options.featureGate || null;
      /** @type {HTMLElement|null} Modal element */
      this._modal = null;
      /** @type {boolean} Is destroyed */
      this._destroyed = false;
      /** @type {boolean} Styles injected */
      this._stylesInjected = false;
      /** @type {Function} Close callback */
      this._onClose = options.onClose || null;
    }

    /**
     * Injects required CSS styles
     * @private
     */
    _injectStyles() {
      if (this._stylesInjected) return;
      if (document.getElementById('gl-license-styles')) return;

      const style = document.createElement('style');
      style.id = 'gl-license-styles';
      style.textContent = DEFAULT_STYLES;
      document.head.appendChild(style);
      this._stylesInjected = true;
    }

    /**
     * Shows the activation modal
     * @param {Object} [options={}] - Show options
     * @param {boolean} [options.showDevConsole=false] - Show dev console option
     */
    show(options = {}) {
      if (this._destroyed) return;

      this._injectStyles();

      // Remove existing modal
      this._removeModal();

      // Create overlay
      const overlay = document.createElement('div');
      overlay.className = 'gl-license-modal-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.hide();
        }
      });

      // Create modal
      const modal = document.createElement('div');
      modal.className = 'gl-license-modal';

      // Build modal content
      modal.innerHTML = `
        <h2>Activate GhostLink Pro</h2>
        <p class="subtitle">Enter your license key to unlock Pro features</p>
        <div class="error" id="gl-license-error"></div>
        <div class="success" id="gl-license-success"></div>
        <input type="text" id="gl-license-key" placeholder="GHOST-XXXX-XXXX-XXXX-XXXX-XXXX" />
        <button class="btn btn-primary" id="gl-license-activate">Activate</button>
        <button class="btn btn-secondary" id="gl-license-close">Cancel</button>
        ${options.showDevConsole ? '<div class="info"><a href="#" id="gl-license-dev">Open Dev Console</a></div>' : ''}
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      this._modal = overlay;

      // Attach event listeners
      document.getElementById('gl-license-activate').addEventListener('click', () => {
        this._activate();
      });

      document.getElementById('gl-license-close').addEventListener('click', () => {
        this.hide();
      });

      document.getElementById('gl-license-key').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this._activate();
        }
      });

      if (options.showDevConsole) {
        document.getElementById('gl-license-dev').addEventListener('click', (e) => {
          e.preventDefault();
          this.hide();
          if (window.GhostLink && window.GhostLink.devConsole) {
            window.GhostLink.devConsole.show();
          }
        });
      }

      // Focus input
      setTimeout(() => {
        document.getElementById('gl-license-key').focus();
      }, 100);
    }

    /**
     * Hides the activation modal
     */
    hide() {
      this._removeModal();
      if (this._onClose) {
        this._onClose();
      }
    }

    /**
     * Removes the modal from DOM
     * @private
     */
    _removeModal() {
      if (this._modal) {
        this._modal.remove();
        this._modal = null;
      }
    }

    /**
     * Performs license activation
     * @private
     */
    async _activate() {
      const keyInput = document.getElementById('gl-license-key');
      const errorEl = document.getElementById('gl-license-error');
      const successEl = document.getElementById('gl-license-success');
      const activateBtn = document.getElementById('gl-license-activate');

      const key = keyInput.value.trim();

      // Clear previous messages
      errorEl.classList.remove('show');
      successEl.classList.remove('show');

      // Validate key format
      if (!key) {
        errorEl.textContent = 'Please enter a license key';
        errorEl.classList.add('show');
        return;
      }

      if (!/^GHOST-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(key)) {
        errorEl.textContent = 'Invalid license key format';
        errorEl.classList.add('show');
        return;
      }

      // Disable button during activation
      activateBtn.disabled = true;
      activateBtn.textContent = 'Activating...';

      try {
        let result;

        if (this._licenseManager) {
          result = await this._licenseManager.activate(key);
        } else if (window.GhostLink && window.GhostLink.licenseManager) {
          result = await window.GhostLink.licenseManager.activate(key);
        } else {
          throw new Error('License manager not available');
        }

        if (result.success) {
          successEl.textContent = 'License activated successfully! Refreshing features...';
          successEl.classList.add('show');
          if (this._featureGate) {
            await this._featureGate.refresh();
          } else if (window.GhostLink && window.GhostLink.featureGate) {
            await window.GhostLink.featureGate.refresh();
          }

          // Reload page after short delay to apply changes
          setTimeout(() => {
            this.hide();
            // Optional: reload or dispatch event to update UI
            if (typeof window.updateUI === 'function') {
              window.updateUI();
            }
          }, 1500);

        } else {
          let errorMessage = 'Activation failed';
          switch (result.error) {
            case 'INVALID_FORMAT':
              errorMessage = 'Invalid license key format';
              break;
            case 'INVALID_CHECKSUM':
              errorMessage = 'License key checksum verification failed';
              break;
            case 'INVALID_SIGNATURE':
              errorMessage = 'License key signature verification failed';
              break;
            case 'EXPIRED':
              errorMessage = 'This license key has expired';
              break;
            case 'DEVICE_MISMATCH':
              errorMessage = 'This license key is bound to a different device';
              break;
            default:
              errorMessage = result.error || 'Unknown error occurred';
          }
          errorEl.textContent = errorMessage;
          errorEl.classList.add('show');
        }

      } catch (err) {
        errorEl.textContent = 'Error: ' + err.message;
        errorEl.classList.add('show');
      } finally {
        activateBtn.disabled = false;
        activateBtn.textContent = 'Activate';
      }
    }

    /**
     * Shows the upgrade modal when a feature is locked
     * @param {string} featureName - Name of the locked feature
     */
    showUpgradePrompt(featureName) {
      if (this._destroyed) return;

      this._injectStyles();
      this._removeModal();

      const overlay = document.createElement('div');
      overlay.className = 'gl-license-modal-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.hide();
        }
      });

      const modal = document.createElement('div');
      modal.className = 'gl-license-modal';

      const featureNames = {
        'unlimited_peers': 'Unlimited Peers',
        'large_file_transfer': 'Large File Transfer',
        'full_export': 'Full Export',
        'team_workspaces': 'Team Workspaces',
        'pro_themes': 'Pro Themes'
      };

      modal.innerHTML = `
        <h2>🔒 ${featureNames[featureName] || 'Feature'}</h2>
        <p class="subtitle">This feature requires a GhostLink Pro license</p>
        <button class="btn btn-primary" id="gl-license-upgrade">Upgrade Now</button>
        <button class="btn btn-secondary" id="gl-license-dismiss">Maybe Later</button>
        <div class="info">
          <a href="mailto:ghostlink@proton.me?subject=Pro License Request">Contact for pricing</a>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      this._modal = overlay;

      document.getElementById('gl-license-upgrade').addEventListener('click', async () => {
        const deviceId = window.GhostLink?.deviceFingerprint
          ? await window.GhostLink.deviceFingerprint.getFingerprint()
          : 'unknown';
        window.location.href = `mailto:ghostlink@proton.me?subject=GhostLink%20License%20Request&body=Plan:%20Pro%0ADevice%20ID:%20${encodeURIComponent(deviceId)}%0A%0A(Enterprise:%20include%20company%20name%20and%20user%20count)`;
      });

      document.getElementById('gl-license-dismiss').addEventListener('click', () => {
        this.hide();
      });
    }

    /**
     * Sets the close callback
     * @param {Function} callback - Close callback
     */
    setOnClose(callback) {
      this._onClose = callback;
    }

    /**
     * Destroys the UI
     */
    destroy() {
      this._destroyed = true;
      this._removeModal();
      this._licenseManager = null;
      this._featureGate = null;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.LicenseActivationUI = LicenseActivationUI;

})(typeof globalThis !== 'undefined' ? globalThis : this);