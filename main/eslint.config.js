const js = require('@eslint/js');
const typescript = require('typescript-eslint');
const oxlintOverlap = require('../tools/eslint/oxlint-overlap.cjs');

const noDesktopBootstrap = {
  patterns: [{
    regex: '^(?:\\.\\./)+index(?:\\.[cm]?[jt]s)?$',
    message: 'Use the core runtime interfaces instead of importing the desktop bootstrap.',
  }],
};

const noWindowGlobal = {
  selector: 'Identifier[name="mainWindow"]',
  message: 'Use the core runtime and event sink instead of a desktop window global.',
};

module.exports = [
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: typescript.parser
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-require-imports': 'warn', // Downgrade to warning
      'no-console': 'off', // Allow console in main process
      'no-useless-escape': 'warn', // Downgrade to warning
      'prefer-const': 'warn', // Downgrade to warning
      'no-empty': 'warn' // Downgrade to warning
    }
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.js', 'src/services/paneChatBundle/']
  },
  {
    files: [
      'src/events.ts',
      'src/ipc/panels.ts',
      'src/daemon/{bootstrap,headless,server}.ts',
      'src/ipc/daemon.ts',
      'src/services/{panelManager,terminalPanelManager,terminalSessionManager,runCommandManager,sessionManager,scriptExecutionTracker,taskQueue,resourceMonitorService}.ts',
      'src/services/panels/cli/AbstractCliManager.ts',
      'src/services/panels/logPanel/logsManager.ts',
    ],
    rules: { 'no-restricted-imports': ['error', noDesktopBootstrap] },
  },
  {
    files: ['src/daemon/server.ts', 'src/ipc/daemon.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        ...noDesktopBootstrap,
        paths: [{ name: 'electron', message: 'Daemon transport uses the core runtime, not Electron.' }],
      }],
      'no-restricted-syntax': ['error', noWindowGlobal],
    },
  },
  {
    files: [
      'src/events.ts',
      'src/services/{panelManager,terminalPanelManager}.ts',
      'src/services/panels/logPanel/logsManager.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', noWindowGlobal, {
        selector: 'CallExpression > MemberExpression.callee[property.name="send"] > MemberExpression.object[property.name="webContents"]',
        message: 'Send renderer events through the core event sink.',
      }],
    },
  },
  {
    files: ['src/preload.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: './daemon/daemonChannels',
          message: 'Import channel ownership from shared/types/daemon so the sandbox bundle stays runtime-safe.',
        }],
      }],
    },
  },
  {
    files: ['src/services/taskQueue.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'MemberExpression[property.name="electron"][object.type="MemberExpression"][object.property.name="versions"][object.object.name="process"]',
        message: 'Select queue behavior through configuration rather than Electron globals.',
      }],
    },
  },
  {
    rules: oxlintOverlap.common
  }
];
