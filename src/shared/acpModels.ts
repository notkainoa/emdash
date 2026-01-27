export type AcpProviderId = 'claude' | 'codex';

export type AcpModelOption = {
  id: string;
  label: string;
  description?: string;
};

export const ACP_PROVIDER_MODELS: Record<AcpProviderId, AcpModelOption[]> = {
  codex: [
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ],
  claude: [
    { id: 'claude-opus-4-5', label: 'Opus 4.5' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  ],
};

export const DEFAULT_ACP_MODEL_IDS: Record<AcpProviderId, string> = {
  claude: 'claude-sonnet-4-5',
  codex: 'gpt-5.2-codex',
};
