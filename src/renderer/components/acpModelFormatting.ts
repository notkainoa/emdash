type ModelOption = {
  id: string;
  label: string;
  description?: string;
};

const normalizeClaudeModelKey = (id: string): string => {
  const cleaned = id.toLowerCase();
  if (cleaned === 'default') return 'default';
  if (cleaned.includes('opus')) return 'opus';
  if (cleaned.includes('sonnet')) return 'sonnet';
  if (cleaned.includes('haiku')) return 'haiku';
  return cleaned;
};

export const formatClaudeModelOptionsForUi = (options: ModelOption[]): ModelOption[] => {
  const byKey = new Map(options.map((opt) => [normalizeClaudeModelKey(opt.id), opt] as const));
  const sonnet = byKey.get('default') ?? byKey.get('sonnet');
  const opus = byKey.get('opus');
  const haiku = byKey.get('haiku');

  const mapped: ModelOption[] = [];
  if (opus) mapped.push({ ...opus, label: 'Claude 4.5 Opus' });
  if (sonnet) mapped.push({ ...sonnet, label: 'Claude 4.5 Sonnet' });
  if (haiku) mapped.push({ ...haiku, label: 'Claude 4.5 Haiku' });

  return mapped;
};
