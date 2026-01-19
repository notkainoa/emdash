import { describe, expect, it } from 'vitest';

import type { ContentBlock } from '../../renderer/lib/acpChatUtils';

describe('Claude ultrathink prompting', () => {
  const maybeAppendUltrathink = (blocks: ContentBlock[], enabled: boolean): ContentBlock[] => {
    const next = blocks.map((block) => ({ ...block }));
    if (!enabled) return next;
    const lastBlock = next[next.length - 1];
    if (lastBlock && lastBlock.type === 'text' && typeof lastBlock.text === 'string') {
      lastBlock.text = `${lastBlock.text}\n\nULTRATHINK`;
    }
    return next;
  };

  it('appends ULTRATHINK to the last text block', () => {
    const blocks: ContentBlock[] = [
      { type: 'resource_link', uri: 'file://foo', name: 'foo' } as any,
      { type: 'text', text: 'hello' },
    ];

    const updated = maybeAppendUltrathink(blocks, true);
    expect(updated[updated.length - 1].type).toBe('text');
    expect((updated[updated.length - 1] as any).text).toContain('ULTRATHINK');
  });

  it('does nothing when disabled', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }];
    expect(maybeAppendUltrathink(blocks, false)[0]).toEqual(blocks[0]);
  });
});
