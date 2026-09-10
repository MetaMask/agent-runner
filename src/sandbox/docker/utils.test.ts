import { describe, expect, it } from 'vitest';

import { shouldCloseSandbox } from './utils.js';

describe('shouldCloseSandbox', () => {
  it.each([
    {
      completed: true,
      failed: false,
      succeeded: true,
      aborted: false,
      expected: [true, true, false],
    },
    {
      completed: true,
      failed: false,
      succeeded: false,
      aborted: false,
      expected: [true, false, false],
    },
    {
      completed: false,
      failed: true,
      succeeded: true,
      aborted: false,
      expected: [true, false, false],
    },
    {
      completed: false,
      failed: true,
      succeeded: false,
      aborted: false,
      expected: [true, false, false],
    },
    {
      completed: false,
      failed: false,
      succeeded: false,
      aborted: false,
      expected: [true, true, true],
    },
    {
      completed: false,
      failed: true,
      succeeded: false,
      aborted: true,
      expected: [true, true, true],
    },
    {
      completed: true,
      failed: false,
      succeeded: true,
      aborted: true,
      expected: [true, true, true],
    },
  ])(
    'applies all retention policies to $completed/$failed/$succeeded/$aborted',
    (outcome) => {
      expect(
        (['always', 'on-success', 'never'] as const).map((policy) =>
          shouldCloseSandbox(policy, outcome),
        ),
      ).toStrictEqual(outcome.expected);
    },
  );
});
