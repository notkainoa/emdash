type ModelOption = {
  id: string;
  label: string;
  description?: string;
};

export const formatClaudeModelOptionsForUi = (options: ModelOption[]): ModelOption[] => {
  const byId = new Map(options.map((opt) => [opt.id, opt] as const));
  const sonnet = byId.get('default');
  const opus = byId.get('opus');
  const haiku = byId.get('haiku');

  const mapped: ModelOption[] = [];
  if (opus) mapped.push({ ...opus, label: 'Claude 4.5 Opus' });
  if (sonnet) mapped.push({ ...sonnet, label: 'Claude 4.5 Sonnet' });
  if (haiku) mapped.push({ ...haiku, label: 'Claude 4.5 Haiku' });

  return mapped;
};
