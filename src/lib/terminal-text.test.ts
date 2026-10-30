import { describe, it, expect } from 'vitest';
import { terminalText } from './terminal-text';
describe('extension terminal text', () => {
  it('removes truecolor, OSC links and C1 controls while preserving visible Unicode', () => {
    expect(terminalText('\x1b[38;2;205;154;34m⏸ plan\x1b[39m')).toBe('⏸ plan');
    expect(
      terminalText('\x1b]8;;https://example.com\x1b\\方案\x1b]8;;\x1b\\'),
    ).toBe('方案');
    expect(terminalText('\x9b31m中文\x9b0m\n')).toBe('中文\n');
  });
});
