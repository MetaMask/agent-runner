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
        branches: 95.3,
        functions: 98.31,
        lines: 98.18,
        statements: 98.19,
      },
    },
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});
