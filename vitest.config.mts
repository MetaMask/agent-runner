import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    include: ['src/**/*.test.ts'],
    coverage: {
      enabled: true,
      provider: 'istanbul',
      include: [
        'src/**/*.ts',
        'src/**/*.tsx',
        'src/**/*.js',
        'src/**/*.jsx',
        'src/**/*.mjs',
      ],
      exclude: ['src/**/*.test-d.ts'],
      thresholds: {
        autoUpdate: true,
        branches: 89.41,
        functions: 100,
        lines: 95.53,
        statements: 95.53,
      },
    },
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});
