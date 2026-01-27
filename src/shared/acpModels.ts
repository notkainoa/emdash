export type AcpProviderId = 'claude' | 'codex';

export type AcpModelOption = {
  id: string;
  label: string;
  description?: string;
};

export const ACP_PROVIDER_MODELS: Record<AcpProviderId, AcpModelOption[]> = {
  codex: [
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
    { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  ],
  claude: [
    { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
};

export const DEFAULT_ACP_MODEL_IDS: Record<AcpProviderId, string> = {
  claude: 'claude-sonnet-4-5-20250929',
  codex: 'gpt-5.2-codex',
};
