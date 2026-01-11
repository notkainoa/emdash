import { describe, expect, it } from 'vitest';

import { formatClaudeModelOptionsForUi } from './acpModelFormatting';

describe('formatClaudeModelOptionsForUi', () => {
  it('maps and filters Claude ACP models', () => {
    const input = [
      { id: 'default', label: 'default' },
      { id: 'opus', label: 'opus' },
      { id: 'haiku', label: 'haiku' },
      { id: 'sonnet', label: 'sonnet' },
    ];

    expect(formatClaudeModelOptionsForUi(input)).toEqual([
      { id: 'opus', label: 'Claude 4.5 Opus' },
      { id: 'default', label: 'Claude 4.5 Sonnet' },
      { id: 'haiku', label: 'Claude 4.5 Haiku' },
    ]);
  });

  it('returns empty array when no known models present', () => {
    expect(formatClaudeModelOptionsForUi([{ id: 'unknown', label: '???' }])).toEqual([]);
  });
});
