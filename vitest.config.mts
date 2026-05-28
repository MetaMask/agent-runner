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
        branches: 95.13,
        functions: 98.28,
        lines: 97.75,
        statements: 97.76,
      },
    },
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});
