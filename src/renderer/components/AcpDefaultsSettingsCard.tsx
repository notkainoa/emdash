import React, { useEffect, useMemo, useState } from 'react';
import { Brain, Infinity, Map as MapIcon, MessageSquare } from 'lucide-react';
import {
  DEFAULT_ACP_DEFAULTS,
  EFFORT_LABELS,
  EFFORT_ORDER,
  normalizeAcpDefaults,
  type AcpDefaults,
  type AcpUiMode,
  type ThinkingBudgetLevel,
} from '@shared/acpDefaults';
import { ACP_PROVIDER_MODELS } from '@shared/acpModels';
import claudeLogo from '../../assets/images/claude.png';
import OpenAIIcon from './OpenAIIcon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

const nextBudgetLevel = (current: ThinkingBudgetLevel): ThinkingBudgetLevel => {
  const idx = EFFORT_ORDER.indexOf(current);
  const nextIndex = idx < 0 ? 0 : (idx + 1) % EFFORT_ORDER.length;
  return EFFORT_ORDER[nextIndex] ?? EFFORT_ORDER[0];
};

const AcpDefaultsSettingsCard: React.FC = () => {
  const [defaults, setDefaults] = useState<AcpDefaults>(DEFAULT_ACP_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.getSettings();
        if (cancelled) return;
        if (result?.success) {
          setDefaults(normalizeAcpDefaults(result.settings?.acp?.defaults));
        } else {
          setError(result?.error || 'Failed to load settings.');
          setDefaults(DEFAULT_ACP_DEFAULTS);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load settings.';
          setError(message);
          setDefaults(DEFAULT_ACP_DEFAULTS);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateDefaults = async (next: AcpDefaults, payload: Partial<AcpDefaults>) => {
    const previous = defaults;
    setDefaults(next);
    setError(null);
    setSaving(true);
    try {
      const result = await window.electronAPI.updateSettings({
        acp: { defaults: payload },
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to update settings.');
      }
      setDefaults(normalizeAcpDefaults(result.settings?.acp?.defaults));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update settings.';
      setDefaults(previous);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const updateMode = (provider: 'claude' | 'codex', mode: AcpUiMode) => {
    if (loading || saving) return;
    const next: AcpDefaults = {
      ...defaults,
      [provider]: {
        ...defaults[provider],
        mode,
      },
    };
    updateDefaults(next, { [provider]: { mode } } as Partial<AcpDefaults>);
  };

  const toggleUltrathink = () => {
    if (loading || saving) return;
    const nextValue = !defaults.claude.ultrathink;
    const next: AcpDefaults = {
      ...defaults,
      claude: {
        ...defaults.claude,
        ultrathink: nextValue,
      },
    };
    updateDefaults(next, { claude: { ultrathink: nextValue } } as Partial<AcpDefaults>);
  };

  const cycleCodexBudget = () => {
    if (loading || saving) return;
    const nextValue = nextBudgetLevel(defaults.codex.thinkingBudget);
    const next: AcpDefaults = {
      ...defaults,
      codex: {
        ...defaults.codex,
        thinkingBudget: nextValue,
      },
    };
    updateDefaults(next, { codex: { thinkingBudget: nextValue } } as Partial<AcpDefaults>);
  };

  const codexBudgetLabel = EFFORT_LABELS[defaults.codex.thinkingBudget];
  const dotCount = EFFORT_ORDER.length;
  const activeBudgetIndex = Math.max(0, EFFORT_ORDER.indexOf(defaults.codex.thinkingBudget));
  const dotSize = dotCount >= 4 ? 3 : 4;
  const dotGap = dotCount >= 4 ? 2 : 3;
  const disabled = loading || saving;

  const modeOptions = useMemo(
    () => [
      { value: 'ask' as AcpUiMode, label: 'Ask', icon: MessageSquare },
      { value: 'plan' as AcpUiMode, label: 'Plan', icon: MapIcon },
      { value: 'agent' as AcpUiMode, label: 'Agent', icon: Infinity },
    ],
    []
  );

  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground/80">
        Defaults apply to new ACP sessions.
      </div>

      <div className="rounded-lg border border-border/60 bg-background/60 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium">Claude Code</div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={defaults.claude.mode}
              onValueChange={(value) => updateMode('claude', value as AcpUiMode)}
            >
              <SelectTrigger
                disabled={disabled}
                aria-label="Default mode for Claude Code"
                className="h-8 w-auto gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 text-xs font-medium text-foreground shadow-sm"
              >
                <SelectValue placeholder="Mode" />
              </SelectTrigger>
              <SelectContent className="z-[140]">
                  {modeOptions.map(({ value, label, icon: Icon }) => (
                    <SelectItem key={value} value={value}>
                      <span className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                      </span>
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            <Select
              value={defaults.claude.modelId}
              onValueChange={(value) =>
                updateDefaults(
                  { ...defaults, claude: { ...defaults.claude, modelId: value } },
                  { claude: { modelId: value } }
                )
              }
            >
              <SelectTrigger
                disabled={disabled}
                aria-label="Default model for Claude Code"
                className="h-8 w-auto gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 text-xs font-medium text-foreground shadow-sm"
              >
                <img src={claudeLogo} alt="Claude" className="h-3.5 w-3.5 shrink-0" />
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent className="z-[140]">
                {ACP_PROVIDER_MODELS.claude.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <button
              type="button"
              onClick={toggleUltrathink}
              title={
                defaults.claude.ultrathink
                  ? 'Ultrathink enabled (appends ULTRATHINK)'
                  : 'Enable Ultrathink (appends ULTRATHINK)'
              }
              aria-label={
                defaults.claude.ultrathink ? 'Ultrathink enabled' : 'Ultrathink disabled'
              }
              aria-pressed={defaults.claude.ultrathink}
              disabled={disabled}
              className={`flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                defaults.claude.ultrathink
                  ? 'bg-violet-100/70 text-violet-700 ring-1 ring-violet-500/30 hover:bg-violet-100/90 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/20'
                  : 'bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
              }`}
            >
              <Brain className={`h-4 w-4 ${defaults.claude.ultrathink ? '' : 'opacity-70'}`} />
              <span
                className={`text-xs font-medium ${
                  defaults.claude.ultrathink ? '' : 'text-muted-foreground'
                }`}
              >
                Ultrathink
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-background/60 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium">Codex</div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={defaults.codex.mode}
              onValueChange={(value) => updateMode('codex', value as AcpUiMode)}
            >
              <SelectTrigger
                disabled={disabled}
                aria-label="Default mode for Codex"
                className="h-8 w-auto gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 text-xs font-medium text-foreground shadow-sm"
              >
                <SelectValue placeholder="Mode" />
              </SelectTrigger>
              <SelectContent className="z-[140]">
                {modeOptions.map(({ value, label, icon: Icon }) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={defaults.codex.modelId}
              onValueChange={(value) =>
                updateDefaults(
                  { ...defaults, codex: { ...defaults.codex, modelId: value } },
                  { codex: { modelId: value } }
                )
              }
            >
              <SelectTrigger
                disabled={disabled}
                aria-label="Default model for Codex"
                className="h-8 w-auto gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 text-xs font-medium text-foreground shadow-sm"
              >
                <OpenAIIcon className="h-3.5 w-3.5 shrink-0" />
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent className="z-[140]">
                {ACP_PROVIDER_MODELS.codex.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <button
              type="button"
              onClick={cycleCodexBudget}
              title={`Thinking budget: ${codexBudgetLabel}`}
              aria-label={`Thinking budget: ${codexBudgetLabel}`}
              disabled={disabled}
              className="flex h-8 items-center gap-2 rounded-md bg-violet-100/70 px-2 text-xs font-medium text-violet-700 transition hover:bg-violet-100/90 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-violet-500/10 dark:text-violet-200 dark:hover:bg-violet-500/15"
            >
              <Brain className="h-4 w-4" />
              <span
                className="flex flex-col-reverse items-center justify-center"
                style={{ gap: `${dotGap}px` }}
                aria-hidden="true"
              >
                {Array.from({ length: dotCount }).map((_, idx) => (
                  <span
                    key={`thinking-dot-${idx}`}
                    style={{ width: `${dotSize}px`, height: `${dotSize}px` }}
                    className={`rounded-full ${
                      idx <= activeBudgetIndex ? 'bg-current' : 'bg-muted-foreground/30'
                    }`}
                  />
                ))}
              </span>
              <span className="text-xs font-medium">{codexBudgetLabel}</span>
            </button>
          </div>
        </div>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
};

export default AcpDefaultsSettingsCard;
