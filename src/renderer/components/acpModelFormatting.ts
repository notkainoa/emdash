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
  if (opus) mapped.push({ ...opus, label: 'Opus 4.5' });
  if (sonnet) mapped.push({ ...sonnet, label: 'Sonnet 4.5' });
  if (haiku) mapped.push({ ...haiku, label: 'Haiku 4.5' });

  return mapped;
};
