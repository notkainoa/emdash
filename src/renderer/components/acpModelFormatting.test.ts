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
      { id: 'opus', label: 'Opus 4.5' },
      { id: 'default', label: 'Sonnet 4.5' },
      { id: 'haiku', label: 'Haiku 4.5' },
    ]);
  });

  it('maps Claude full ids to friendly labels', () => {
    const input = [
      { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
      { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
      { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
    ];

    expect(formatClaudeModelOptionsForUi(input)).toEqual([
      { id: 'claude-opus-4-5', label: 'Opus 4.5' },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ]);
  });

  it('returns empty array when no known models present', () => {
    expect(formatClaudeModelOptionsForUi([{ id: 'unknown', label: '???' }])).toEqual([]);
  });
});
