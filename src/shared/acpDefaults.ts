import { DEFAULT_ACP_MODEL_IDS } from './acpModels';

export type AcpUiMode = 'ask' | 'plan' | 'agent';

export type ThinkingBudgetLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const EFFORT_ORDER: ThinkingBudgetLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export const EFFORT_LABELS: Record<ThinkingBudgetLevel, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
};

export const DEFAULT_THINKING_BUDGET: ThinkingBudgetLevel = 'medium';

export const CODEX_MODEL_BUDGETS: Record<string, ThinkingBudgetLevel[]> = {
  'gpt-5.2-codex': ['minimal', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.2': ['minimal', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.1-codex-mini': ['minimal', 'low', 'medium', 'high'],
};

export const getCodexBudgetLevels = (modelId?: string | null): ThinkingBudgetLevel[] => {
  if (!modelId) return ['low', 'medium', 'high'];
  return CODEX_MODEL_BUDGETS[modelId] ?? ['low', 'medium', 'high'];
};

export interface AcpDefaults {
  claude: {
    mode: AcpUiMode;
    ultrathink: boolean;
    modelId: string;
  };
  codex: {
    mode: AcpUiMode;
    thinkingBudget: ThinkingBudgetLevel;
    modelId: string;
  };
}

export const DEFAULT_ACP_DEFAULTS: AcpDefaults = {
  claude: {
    mode: 'agent',
    ultrathink: false,
    modelId: DEFAULT_ACP_MODEL_IDS.claude,
  },
  codex: {
    mode: 'agent',
    thinkingBudget: DEFAULT_THINKING_BUDGET,
    modelId: DEFAULT_ACP_MODEL_IDS.codex,
  },
};

const ACP_UI_MODES = new Set<AcpUiMode>(['ask', 'plan', 'agent']);

export const isAcpUiMode = (value: unknown): value is AcpUiMode =>
  typeof value === 'string' && ACP_UI_MODES.has(value as AcpUiMode);

export const isThinkingBudgetLevel = (value: unknown): value is ThinkingBudgetLevel =>
  typeof value === 'string' && EFFORT_ORDER.includes(value as ThinkingBudgetLevel);

export const normalizeAcpDefaults = (input?: Partial<AcpDefaults> | null): AcpDefaults => {
  const claudeMode = input?.claude?.mode;
  const codexMode = input?.codex?.mode;
  const claudeUltrathink = input?.claude?.ultrathink;
  const codexBudget = input?.codex?.thinkingBudget;
  const claudeModelId = typeof input?.claude?.modelId === 'string' ? input?.claude?.modelId : '';
  const codexModelId = typeof input?.codex?.modelId === 'string' ? input?.codex?.modelId : '';
  const normalizedClaudeModelId = claudeModelId.trim();
  const normalizedCodexModelId = codexModelId.trim();

  return {
    claude: {
      mode: isAcpUiMode(claudeMode) ? claudeMode : DEFAULT_ACP_DEFAULTS.claude.mode,
      ultrathink:
        typeof claudeUltrathink === 'boolean'
          ? claudeUltrathink
          : DEFAULT_ACP_DEFAULTS.claude.ultrathink,
      modelId: normalizedClaudeModelId || DEFAULT_ACP_DEFAULTS.claude.modelId,
    },
    codex: {
      mode: isAcpUiMode(codexMode) ? codexMode : DEFAULT_ACP_DEFAULTS.codex.mode,
      thinkingBudget: isThinkingBudgetLevel(codexBudget)
        ? codexBudget
        : DEFAULT_ACP_DEFAULTS.codex.thinkingBudget,
      modelId: normalizedCodexModelId || DEFAULT_ACP_DEFAULTS.codex.modelId,
    },
  };
};
