(function(exports) {
  'use strict';

  function InputToolbar(options) {
    options = options || {};

    this.buttonClass = options.buttonClass || 'md-toolbar-btn';
    this.separatorClass = options.separatorClass || 'md-toolbar-sep';
    this.tabSize = options.tabSize || 2;
    this.textarea = null;
    this.buttons = {};
  }

  InputToolbar.prototype.getButtonConfig = function(type, label) {
    var self = this;

    return {
      type: 'button',
      className: this.buttonClass,
      'data-action': type,
      'aria-label': label,
      title: label,
      onClick: function(event) {
        event.preventDefault();
        event.stopPropagation();
        self.handleButtonClick(type);
      }
    };
  };

  InputToolbar.prototype.getBoldButton = function() {
    return this.getButtonConfig('bold', 'Bold (Ctrl+B)');
  };

  InputToolbar.prototype.getItalicButton = function() {
    return this.getButtonConfig('italic', 'Italic (Ctrl+I)');
  };

  InputToolbar.prototype.getCodeButton = function() {
    return this.getButtonConfig('code', 'Code');
  };

  InputToolbar.prototype.getQuoteButton = function() {
    return this.getButtonConfig('quote', 'Quote');
  };

  InputToolbar.prototype.getStrikethroughButton = function() {
    return this.getButtonConfig('strikethrough', 'Strikethrough');
  };

  InputToolbar.prototype.getAllButtons = function() {
    return [
      this.getBoldButton(),
      this.getItalicButton(),
      this.getCodeButton(),
      this.getQuoteButton(),
      this.getStrikethroughButton()
    ];
  };

  InputToolbar.prototype.getSeparator = function() {
    return {
      type: 'separator',
      className: this.separatorClass
    };
  };

  InputToolbar.prototype.handleButtonClick = function(action) {
    switch (action) {
      case 'bold':
        this.insertBold();
        break;
      case 'italic':
        this.insertItalic();
        break;
      case 'code':
        this.insertCode();
        break;
      case 'quote':
        this.insertQuote();
        break;
      case 'strikethrough':
        this.insertStrikethrough();
        break;
    }
  };

  InputToolbar.prototype.getSelection = function() {
    if (!this.textarea) {
      return { start: 0, end: 0, text: '', selected: false };
    }

    var start = this.textarea.selectionStart;
    var end = this.textarea.selectionEnd;
    var text = this.textarea.value || '';

    return {
      start: start,
      end: end,
      text: text.substring(start, end),
      selected: start !== end
    };
  };

  InputToolbar.prototype.setSelection = function(start, end) {
    if (!this.textarea) {
      return;
    }

    try {
      this.textarea.setSelectionRange(start, end);
      this.textarea.focus();
    } catch (e) {
      if (this.textarea.selectionStart !== undefined) {
        this.textarea.selectionStart = start;
        this.textarea.selectionEnd = end;
        this.textarea.focus();
      }
    }
  };

  InputToolbar.prototype.replaceSelection = function(text) {
    if (!this.textarea) {
      return;
    }

    var start = this.textarea.selectionStart;
    var end = this.textarea.selectionEnd;
    var value = this.textarea.value || '';

    var newValue = value.substring(0, start) + text + value.substring(end);

    this.textarea.value = newValue;

    var newCursorPos = start + text.length;

    try {
      this.textarea.setSelectionRange(newCursorPos, newCursorPos);
    } catch (e) {
      if (this.textarea.selectionStart !== undefined) {
        this.textarea.selectionStart = newCursorPos;
        this.textarea.selectionEnd = newCursorPos;
      }
    }

    this.triggerInputEvent();
  };

  InputToolbar.prototype.wrapSelection = function(prefix, suffix, placeholder) {
    if (!this.textarea) {
      return;
    }

    var selection = this.getSelection();

    if (selection.selected) {
      var wrappedText = prefix + selection.text + suffix;
      this.replaceSelection(wrappedText);
    } else {
      var defaultText = placeholder || '';
      this.replaceSelection(prefix + defaultText + suffix);
      this.setSelection(selection.start + prefix.length, selection.start + prefix.length + defaultText.length);
    }
  };

  InputToolbar.prototype.insertBold = function() {
    this.wrapSelection('**', '**', 'bold text');
  };

  InputToolbar.prototype.insertItalic = function() {
    this.wrapSelection('*', '*', 'italic text');
  };

  InputToolbar.prototype.insertCode = function() {
    var selection = this.getSelection();

    if (selection.selected && selection.text.indexOf('\n') === -1) {
      this.wrapSelection('`', '`', 'code');
    } else if (selection.selected) {
      this.wrapSelection('```\n', '\n```', 'code block');
    } else {
      this.wrapSelection('`', '`', 'code');
    }
  };

  InputToolbar.prototype.insertQuote = function() {
    var selection = this.getSelection();

    if (selection.selected) {
      var lines = selection.text.split('\n');
      var quotedLines = lines.map(function(line) {
        return '> ' + line;
      });
      this.replaceSelection(quotedLines.join('\n'));
    } else {
      this.replaceSelection('> ');
    }
  };

  InputToolbar.prototype.insertStrikethrough = function() {
    this.wrapSelection('~~', '~~', 'strikethrough text');
  };

  InputToolbar.prototype.insertAtLineStart = function(prefix) {
    if (!this.textarea) {
      return;
    }

    var start = this.textarea.selectionStart;
    var value = this.textarea.value || '';

    var lineStart = start;
    while (lineStart > 0 && value.charAt(lineStart - 1) !== '\n') {
      lineStart--;
    }

    var newValue = value.substring(0, lineStart) + prefix + value.substring(lineStart);
    this.textarea.value = newValue;

    var newCursorPos = start + prefix.length;
    this.setSelection(newCursorPos, newCursorPos);
    this.triggerInputEvent();
  };

  InputToolbar.prototype.handleTabKey = function(event) {
    if (!this.textarea) {
      return;
    }

    if (event.shiftKey) {
      return;
    }

    event.preventDefault();

    var start = this.textarea.selectionStart;
    var end = this.textarea.selectionEnd;
    var value = this.textarea.value || '';

    var spaces = '';
    for (var i = 0; i < this.tabSize; i++) {
      spaces += ' ';
    }

    var newValue = value.substring(0, start) + spaces + value.substring(end);
    this.textarea.value = newValue;

    var newCursorPos = start + spaces.length;
    this.setSelection(newCursorPos, newCursorPos);
    this.triggerInputEvent();
  };

  InputToolbar.prototype.handleEnterKey = function(event) {
    if (!this.textarea) {
      return;
    }

    var start = this.textarea.selectionStart;
    var value = this.textarea.value || '';

    var lineStart = start;
    while (lineStart > 0 && value.charAt(lineStart - 1) !== '\n') {
      lineStart--;
    }

    var lineText = value.substring(lineStart, start);
    var match = lineText.match(/^(\s*)([-*+]\s|\d+\.\s|>\s)/);

    if (match && lineText.trim() !== match[0].trim()) {
      event.preventDefault();

      var prefix = match[1] + match[2];
      var newText = '\n' + prefix;

      var newValue = value.substring(0, start) + newText + value.substring(start);
      this.textarea.value = newValue;

      var newCursorPos = start + newText.length;
      this.setSelection(newCursorPos, newCursorPos);
      this.triggerInputEvent();
    }
  };

  InputToolbar.prototype.handleKeyboardShortcuts = function(event) {
    if (!this.textarea) {
      return;
    }

    var isCtrl = event.ctrlKey || event.metaKey;

    if (isCtrl && event.key === 'b') {
      event.preventDefault();
      this.insertBold();
    } else if (isCtrl && event.key === 'i') {
      event.preventDefault();
      this.insertItalic();
    } else if (isCtrl && event.key === '`') {
      event.preventDefault();
      this.insertCode();
    }
  };

  InputToolbar.prototype.triggerInputEvent = function() {
    if (!this.textarea) {
      return;
    }

    if (typeof Event === 'function') {
      var event = new Event('input', {
        bubbles: true,
        cancelable: true
      });
      this.textarea.dispatchEvent(event);
    } else {
      var evt = document.createEvent('Event');
      evt.initEvent('input', true, true);
      this.textarea.dispatchEvent(evt);
    }
  };

  InputToolbar.prototype.bindToInput = function(inputElement) {
    if (!inputElement) {
      throw new Error('Input element is required');
    }

    if (inputElement.tagName !== 'TEXTAREA' && inputElement.tagName !== 'INPUT' &&
        inputElement.type !== 'text' && inputElement.type !== 'search') {
      throw new Error('Input element must be a textarea or text input');
    }

    this.textarea = inputElement;

    var self = this;

    inputElement.addEventListener('keydown', function(event) {
      if (event.key === 'Tab') {
        self.handleTabKey(event);
      } else if (event.key === 'Enter') {
        self.handleEnterKey(event);
      } else {
        self.handleKeyboardShortcuts(event);
      }
    });

    return this;
  };

  InputToolbar.prototype.unbind = function() {
    if (this.textarea) {
      this.textarea = null;
    }
    return this;
  };

  InputToolbar.prototype.createToolbarElement = function(container) {
    var self = this;

    if (typeof container === 'string') {
      container = document.querySelector(container);
    }

    if (!container) {
      return null;
    }

    var buttonLabels = [
      { action: 'bold', icon: 'B', label: 'Bold' },
      { action: 'italic', icon: 'I', label: 'Italic' },
      { action: 'code', icon: '<>', label: 'Code' },
      { action: 'quote', icon: '"', label: 'Quote' },
      { action: 'strikethrough', icon: 'S', label: 'Strikethrough' }
    ];

    buttonLabels.forEach(function(btn) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = self.buttonClass;
      button.setAttribute('data-action', btn.action);
      button.setAttribute('title', btn.label);
      button.setAttribute('aria-label', btn.label);
      button.textContent = btn.icon;

      button.addEventListener('click', function(event) {
        event.preventDefault();
        self.handleButtonClick(btn.action);
      });

      container.appendChild(button);
    });

    return container;
  };

  InputToolbar.VERSION = '1.0.0';

  exports.InputToolbar = InputToolbar;

})(typeof globalThis !== 'undefined' ? globalThis : this);