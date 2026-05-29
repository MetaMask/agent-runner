import base, { createConfig } from '@metamask/eslint-config';
import nodejs from '@metamask/eslint-config-nodejs';
import typescript from '@metamask/eslint-config-typescript';
import vitest from '@metamask/eslint-config-vitest';

const config = createConfig([
  {
    ignores: ['dist/', 'docs/', '.yarn/'],
  },

  {
    extends: base,

    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },

    settings: {
      'import-x/extensions': ['.js', '.mjs'],
    },
  },

  {
    rules: {
      // Handled by Oxfmt.
      'prettier/prettier': 'off',
      'import-x/order': 'off',
    },
  },

  {
    files: ['**/*.ts'],
    extends: typescript,
  },

  {
    files: ['**/*.js', '**/*.cjs'],
    extends: nodejs,

    languageOptions: {
      sourceType: 'script',
    },
  },

  // Source files that intentionally rely on Node.js APIs (process, node:*
  // imports, child_process, etc.). The Claude SDK adapter and the Docker
  // sandbox modules all run host-side and need the nodejs eslint extends so
  // they can call into the platform without per-line disables.
  {
    files: ['src/adapters/claude-adapter.ts', 'src/sandbox/**/*.ts'],
    ignores: ['**/*.test.ts'],
    extends: nodejs,
    rules: {
      // The cleanup registry and bridge intentionally read process state,
      // touch process env, and call process.exit during signal handling.
      'n/no-process-env': 'off',
      'n/no-process-exit': 'off',
      // The default command runner uses spawnSync for synchronous
      // shutdown handlers that must run before the host process exits.
      'n/no-sync': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.js'],
    extends: [vitest, nodejs],
    rules: {
      'jsdoc/require-jsdoc': 'off',
    },
  },

  // Sandbox test files exercise Node.js APIs (process.env, realpathSync,
  // spawnSync) to set up host-side fixtures, and the test helpers use a
  // large number of inline runner/handle stubs whose return types are
  // already pinned by the parameter types of the function under test.
  // Relaxing the JSDoc/return-type rules here keeps the test code readable
  // without litering it with redundant annotations on stub callbacks.
  {
    files: ['src/sandbox/**/*.test.ts'],
    rules: {
      'n/no-process-env': 'off',
      'n/no-sync': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-param-description': 'off',
    },
  },
]);

export default config;
