import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clipboard,
  Copy,
  FileText,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { getMentionKeyAction } from '../lib/fileMentions';
import claudeLogo from '../../assets/images/claude.png';
import { useFileMentions } from '../hooks/useFileMentions';
import FileMentionDropdown from './FileMentionDropdown';
import { Task } from '../types/chat';
import { type Provider } from '../types';
import InstallBanner from './InstallBanner';
import { Button } from './ui/button';
import { getInstallCommandForProvider } from '@shared/providers/registry';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';

// OpenAI logo SVG component
const OpenAIIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

import { AnimatePresence, motion } from 'motion/react';
import { Badge } from './ui/badge';
import { cn } from '@/lib/utils';
import { useAcpSession } from '@/lib/acpSessions';
import { formatClaudeModelOptionsForUi } from './acpModelFormatting';
import {
  type ContentBlock,
  type DiffPreview,
  type FeedItem,
  type PermissionRequest,
  type ToolCall,
  buildDiffPreview,
  getTailLines,
  splitLines,
  truncateText,
} from '@/lib/acpChatUtils';
import type { AcpConfigOption } from '@shared/types/acp';
import { logPlanEvent } from '@/lib/planLogs';

type Attachment = {
  id: string;
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
  kind: 'file' | 'image' | 'audio';
  data?: string;
  textContent?: string;
};

type Props = {
  task: Task;
  projectName: string;
  className?: string;
  provider: Provider;
  isProviderInstalled: boolean | null;
  runInstallCommand: (cmd: string) => void;
  planModeEnabled: boolean;
  setPlanModeEnabled: (next: boolean | ((prev: boolean) => boolean)) => void;
};

const SESSION_ERROR_PREVIEW_LIMIT = 360;
const SESSION_ERROR_PREVIEW_LINES = 4;
/** Unique ID for tracking copy button state in the session error banner */
const SESSION_ERROR_COPY_ID = 'acp-session-error';
const SCROLL_BOTTOM_THRESHOLD = 80;

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n');

const pluralize = (value: number, noun: string) =>
  value === 1 ? `${value} ${noun}` : `${value} ${noun}s`;

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const buildSessionErrorPreview = (text: string) => {
  const normalized = normalizeNewlines(text).trim();
  if (!normalized) return '';
  const lines = normalized.split('\n');
  const clippedLines = lines.slice(0, SESSION_ERROR_PREVIEW_LINES);
  let preview = clippedLines.join('\n');
  const truncatedLines = lines.length > SESSION_ERROR_PREVIEW_LINES;
  preview = truncateText(preview, SESSION_ERROR_PREVIEW_LIMIT);
  if (truncatedLines && !preview.endsWith('...')) {
    preview = `${preview}...`;
  }
  return preview;
};

const formatDuration = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const readLocalStorage = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeLocalStorage = (key: string, value: string | null | undefined) => {
  if (!value) return;
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    console.error(`Failed to write to localStorage for key "${key}":`, error);
  }
};

const LoadingTimer: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 text-xs text-muted-foreground">
    <Spinner size="sm" className="text-muted-foreground/70" aria-hidden="true" />
    <span className="tabular-nums">{label}</span>
  </div>
);

const statusStyles: Record<string, string> = {
  pending: 'text-amber-700 bg-amber-50 border-amber-200',
  in_progress: 'text-blue-700 bg-blue-50 border-blue-200',
  completed: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  failed: 'text-red-700 bg-red-50 border-red-200',
  cancelled: 'text-gray-600 bg-gray-100 border-gray-200',
};

type ConfigChoice = {
  value: unknown;
  label?: string;
  name?: string;
  description?: string;
};

type ModelOption = {
  id: string;
  label: string;
  description?: string;
};

// Static models for instant loading (no waiting for IPC)
const PROVIDER_MODELS: Record<string, ModelOption[]> = {
  codex: [
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ],
  claude: [
    { id: 'claude-opus-4-5', label: 'Claude 4.5 Opus' },
    { id: 'claude-sonnet-4-5', label: 'Claude 4.5 Sonnet' },
  ],
};

type ModelVariant = ModelOption & {
  baseId: string;
  effort?: string | null;
};

type ThinkingBudgetLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const EFFORT_ORDER: ThinkingBudgetLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const EFFORT_LABELS: Record<ThinkingBudgetLevel, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
};
const DEFAULT_THINKING_BUDGET: ThinkingBudgetLevel = 'medium';
const isThinkingBudgetLevel = (value: string): value is ThinkingBudgetLevel =>
  EFFORT_ORDER.includes(value as ThinkingBudgetLevel);

const flattenConfigChoices = (choices: any[]): any[] => {
  const flat: any[] = [];
  for (const choice of choices) {
    if (choice && Array.isArray(choice.options)) {
      flat.push(...choice.options);
    } else {
      flat.push(choice);
    }
  }
  return flat;
};

const normalizeConfigChoice = (choice: any): ConfigChoice | null => {
  if (choice === null || choice === undefined) return null;
  if (typeof choice === 'string' || typeof choice === 'number' || typeof choice === 'boolean') {
    return { value: choice, label: String(choice) };
  }
  if (typeof choice === 'object') {
    const value =
      choice.value ?? choice.id ?? choice.key ?? choice.name ?? choice.label ?? choice.option;
    return {
      value,
      label: choice.label ?? choice.name ?? (value !== undefined ? String(value) : undefined),
      name: choice.name,
      description: choice.description,
    };
  }
  return null;
};

const extractConfigChoices = (option?: AcpConfigOption | null): ConfigChoice[] => {
  if (!option) return [];
  const raw =
    (Array.isArray(option.options) && option.options) ||
    (Array.isArray(option.possibleValues) && option.possibleValues) ||
    (Array.isArray(option.values) && option.values) ||
    (Array.isArray(option.allowedValues) && option.allowedValues) ||
    [];
  const flat = flattenConfigChoices(raw);
  return flat.map(normalizeConfigChoice).filter(Boolean) as ConfigChoice[];
};

const getConfigOptionId = (option?: AcpConfigOption | null): string | null => {
  if (!option) return null;
  const id =
    option.id ??
    (option as any).configId ??
    (option as any).config_id ??
    (option as any).key ??
    option.name;
  return id ? String(id) : null;
};

const getConfigOptionValue = (option?: AcpConfigOption | null): unknown => {
  if (!option) return null;
  return (
    option.currentValue ??
    option.current_value ??
    option.value ??
    option.selectedValue ??
    (option as any).selected ??
    null
  );
};

const normalizeBudgetText = (value: unknown) => String(value ?? '').toLowerCase();

const normalizeEffort = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).toLowerCase().replace(/\s+/g, '').replace(/[_-]/g, '');
  if (!cleaned) return null;
  if (['xhigh', 'extrahigh', 'xtra', 'xtrahigh'].includes(cleaned)) return 'xhigh';
  if (['high'].includes(cleaned)) return 'high';
  if (['medium', 'med'].includes(cleaned)) return 'medium';
  if (['low'].includes(cleaned)) return 'low';
  if (['minimal', 'min', 'none', 'off', 'disabled'].includes(cleaned)) return 'minimal';
  return null;
};

const parseEffortFromLabel = (label?: string | null): string | null => {
  if (!label) return null;
  const match = label.match(/\(([^)]+)\)\s*$/);
  if (!match) return null;
  return normalizeEffort(match[1]);
};

const stripEffortSuffix = (label?: string | null): string | null => {
  if (!label) return null;
  const effort = parseEffortFromLabel(label);
  if (!effort) return label;
  return label.replace(/\s*\([^)]+\)\s*$/, '').trim();
};

const formatModelLabel = (label: string): string => {
  const parts = label.split(/[-\s]+/).filter(Boolean);
  if (!parts.length) return label;
  const formatted = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === 'gpt') return 'GPT';
    if (lower === 'codex') return 'Codex';
    if (lower === 'mini') return 'Mini';
    if (lower === 'max') return 'Max';
    if (/^\d+(\.\d+)?$/.test(part)) return part;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  return formatted.join('-');
};

const splitModelId = (modelId?: string | null, label?: string | null) => {
  if (!modelId) {
    return {
      baseId: '',
      effort: parseEffortFromLabel(label),
    };
  }
  if (modelId.includes('/')) {
    const parts = modelId.split('/');
    const tail = parts[parts.length - 1];
    const effort = normalizeEffort(tail);
    if (effort) {
      return {
        baseId: parts.slice(0, -1).join('/'),
        effort,
      };
    }
  }
  return {
    baseId: modelId,
    effort: parseEffortFromLabel(label),
  };
};

const detectBudgetLevel = (text: string): ThinkingBudgetLevel | null => {
  if (/\bminimal\b/.test(text) || /\b(none|off|disabled|disable|zero)\b/.test(text))
    return 'minimal';
  if (/\blow\b/.test(text) || text === '1') return 'low';
  if (/\bmedium\b/.test(text) || text === '2') return 'medium';
  if (/\b(xhigh|extra\s*high)\b/.test(text) || text === '4') return 'xhigh';
  if (/\bhigh\b/.test(text) || text === '3') return 'high';
  return null;
};

const budgetFromEffort = (effort?: string | null): ThinkingBudgetLevel | null => {
  const normalized = normalizeEffort(effort);
  if (!normalized) return null;
  if (
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }
  return null;
};

const chooseEffortForBudget = (
  budget: ThinkingBudgetLevel,
  available: Set<string>
): ThinkingBudgetLevel | null => {
  const normalizedAvailable = new Set(
    Array.from(available)
      .map((entry) => normalizeEffort(entry))
      .filter(Boolean) as ThinkingBudgetLevel[]
  );
  if (normalizedAvailable.has(budget)) return budget;
  const idx = EFFORT_ORDER.indexOf(budget);
  for (let i = idx; i >= 0; i -= 1) {
    const level = EFFORT_ORDER[i];
    if (normalizedAvailable.has(level)) return level;
  }
  for (let i = idx + 1; i < EFFORT_ORDER.length; i += 1) {
    const level = EFFORT_ORDER[i];
    if (normalizedAvailable.has(level)) return level;
  }
  return null;
};

const buildBudgetMapping = (option?: AcpConfigOption | null) => {
  const choices = extractConfigChoices(option);
  const budgetToChoice = new Map<ThinkingBudgetLevel, ConfigChoice>();
  const valueToBudget = new Map<string, ThinkingBudgetLevel>();
  const availableLevels = new Set<ThinkingBudgetLevel>();
  for (const choice of choices) {
    const label = normalizeBudgetText(
      [choice.label, choice.name, choice.value, choice.description].filter(Boolean).join(' ')
    );
    const level = detectBudgetLevel(label);
    if (level && !budgetToChoice.has(level)) {
      budgetToChoice.set(level, choice);
    }
    if (level && choice.value !== undefined) {
      valueToBudget.set(String(choice.value), level);
    }
    if (level) {
      availableLevels.add(level);
    }
  }
  return { choices, budgetToChoice, valueToBudget, availableLevels };
};

const getBudgetFromConfig = (option?: AcpConfigOption | null): ThinkingBudgetLevel | null => {
  if (!option) return null;
  const currentValue = getConfigOptionValue(option);
  if (currentValue === null || currentValue === undefined) return null;
  const { valueToBudget } = buildBudgetMapping(option);
  const direct = valueToBudget.get(String(currentValue));
  if (direct) return direct;
  const inferred = detectBudgetLevel(normalizeBudgetText(currentValue));
  return inferred;
};

const findThinkingConfigOption = (options: AcpConfigOption[]): AcpConfigOption | null => {
  let best: { option: AcpConfigOption; score: number } | null = null;
  for (const option of options) {
    const haystack = normalizeBudgetText(
      [option.id, option.name, option.label, option.description].filter(Boolean).join(' ')
    );
    if (!/(reason|thinking|effort|budget)/.test(haystack)) continue;
    const { choices } = buildBudgetMapping(option);
    const hasChoices = choices.length > 0;
    const hasKnownLevels = choices.some((choice) =>
      Boolean(detectBudgetLevel(normalizeBudgetText(choice.label ?? choice.name ?? choice.value)))
    );
    let score = 0;
    if (option.type === 'select' || option.type === 'enum') score += 2;
    if (hasChoices) score += 2;
    if (hasKnownLevels) score += 2;
    if (/(reason|thinking)/.test(haystack)) score += 1;
    if (!best || score > best.score) best = { option, score };
  }
  return best?.option ?? null;
};

const findModelConfigOption = (options: AcpConfigOption[]): AcpConfigOption | null => {
  let best: { option: AcpConfigOption; score: number } | null = null;
  for (const option of options) {
    const haystack = normalizeBudgetText(
      [option.id, option.name, option.label, option.description].filter(Boolean).join(' ')
    );
    if (!/model/.test(haystack)) continue;
    if (/(reason|thinking|effort|budget)/.test(haystack)) continue;
    const choices = extractConfigChoices(option);
    const hasChoices = choices.length > 0;
    let score = 0;
    if (option.type === 'select' || option.type === 'enum') score += 2;
    if (hasChoices) score += 2;
    if (/(model)/.test(haystack)) score += 1;
    if (!best || score > best.score) best = { option, score };
  }
  return best?.option ?? null;
};

const normalizeModelOption = (model: any): ModelOption | null => {
  if (!model) return null;
  if (typeof model === 'string') {
    return { id: model, label: model };
  }
  if (typeof model === 'object') {
    const id =
      model.id ??
      model.modelId ??
      model.model_id ??
      model.model ??
      model.name ??
      model.value ??
      model.slug ??
      model.key;
    if (!id) return null;
    const label =
      model.displayName ?? model.label ?? model.title ?? model.name ?? model.modelId ?? String(id);
    return {
      id: String(id),
      label: String(label),
      description: model.description ? String(model.description) : undefined,
    };
  }
  return null;
};

const nextBudgetLevel = (
  current: ThinkingBudgetLevel,
  levels: ThinkingBudgetLevel[]
): ThinkingBudgetLevel => {
  if (!levels.length) return current;
  const idx = levels.indexOf(current);
  const next = levels[(idx + 1) % levels.length];
  return next ?? levels[0] ?? current;
};

const AcpChatInterface: React.FC<Props> = ({
  task,
  projectName: _projectName,
  className,
  provider,
  isProviderInstalled,
  runInstallCommand,
  planModeEnabled,
  setPlanModeEnabled,
}) => {
  const uiLog = useCallback((...args: any[]) => {
    // eslint-disable-next-line no-console
    console.log('[acp-ui]', ...args);
  }, []);
  const planBannerStorageKey = useMemo(
    () => `acp:plan-banner-dismissed:conv-${task.id}-acp`,
    [task.id]
  );
  const { state: sessionState, actions: sessionActions } = useAcpSession(task.id, provider);
  const {
    sessionId,
    sessionError,
    sessionStarting,
    isRunning,
    feed,
    toolCalls,
    permissions,
    terminalOutputs,
    plan,
    promptCaps,
    configOptions,
    models,
    currentModelId,
    historyReady,
    historyHasMessages,
    runStartedAt,
    runElapsedMs: storedRunElapsedMs,
  } = sessionState;
  const [commands, setCommands] = useState<
    Array<{ name: string; description?: string; hint?: string }>
  >([]);
  const [input, setInput] = useState('');
  const [showPlan, setShowPlan] = useState(true);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [modelId, setModelId] = useState<string>(
    provider === 'claude' ? 'claude-opus-4-5' : 'gpt-5.2-codex'
  );
  const [planModePromptSent, setPlanModePromptSent] = useState(false);
  const [lastUserPlanModeSent, setLastUserPlanModeSent] = useState(false);
  const [planBannerDismissed, setPlanBannerDismissed] = useState(() => {
    const stored = readLocalStorage(planBannerStorageKey);
    return stored === '1';
  });
  const [thinkingBudget, setThinkingBudget] =
    useState<ThinkingBudgetLevel>(DEFAULT_THINKING_BUDGET);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyResetRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const persistedModelRef = useRef<string | null>(null);
  const persistedThinkingBudgetRef = useRef<ThinkingBudgetLevel | null>(null);
  const didRestorePreferencesRef = useRef<string | null>(null);
  const hasMessagesRef = useRef(false);
  const isPinnedToBottomRef = useRef(true);
  const lastFeedLengthRef = useRef(0);
  const forceScrollRef = useRef(false);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);

  const acpConversationId = useMemo(() => `conv-${task.id}-acp`, [task.id]);
  const modelStorageKey = useMemo(() => `acp:model:${acpConversationId}`, [acpConversationId]);
  const thinkingStorageKey = useMemo(
    () => `acp:thinking:${acpConversationId}`,
    [acpConversationId]
  );

  useEffect(() => {
    setExpandedItems({});
    setUnseenCount(0);
    setIsPinnedToBottom(true);
    lastFeedLengthRef.current = 0;
    isPinnedToBottomRef.current = true;
    forceScrollRef.current = false;
  }, [task.id, provider]);

  // Track cursor position for mention detection
  const [cursorPosition, setCursorPosition] = useState(0);

  // Calculate caret coordinates for dropdown positioning
  const getCaretCoordinates = useCallback(
    (textarea: HTMLTextAreaElement, position: number): DOMRect | null => {
      const { offsetLeft, offsetTop } = textarea;
      const div = document.createElement('div');
      const style = getComputedStyle(textarea);

      div.textContent = textarea.value.substring(0, position);
      Object.assign(div.style, {
        position: 'absolute',
        visibility: 'hidden',
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        top: '0px',
        left: '0px',
        font: style.font,
        padding: style.padding,
        border: style.border,
        width: style.width,
        height: style.height,
      });

      let coordinates: DOMRect | null = null;
      try {
        document.body.appendChild(div);
        const span = document.createElement('span');
        span.textContent = textarea.value.substring(position) || '.';
        div.appendChild(span);

        coordinates = new DOMRect(
          span.offsetLeft + offsetLeft,
          span.offsetTop + offsetTop + parseInt(style.lineHeight || '0'),
          0,
          parseInt(style.lineHeight || '0')
        );
      } finally {
        document.body.removeChild(div);
      }
      return coordinates;
    },
    []
  );

  const [caretPosition, setCaretPosition] = useState<DOMRect | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
    if (!isPinnedToBottomRef.current) {
      isPinnedToBottomRef.current = true;
      setIsPinnedToBottom(true);
    }
  }, []);

  const updatePinnedState = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    const nearBottom = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD;
    if (nearBottom !== isPinnedToBottomRef.current) {
      isPinnedToBottomRef.current = nearBottom;
      setIsPinnedToBottom(nearBottom);
    }
    if (nearBottom) {
      setUnseenCount(0);
    }
  }, []);

  // File mention autocomplete
  const handleMentionSelect = useCallback(
    (filePath: string, startIndex: number, endIndex: number) => {
      // Insert the mention at the cursor position
      const before = input.slice(0, startIndex);
      const after = input.slice(endIndex);
      const mention = `@${filePath}`;
      const needsTrailingSpace =
        !filePath.endsWith('/') && (after.length === 0 || !/^\s/.test(after));
      const suffix = needsTrailingSpace ? ' ' : '';
      setInput(before + mention + suffix + after);

      // Move cursor to after the inserted mention
      setTimeout(() => {
        const newCursorPos = startIndex + mention.length + suffix.length;
        textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
        setCursorPosition(newCursorPos);
        textareaRef.current?.focus();
      }, 0);
    },
    [input]
  );

  const fileMentions = useFileMentions({
    input,
    cursorPosition,
    rootPath: task.path,
    onSelect: handleMentionSelect,
  });

  // Update caret position when mention is active
  useEffect(() => {
    if (fileMentions.active && textareaRef.current) {
      const coords = getCaretCoordinates(textareaRef.current, cursorPosition);
      setCaretPosition(coords);
    } else {
      setCaretPosition(null);
    }
  }, [fileMentions.active, fileMentions.query, cursorPosition, getCaretCoordinates]);

  // Handle dropdown item selection
  const handleMentionDropdownSelect = useCallback(
    (index: number) => {
      fileMentions.selectItem(index);
    },
    [fileMentions]
  );

  // Close dropdown when clicking outside (Popover renders via Portal, so we check clicks outside textarea)
  useEffect(() => {
    if (!fileMentions.active) return;

    const handleClickOutside = (event: MouseEvent) => {
      // Close if click is outside the textarea (Popover handles its own portal)
      if (
        event.target &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        // Close dropdown by invalidating the active trigger
        setCursorPosition(0);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [fileMentions.active]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const safeJsonParse = useCallback((value?: string) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }, []);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      const maxHeight = 200;
      textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
    }
  }, [input]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const nextLength = feed.length;
    const prevLength = lastFeedLengthRef.current;
    lastFeedLengthRef.current = nextLength;
    if (!container || nextLength === 0) {
      if (nextLength === 0) {
        setUnseenCount(0);
      }
      return;
    }
    const lastItem = feed[nextLength - 1];
    const isUserMessage = lastItem?.type === 'message' && lastItem.role === 'user';
    const shouldForce = forceScrollRef.current;
    const shouldScroll = shouldForce || isPinnedToBottomRef.current || isUserMessage;

    if (shouldScroll) {
      forceScrollRef.current = false;
      scrollToBottom('auto');
      setUnseenCount(0);
      return;
    }
    if (nextLength > prevLength) {
      setUnseenCount((prev) => Math.max(0, prev + (nextLength - prevLength)));
    }
  }, [feed, scrollToBottom]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isRunning || runStartedAt === null) {
      setRunElapsedMs(storedRunElapsedMs || 0);
      return;
    }
    const tick = () => setRunElapsedMs(Date.now() - runStartedAt);
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [isRunning, runStartedAt, storedRunElapsedMs]);

  useEffect(() => {
    void sessionActions.ensureHistory();
  }, [sessionActions]);

  useEffect(() => {
    if (!historyReady) return;
    void sessionActions.ensureSession(task.path);
  }, [historyReady, sessionActions, task.path]);

  useEffect(() => {
    if (!planModeEnabled) {
      setPlanModePromptSent(false);
      setLastUserPlanModeSent(false);
    }
  }, [planModeEnabled]);

  useEffect(() => {
    if (sessionId) {
      setPlanModePromptSent(false);
      setLastUserPlanModeSent(false);
    }
  }, [sessionId]);

  useEffect(() => {
    hasMessagesRef.current = historyHasMessages || feed.some((item) => item.type === 'message');
  }, [historyHasMessages, feed]);

  useEffect(() => {
    if (!historyReady || !historyHasMessages) return;
    if (didRestorePreferencesRef.current === acpConversationId) return;
    didRestorePreferencesRef.current = acpConversationId;
    const storedModel = readLocalStorage(modelStorageKey);
    if (storedModel) {
      setModelId(storedModel);
    }
    const storedBudget = readLocalStorage(thinkingStorageKey);
    if (storedBudget && isThinkingBudgetLevel(storedBudget)) {
      setThinkingBudget(storedBudget);
    }
  }, [historyReady, historyHasMessages, acpConversationId, modelStorageKey, thinkingStorageKey]);

  // Scan for custom slash commands when project or provider changes
  useEffect(() => {
    const loadCustomCommands = async () => {
      if (!task.path || !provider) {
        return;
      }
      uiLog('scanCustomCommands', { projectPath: task.path, provider });
      const result = await window.electronAPI.scanCustomCommands({
        projectPath: task.path,
        providerId: provider,
      });
      uiLog('scanCustomCommands:response', result);
      if (result.success && result.commands && result.commands.length > 0) {
        const mappedCommands = result.commands.map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
          hint: undefined,
        }));
        setCommands(mappedCommands);
      } else {
        // Clear commands when scan fails or returns no results to prevent stale commands
        setCommands([]);
      }
    };
    loadCustomCommands();
  }, [task.path, provider, uiLog]);

  const normalizePath = (value: string) => value.replace(/\\/g, '/');

  const formatPath = useCallback(
    (value?: string) => {
      if (!value) return value;
      const normalized = normalizePath(value);
      const root = normalizePath(task.path || '');
      if (root && normalized.startsWith(root)) {
        let rel = normalized.slice(root.length);
        if (rel.startsWith('/')) rel = rel.slice(1);
        return rel || normalized.split('/').pop() || normalized;
      }
      return normalized.split('/').pop() || normalized;
    },
    [task.path]
  );

  const toFileUri = (filePath: string) => `file://${encodeURI(filePath)}`;

  const fromFileUri = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

  const extractPrimaryText = (blocks: ContentBlock[]) => {
    const textBlock = blocks.find((block) => block.type === 'text' && block.text);
    if (textBlock?.text) return textBlock.text;
    const resourceBlock = blocks.find((block) => block.type === 'resource' && block.resource?.text);
    return resourceBlock?.resource?.text || '';
  };

  const buildCopyText = (blocks: ContentBlock[]) => {
    const parts: string[] = [];
    blocks.forEach((block) => {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
        return;
      }
      if (block.type === 'resource' && block.resource?.text) {
        parts.push(block.resource.text);
      }
    });
    return parts.join('\n\n').trim();
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!sessionId) return;
    if (!trimmed && attachments.length === 0) return;
    setInput('');
    forceScrollRef.current = true;
    setLastUserPlanModeSent(planModeEnabled);
    const includePlanInstruction = planModeEnabled && !planModePromptSent;
    const promptBlocks = buildPromptBlocks(trimmed, planModeEnabled, includePlanInstruction);
    if (includePlanInstruction) setPlanModePromptSent(true);
    setAttachments([]);
    setRunElapsedMs(0);
    const res = await sessionActions.sendPrompt(promptBlocks.display, promptBlocks.agent);
    if (!res?.success) {
      uiLog('sendPrompt:failed', res);
    }
  };

  const handleApprovePlan = async () => {
    if (!planModeEnabled || !lastUserPlanModeSent) return;
    const approvedText = 'approved';
    if (!sessionId || isRunning) {
      setPlanModeEnabled(false);
      return;
    }
    forceScrollRef.current = true;
    try {
      await logPlanEvent(task.path, 'Plan approved via UI; exiting Plan Mode');
    } catch {}
    setPlanModeEnabled(false);
    const promptBlocks = buildPromptBlocks(approvedText, false, false, []);
    setRunElapsedMs(0);
    const res = await sessionActions.sendPrompt(promptBlocks.display, promptBlocks.agent);
    if (!res?.success) {
      uiLog('sendPrompt:failed', res);
    }
  };

  const handleCancel = async () => {
    if (!sessionId) return;
    await sessionActions.cancelSession();
  };

  const handlePermissionChoice = async (requestId: number, optionId: string | null) => {
    if (!sessionId) return;
    const outcome = optionId
      ? ({ outcome: 'selected', optionId } as const)
      : ({ outcome: 'cancelled' } as const);
    await sessionActions.respondPermission(requestId, outcome);
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFiles = async (files: FileList | File[]) => {
    const next: Attachment[] = [];
    for (const file of Array.from(files)) {
      const name = file.name || 'attachment';
      const mimeType = file.type || 'application/octet-stream';
      const path = (file as any).path;
      const size = file.size;
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const isImage = mimeType.startsWith('image/');
      const isAudio = mimeType.startsWith('audio/');
      const isText =
        mimeType.startsWith('text/') || /\.(md|txt|ts|tsx|js|jsx|json|yml|yaml)$/i.test(name);
      const supportsImage = Boolean(promptCaps.image);
      const supportsAudio = Boolean(promptCaps.audio);
      const supportsEmbedded = Boolean(promptCaps.embeddedContext);
      const kind: Attachment['kind'] = isImage ? 'image' : isAudio ? 'audio' : 'file';
      const attachment: Attachment = {
        id,
        name,
        path,
        mimeType,
        size,
        kind,
      };
      if (isImage && supportsImage && size <= 4 * 1024 * 1024) {
        const dataUrl = await readFileAsDataUrl(file);
        if (dataUrl) {
          const base64 = dataUrl.split(',')[1] || '';
          attachment.data = base64;
        }
      } else if (isAudio && supportsAudio && size <= 8 * 1024 * 1024) {
        const dataUrl = await readFileAsDataUrl(file);
        if (dataUrl) {
          const base64 = dataUrl.split(',')[1] || '';
          attachment.data = base64;
        }
      } else if (isText && supportsEmbedded && size <= 200 * 1024) {
        const text = await readFileAsText(file);
        if (text) {
          attachment.textContent = text;
        }
      }
      next.push(attachment);
    }
    if (next.length) {
      setAttachments((prev) => [...prev, ...next]);
    }
  };

  // Plan mode prompt constants
  const PLAN_MODE_FULL_INSTRUCTION = `SYSTEM: PLAN MODE (READ-ONLY)

You are in PLAN MODE. Your job is to research, analyze, and propose a plan. You must not take any action that changes the user's machine or repo.

## Allowed (read-only)
- Read files and inspect code, project structure, and dependencies
- Search the codebase (e.g. rg/grep) and analyze behavior
- Browse the internet / external documentation for reference
- Run strictly read-only commands that only output information (e.g. ls, cat, rg/grep, git status/log/diff)
- Ask clarifying questions and outline implementation steps

## Not allowed (no changes)
- Write/modify/delete any files (including patches, formatters, generators, or creating new files)
- Run commands that might change state or write to disk (e.g. npm install, build steps that emit artifacts, tests that write snapshots/caches, git commit/push/checkout/reset/clean, rm/mv)
- Change configuration, environment variables, system settings, or external services

## Command safety rule
- If you are not 100% sure a command is read-only, do not run it. Propose it for after approval instead.

## Output expectations
- Provide a concrete, numbered plan including which files you would change and how you would validate the result after approval
- Call out assumptions, risks, and any information you still need from the user

Stay in plan mode until the user explicitly approves execution (for example by turning plan mode off).

You may optionally share your plan structure using the ACP plan protocol (session/update with type="plan").`;

  const PLAN_MODE_REMINDER =
    'REMINDER: Plan mode is still active (read-only). Continue researching and planning. Do not make any changes until the user approves execution (e.g. turns plan mode off).';

  const buildPromptBlocks = (
    text: string,
    planMode: boolean,
    includePlanInstruction: boolean,
    overrideAttachments?: Attachment[]
  ): { display: ContentBlock[]; agent: ContentBlock[] } => {
    const contentBlocks: ContentBlock[] = [];
    const supportsImage = Boolean(promptCaps.image);
    const supportsAudio = Boolean(promptCaps.audio);
    const supportsEmbedded = Boolean(promptCaps.embeddedContext);
    const activeAttachments = overrideAttachments ?? attachments;
    activeAttachments.forEach((att) => {
      if (att.kind === 'image' && att.data && supportsImage) {
        contentBlocks.push({ type: 'image', mimeType: att.mimeType, data: att.data });
        return;
      }
      if (att.kind === 'audio' && att.data && supportsAudio) {
        contentBlocks.push({ type: 'audio', mimeType: att.mimeType, data: att.data });
        return;
      }
      if (att.textContent && supportsEmbedded && att.path) {
        contentBlocks.push({
          type: 'resource',
          resource: {
            uri: toFileUri(att.path),
            mimeType: att.mimeType,
            text: att.textContent,
          },
        });
        return;
      }
      if (att.path) {
        contentBlocks.push({
          type: 'resource_link',
          uri: toFileUri(att.path),
          name: att.name,
          title: att.name,
          mimeType: att.mimeType,
          size: att.size,
        });
      }
    });
    if (text) {
      contentBlocks.push({ type: 'text', text });
    }

    const displayBlocks = [...contentBlocks];

    const agentBlocks: ContentBlock[] = [];
    if (planMode) {
      if (includePlanInstruction)
        agentBlocks.push({ type: 'text', text: PLAN_MODE_FULL_INSTRUCTION });
      else agentBlocks.push({ type: 'text', text: PLAN_MODE_REMINDER });
    }
    agentBlocks.push(...contentBlocks);

    return { display: displayBlocks, agent: agentBlocks };
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((att) => att.id !== id));
  };

  const commandSuggestions = useMemo(() => {
    if (!input.startsWith('/')) {
      return [];
    }
    const query = input.slice(1).toLowerCase();
    return commands.filter((cmd) => cmd.name && cmd.name.toLowerCase().includes(query)).slice(0, 6);
  }, [commands, input]);

  const commandHint = useMemo(() => {
    if (!input.startsWith('/')) return null;
    const trimmed = input.trim();
    const name = trimmed.slice(1).split(/\s+/)[0];
    if (!name) return null;
    const hasArgs = trimmed.split(/\s+/).length > 1;
    if (hasArgs) return null;
    const match = commands.find((cmd) => cmd.name.toLowerCase() === name.toLowerCase());
    return match?.hint || null;
  }, [commands, input]);

  const runTimerLabel = useMemo(() => formatDuration(runElapsedMs), [runElapsedMs]);
  const sessionErrorPreview = useMemo(() => {
    if (!sessionError) return '';
    return buildSessionErrorPreview(sessionError);
  }, [sessionError]);
  const showJumpToLatest = !isPinnedToBottom && unseenCount > 0;

  const handleJumpToLatest = useCallback(() => {
    scrollToBottom('smooth');
    setUnseenCount(0);
  }, [scrollToBottom]);

  const handleReconnect = useCallback(() => {
    void sessionActions.restartSession(task.path);
  }, [sessionActions, task.path]);

  const latestToolCallId = useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i -= 1) {
      const item = feed[i];
      if (item.type === 'tool') return item.toolCallId;
    }
    return null;
  }, [feed]);

  const showInlineToolLoading = isRunning && Boolean(latestToolCallId);
  const showBottomLoading = isRunning && !latestToolCallId;

  const canSend = input.trim().length > 0 || attachments.length > 0;
  const modelConfigOption = useMemo(() => findModelConfigOption(configOptions), [configOptions]);
  const modelConfigId = useMemo(() => getConfigOptionId(modelConfigOption), [modelConfigOption]);
  const modelConfigChoices = useMemo(
    () => extractConfigChoices(modelConfigOption),
    [modelConfigOption]
  );
  const configModelValue = useMemo(
    () => getConfigOptionValue(modelConfigOption),
    [modelConfigOption]
  );
  const configModelId =
    configModelValue !== null && configModelValue !== undefined ? String(configModelValue) : null;
  const rawModelVariants = useMemo<ModelOption[]>(() => {
    if (modelConfigChoices.length) {
      return modelConfigChoices
        .map((choice) => {
          if (choice.value === undefined || choice.value === null) return null;
          return {
            id: String(choice.value),
            label: choice.label ?? choice.name ?? String(choice.value),
            description: choice.description,
          };
        })
        .filter(Boolean) as ModelOption[];
    }
    return models.map(normalizeModelOption).filter(Boolean) as ModelOption[];
  }, [modelConfigChoices, models]);

  const modelCatalog = useMemo(() => {
    const map = new Map<
      string,
      {
        baseId: string;
        label: string;
        description?: string;
        variants: ModelVariant[];
        efforts: Set<string>;
      }
    >();
    for (const variant of rawModelVariants) {
      const parts = splitModelId(variant.id, variant.label);
      const baseId = parts.baseId || variant.id;
      const baseLabel = stripEffortSuffix(variant.label) ?? baseId;
      const formattedLabel = formatModelLabel(baseLabel);
      const entry = map.get(baseId) ?? {
        baseId,
        label: formattedLabel,
        description: variant.description,
        variants: [],
        efforts: new Set<string>(),
      };
      entry.variants.push({ ...variant, baseId, effort: parts.effort });
      if (parts.effort) entry.efforts.add(parts.effort);
      if (!entry.label && formattedLabel) entry.label = formattedLabel;
      map.set(baseId, entry);
    }
    return map;
  }, [rawModelVariants]);

  const modelOptions = useMemo<ModelOption[]>(() => {
    const dynamicModels = Array.from(modelCatalog.values()).map((entry) => ({
      id: entry.baseId,
      label: entry.label,
      description: entry.description,
    }));

    if (provider === 'claude' && dynamicModels.length > 0) {
      const formatted = formatClaudeModelOptionsForUi(dynamicModels);
      if (formatted.length > 0) return formatted;
    }

    // Use dynamic models if available, otherwise fall back to static
    const fallback = PROVIDER_MODELS[provider] ?? PROVIDER_MODELS.codex ?? [];
    return dynamicModels.length > 0 ? dynamicModels : fallback;
  }, [modelCatalog, provider]);

  const rawSelectedModelId = configModelId ?? currentModelId ?? (modelId ? String(modelId) : null);
  const selectedModelParts = splitModelId(rawSelectedModelId, null);
  const selectedBaseId =
    (selectedModelParts.baseId && modelCatalog.has(selectedModelParts.baseId)
      ? selectedModelParts.baseId
      : modelOptions[0]?.id) ?? '';
  const selectedModelEntry = selectedBaseId ? modelCatalog.get(selectedBaseId) : undefined;
  const selectedEfforts = selectedModelEntry?.efforts;
  const currentEffort = selectedModelParts.effort;
  const fallbackModelId = selectedBaseId || modelId;
  const resolvedModelValue = modelOptions.some((option) => option.id === fallbackModelId)
    ? fallbackModelId
    : undefined;
  const persistedModelValue =
    resolvedModelValue || selectedBaseId || modelId || currentModelId || '';
  const canSetModel = Boolean(sessionId);
  const thinkingConfigOption = useMemo(
    () => findThinkingConfigOption(configOptions),
    [configOptions]
  );
  const thinkingConfigId = useMemo(
    () => getConfigOptionId(thinkingConfigOption),
    [thinkingConfigOption]
  );
  const thinkingConfigMapping = useMemo(
    () => buildBudgetMapping(thinkingConfigOption),
    [thinkingConfigOption]
  );
  const configDrivenBudget = useMemo(
    () => getBudgetFromConfig(thinkingConfigOption),
    [thinkingConfigOption]
  );
  const modelDrivenBudget = useMemo(() => budgetFromEffort(currentEffort), [currentEffort]);
  const showThinkingBudget = provider === 'codex';
  const fallbackThinkingConfigId = showThinkingBudget ? 'model_reasoning_effort' : null;
  const availableBudgetLevels = useMemo(() => {
    if (thinkingConfigMapping.availableLevels.size) {
      return EFFORT_ORDER.filter((level) => thinkingConfigMapping.availableLevels.has(level));
    }
    if (selectedEfforts?.size) {
      const normalized = new Set(
        Array.from(selectedEfforts)
          .map((entry) => normalizeEffort(entry))
          .filter(Boolean) as ThinkingBudgetLevel[]
      );
      return EFFORT_ORDER.filter((level) => normalized.has(level));
    }
    return ['low', 'medium', 'high'] as ThinkingBudgetLevel[];
  }, [selectedEfforts, thinkingConfigMapping.availableLevels]);
  const resolvedBudget: ThinkingBudgetLevel =
    configDrivenBudget ??
    modelDrivenBudget ??
    thinkingBudget ??
    availableBudgetLevels[0] ??
    'medium';
  const activeBudgetLevel = availableBudgetLevels.includes(resolvedBudget)
    ? resolvedBudget
    : (availableBudgetLevels[0] ?? 'medium');
  const activeBudgetLabel = EFFORT_LABELS[activeBudgetLevel];
  const activeBudgetIndex = Math.max(0, availableBudgetLevels.indexOf(activeBudgetLevel));
  const dotCount = Math.max(1, availableBudgetLevels.length);
  const dotSize = dotCount >= 4 ? 3 : 4;
  const dotGap = dotCount >= 4 ? 2 : 3;
  const canSetThinkingBudget =
    showThinkingBudget &&
    Boolean(sessionId) &&
    (Boolean(thinkingConfigId) ||
      Boolean(selectedModelEntry?.variants.length) ||
      Boolean(fallbackThinkingConfigId));

  const handleModelChange = useCallback(
    (value: string) => {
      setModelId(value);
      writeLocalStorage(modelStorageKey, value);
      if (!canSetModel) return;

      const entry = modelCatalog.get(value);
      const availableEfforts = entry?.efforts ?? new Set<string>();
      const preferredEffort =
        (activeBudgetLevel && chooseEffortForBudget(activeBudgetLevel, availableEfforts)) ||
        currentEffort;
      const targetVariant =
        entry?.variants.find((variant) => variant.effort === preferredEffort) ?? entry?.variants[0];
      const targetModelId = targetVariant?.id ?? value;

      if (modelConfigId) {
        const choice = modelConfigChoices.find((item) => String(item.value) === targetModelId);
        const targetValue = choice?.value ?? targetModelId;
        void sessionActions
          .setConfigOption(modelConfigId, targetValue, { optimistic: true })
          .then((res) => {
            if (!res?.success) {
              uiLog('model:setFailed', { modelId: targetModelId, error: res?.error });
            }
          });
        return;
      }

      void sessionActions.setModel(targetModelId, { optimistic: true }).then((res) => {
        if (!res?.success) {
          uiLog('model:setFailed', { modelId: targetModelId, error: res?.error });
        }
      });
    },
    [
      activeBudgetLevel,
      canSetModel,
      currentEffort,
      modelStorageKey,
      modelCatalog,
      modelConfigChoices,
      modelConfigId,
      sessionActions,
      uiLog,
    ]
  );

  useEffect(() => {
    if (persistedModelValue) {
      persistedModelRef.current = persistedModelValue;
    }
  }, [persistedModelValue]);

  useEffect(() => {
    persistedThinkingBudgetRef.current = activeBudgetLevel;
  }, [activeBudgetLevel]);

  useEffect(() => {
    return () => {
      if (!hasMessagesRef.current) return;
      const modelValue = persistedModelRef.current;
      if (modelValue) {
        writeLocalStorage(modelStorageKey, modelValue);
      }
      const budgetValue = persistedThinkingBudgetRef.current;
      if (showThinkingBudget && budgetValue) {
        writeLocalStorage(thinkingStorageKey, budgetValue);
      }
    };
  }, [modelStorageKey, thinkingStorageKey, showThinkingBudget]);

  const handleThinkingBudgetClick = useCallback(() => {
    if (!showThinkingBudget) return;

    const next = nextBudgetLevel(activeBudgetLevel, availableBudgetLevels);
    setThinkingBudget(next);
    writeLocalStorage(thinkingStorageKey, next);

    if (!canSetThinkingBudget) return;
    if (thinkingConfigId) {
      const targetChoice = thinkingConfigMapping.budgetToChoice.get(next);
      const targetValue = targetChoice?.value ?? next;
      if (targetValue === undefined) {
        uiLog('thinkingBudget:missingOption', { next, configId: thinkingConfigId });
        return;
      }
      void sessionActions
        .setConfigOption(thinkingConfigId, targetValue, { optimistic: true })
        .then((res) => {
          if (!res?.success) {
            uiLog('thinkingBudget:setFailed', { configId: thinkingConfigId, error: res?.error });
          }
        });
      return;
    }

    if (selectedModelEntry && selectedModelEntry.variants.length) {
      const desiredEffort = chooseEffortForBudget(next, selectedModelEntry.efforts);
      const targetVariant =
        selectedModelEntry.variants.find((variant) => variant.effort === desiredEffort) ??
        selectedModelEntry.variants[0];
      if (!targetVariant) return;
      void sessionActions.setModel(targetVariant.id, { optimistic: true }).then((res) => {
        if (!res?.success) {
          uiLog('thinkingBudget:setFailed', { modelId: targetVariant.id, error: res?.error });
        }
      });
      return;
    }

    const configId = fallbackThinkingConfigId;
    if (!configId) return;
    const targetValue = next;
    void sessionActions.setConfigOption(configId, targetValue, { optimistic: true }).then((res) => {
      if (!res?.success) {
        uiLog('thinkingBudget:setFailed', { configId, error: res?.error });
      }
    });
  }, [
    activeBudgetLevel,
    canSetThinkingBudget,
    showThinkingBudget,
    fallbackThinkingConfigId,
    availableBudgetLevels,
    thinkingConfigId,
    thinkingConfigMapping.budgetToChoice,
    thinkingStorageKey,
    selectedModelEntry,
    sessionActions,
    uiLog,
  ]);

  const handleCopyMessage = useCallback(
    async (messageId: string, text: string) => {
      if (!text) return;
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        console.error('Clipboard API not available in this environment');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setCopiedMessageId(messageId);
        if (copyResetRef.current !== null) {
          window.clearTimeout(copyResetRef.current);
        }
        copyResetRef.current = window.setTimeout(() => {
          setCopiedMessageId(null);
          copyResetRef.current = null;
        }, 2000);
      } catch (error) {
        console.error('Failed to copy message', error);
        setCopiedMessageId(null);
      }
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps -- Intentionally empty to avoid recreating callback; uses latest state via setState
  );

  const renderContentBlocks = (
    blocks: ContentBlock[],
    options?: { compact?: boolean; maxPreviewChars?: number }
  ) => {
    const isCompact = Boolean(options?.compact);
    const previewLimit = options?.maxPreviewChars ?? 200;
    return blocks.map((block, index) => {
      if (block.type === 'text') {
        const text = block.text || '';
        const clipped = isCompact ? truncateText(text, previewLimit) : text;
        return (
          <p
            key={index}
            className={
              isCompact
                ? 'whitespace-pre-wrap text-xs text-muted-foreground'
                : 'whitespace-pre-wrap text-sm leading-relaxed'
            }
          >
            {clipped}
          </p>
        );
      }
      if (block.type === 'image' && block.data && block.mimeType) {
        return (
          <img
            key={index}
            src={`data:${block.mimeType};base64,${block.data}`}
            alt={block.title || 'image'}
            className="max-h-64 rounded-md border"
          />
        );
      }
      if (block.type === 'audio' && block.data && block.mimeType) {
        return (
          <audio key={index} controls className="w-full">
            <source src={`data:${block.mimeType};base64,${block.data}`} />
          </audio>
        );
      }
      if (block.type === 'resource' || block.type === 'resource_link') {
        const resource = block.resource || {};
        const uri = (resource.uri as string | undefined) || block.uri || '';
        const label =
          resource.title || resource.name || block.title || block.name || uri || 'resource';
        const previewText = (resource.text as string | undefined) || block.text;
        const isFile = uri.startsWith('file://');
        const filePath = isFile ? fromFileUri(uri) : '';
        const displayLabel = isFile && filePath ? formatPath(filePath) || label : label;
        const displayLabelText = truncateText(displayLabel, 160);
        return (
          <div
            key={index}
            className={`flex items-center justify-between gap-2 text-xs ${
              isCompact ? 'text-muted-foreground/90' : 'text-muted-foreground'
            }`}
          >
            <div className="min-w-0">
              <div className="overflow-hidden whitespace-nowrap">{displayLabelText}</div>
              {block.type === 'resource' && previewText ? (
                <div className="mt-1 text-[11px] text-muted-foreground/80">
                  {truncateText(previewText, previewLimit)}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {uri ? (
                <button
                  type="button"
                  onClick={() => {
                    if (uri.startsWith('http')) {
                      window.electronAPI.openExternal(uri);
                      return;
                    }
                    if (isFile) {
                      const filePath = decodeURIComponent(uri.replace('file://', ''));
                      window.electronAPI.openIn({ app: 'finder', path: filePath });
                    }
                  }}
                  className="text-xs text-foreground underline"
                >
                  Open
                </button>
              ) : null}
            </div>
          </div>
        );
      }
      return (
        <pre key={index} className="whitespace-pre-wrap text-xs text-muted-foreground">
          {JSON.stringify(block, null, 2)}
        </pre>
      );
    });
  };

  const ActionRow: React.FC<{
    id: string;
    icon: React.ReactNode;
    label: string;
    target?: string;
    leftMeta?: React.ReactNode;
    meta?: React.ReactNode;
    status?: string;
    expanded?: boolean;
    onToggle?: () => void;
    children?: React.ReactNode;
  }> = ({ id, icon, label, target, leftMeta, meta, status, expanded, onToggle, children }) => {
    const showStatus = status !== undefined && ['failed', 'cancelled', 'error'].includes(status);
    const statusClass =
      status && statusStyles[status]
        ? statusStyles[status]
        : 'text-muted-foreground bg-muted/40 border-border';
    return (
      <div data-action-id={id} className="rounded-md">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/30"
        >
          <span className="relative flex h-4 w-4 items-center justify-center text-muted-foreground">
            <span className="transition-opacity group-hover:opacity-0">{icon}</span>
            <Plus className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
          <span className="min-w-0 flex-1 overflow-hidden text-sm">
            <span className="font-medium text-foreground">{label}</span>
            {target || leftMeta ? (
              <span className="ml-2 inline-flex min-w-0 items-center gap-2 overflow-hidden text-muted-foreground">
                {target ? (
                  <span className="overflow-hidden whitespace-nowrap">{target}</span>
                ) : null}
                {leftMeta ? <span className="flex items-center gap-2">{leftMeta}</span> : null}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {meta}
            {showStatus ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusClass}`}
              >
                {status.replace('_', ' ')}
              </span>
            ) : null}
          </span>
        </button>
        {expanded && children ? (
          <div className="px-3 pb-2 pt-1">
            <div className="inline-block max-w-full rounded-md border border-border/40 bg-muted/10 px-2.5 py-1.5">
              {children}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderDiffPreview = (diff: DiffPreview) => {
    if (!diff.lines.length) return null;
    const pathLabel = diff.path ? truncateText(diff.path, 160) : null;
    return (
      <div className="rounded-md px-1">
        {pathLabel ? (
          <div className="mb-1 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
            {pathLabel}
          </div>
        ) : null}
        <div className="space-y-0.5 font-mono text-xs">
          {diff.lines.map((line, idx) => {
            const style =
              line.type === 'add'
                ? 'text-emerald-700 bg-emerald-50/70 dark:text-emerald-300 dark:bg-emerald-900/30'
                : line.type === 'del'
                  ? 'text-red-700 bg-red-50/70 dark:text-red-300 dark:bg-red-900/30'
                  : 'text-muted-foreground';
            const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
            return (
              <div key={idx} className={`flex gap-2 rounded px-1 ${style}`}>
                <span className="w-3 select-none">{prefix}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {line.text || ' '}
                </span>
              </div>
            );
          })}
        </div>
        {diff.truncated ? (
          <div className="mt-1 text-[11px] text-muted-foreground">Diff truncated</div>
        ) : null}
      </div>
    );
  };

  // Memoize diff previews to avoid re-computing Myers diff on every render
  const diffPreviewsByToolCall = useMemo(() => {
    const result: Record<string, DiffPreview[]> = {};
    for (const [toolCallId, toolCall] of Object.entries(toolCalls)) {
      const diffItems = (toolCall.content?.filter((item) => item.type === 'diff') || []) as Array<{
        type: 'diff';
        path?: string;
        oldText?: string;
        newText?: string;
        original?: string;
        updated?: string;
        preview?: DiffPreview;
      }>;
      if (diffItems.length > 0) {
        result[toolCallId] = diffItems.map((item) => {
          if (item.preview) {
            const path = item.path || item.preview.path;
            return { ...item.preview, path: formatPath(path) } as DiffPreview;
          }
          const before = (item as any).oldText ?? (item as any).original ?? '';
          const after = (item as any).newText ?? (item as any).updated ?? '';
          const preview = buildDiffPreview(String(before ?? ''), String(after ?? ''));
          return { ...preview, path: formatPath(item.path) } as DiffPreview;
        });
      }
    }
    return result;
  }, [toolCalls, formatPath]);

  const renderToolCall = (toolCallId: string, options?: { showLoading?: boolean }) => {
    const toolCall = toolCalls[toolCallId];
    if (!toolCall) return null;
    const status = toolCall.status || 'pending';
    const expandedKey = `tool-${toolCallId}`;
    const expanded = Boolean(expandedItems[expandedKey]);
    const kindLabel = `${toolCall.title || ''} ${toolCall.kind || ''}`.toLowerCase();
    const diffItems = (toolCall.content?.filter((item) => item.type === 'diff') || []) as Array<{
      type: 'diff';
      path?: string;
      oldText?: string;
      newText?: string;
      original?: string;
      updated?: string;
      preview?: DiffPreview;
    }>;
    const terminalItems =
      (toolCall.content?.filter((item) => item.type === 'terminal') as
        | Array<{ type: 'terminal'; terminalId: string }>
        | undefined) || [];
    const contentBlocks =
      (toolCall.content?.filter((item) => item.type === 'content') as
        | Array<{ type: 'content'; content: ContentBlock }>
        | undefined) || [];

    // Use memoized diff previews to avoid re-computing Myers diff on every render
    const diffPreviews: DiffPreview[] = diffPreviewsByToolCall[toolCallId] || [];

    const diffTotals = diffPreviews.reduce(
      (acc, diff) => ({
        additions: acc.additions + diff.additions,
        deletions: acc.deletions + diff.deletions,
      }),
      { additions: 0, deletions: 0 }
    );

    const parsedInput = safeJsonParse(toolCall.rawInput);
    const command = parsedInput?.command
      ? [parsedInput.command, ...(Array.isArray(parsedInput.args) ? parsedInput.args : [])].join(
          ' '
        )
      : null;
    const query =
      parsedInput?.query || parsedInput?.search || parsedInput?.input || parsedInput?.prompt;

    const contentPaths = contentBlocks
      .map((item) => {
        const block = item.content;
        const resource = block.resource || {};
        const uri = (resource.uri as string | undefined) || block.uri;
        if (uri?.startsWith('file://')) return formatPath(fromFileUri(uri));
        return null;
      })
      .filter(Boolean) as string[];
    const locationPath = formatPath(toolCall.locations?.[0]?.path);
    const diffSource = diffItems.find((item) => item.path || item.preview?.path);
    const diffPath = formatPath(diffSource?.path ?? diffSource?.preview?.path);
    const rawPath = formatPath(parsedInput?.path || parsedInput?.filePath || parsedInput?.filepath);
    const primaryPath = diffPath || locationPath || contentPaths[0] || rawPath;

    const hasTerminal = terminalItems.length > 0 || Boolean(command);
    const hasDiff = diffItems.length > 0;
    const hasHttpResources = contentBlocks.some((item) => {
      const block = item.content;
      const resource = block.resource || {};
      const uri = (resource.uri as string | undefined) || block.uri || '';
      return uri.startsWith('http://') || uri.startsWith('https://');
    });

    let action = 'tool';
    if (hasDiff || /write|edit|modify|update|patch|diff/.test(kindLabel)) {
      action = 'edit';
    } else if (hasTerminal || /terminal|run|exec|command/.test(kindLabel)) {
      action = 'run';
    } else if (/read|view|open/.test(kindLabel) || primaryPath) {
      action = 'view';
    } else if (/search|browse|research|web/.test(kindLabel) || hasHttpResources) {
      action = 'research';
    }

    const icon =
      action === 'edit' ? (
        <Pencil className="h-4 w-4" />
      ) : action === 'run' ? (
        <Terminal className="h-4 w-4" />
      ) : action === 'view' ? (
        <FileText className="h-4 w-4" />
      ) : action === 'research' ? (
        <Search className="h-4 w-4" />
      ) : (
        <Sparkles className="h-4 w-4" />
      );

    const label = action === 'tool' ? toolCall.title || toolCall.kind || 'Tool' : action;
    const target =
      action === 'run'
        ? command || primaryPath
        : action === 'research'
          ? query || toolCall.title || primaryPath
          : action === 'tool'
            ? primaryPath || query
            : primaryPath || toolCall.title || toolCall.kind;
    const displayTarget = target
      ? truncateText(collapseWhitespace(String(target)), 160)
      : undefined;
    const leftMeta = hasDiff ? (
      <>
        <span className="text-emerald-600">+{diffTotals.additions}</span>
        <span className="text-red-600">-{diffTotals.deletions}</span>
      </>
    ) : null;

    let meta: React.ReactNode = null;
    if (action === 'view') {
      const text = extractPrimaryText(contentBlocks.map((item) => item.content));
      if (text) {
        const count = splitLines(text).length;
        meta = <span>{count} lines</span>;
      }
    } else if (action === 'research') {
      const sources = contentBlocks.filter((item) => {
        const block = item.content;
        const resource = block.resource || {};
        const uri = (resource.uri as string | undefined) || block.uri || '';
        return uri.startsWith('http://') || uri.startsWith('https://');
      }).length;
      if (sources) meta = <span>{sources} sources</span>;
    }

    const showLoading = Boolean(options?.showLoading);

    return (
      <ActionRow
        key={expandedKey}
        id={expandedKey}
        icon={icon}
        label={label}
        target={displayTarget}
        leftMeta={leftMeta}
        meta={meta}
        status={status}
        expanded={expanded}
        onToggle={() => toggleExpanded(expandedKey)}
      >
        <div className="space-y-2 text-sm text-foreground">
          {diffPreviews.length ? (
            <div className="space-y-2">
              {diffPreviews.map((diff, idx) => (
                <div key={`${diff.path || 'diff'}-${idx}`}>{renderDiffPreview(diff)}</div>
              ))}
            </div>
          ) : null}
          {contentBlocks.length ? (
            <div className="space-y-2">
              {contentBlocks.map((item, idx) => (
                <div key={idx}>
                  {renderContentBlocks([item.content], { compact: true, maxPreviewChars: 280 })}
                </div>
              ))}
            </div>
          ) : null}
          {terminalItems.length ? (
            <div className="space-y-2">
              {terminalItems.map((item, idx) => {
                const output = terminalOutputs[item.terminalId] || '';
                const tail = getTailLines(output, 60);
                return (
                  <div
                    key={`${item.terminalId}-${idx}`}
                    className="rounded-md bg-black/90 px-3 py-2 text-xs text-white"
                  >
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-white/60">
                      Terminal output
                    </div>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">
                      {tail.lines.join('\n')}
                    </pre>
                    {tail.truncated ? (
                      <div className="mt-1 text-[11px] text-white/60">Output truncated</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        {showLoading ? <LoadingTimer label={runTimerLabel} /> : null}
      </ActionRow>
    );
  };

  const renderPermission = (request: PermissionRequest) => {
    const toolTitle =
      request.toolCall?.title ||
      request.toolCall?.kind ||
      (request as any).title ||
      'Permission required';
    return (
      <div
        key={request.requestId}
        className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div className="space-y-1">
            <div className="font-semibold">{toolTitle}</div>
            <div className="text-xs text-destructive/90">
              This tool call requires explicit approval.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {request.options?.length ? (
                request.options.map((option) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant="secondary"
                    className="h-7"
                    onClick={() => handlePermissionChoice(request.requestId, option.id)}
                  >
                    {option.label}
                    {option.kind ? ` (${option.kind})` : ''}
                  </Button>
                ))
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7"
                  onClick={() => handlePermissionChoice(request.requestId, 'approve')}
                >
                  Allow
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => handlePermissionChoice(request.requestId, null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderToolThoughtGroup = (
    groupId: string,
    buffer: FeedItem[],
    expanded: boolean,
    showLoading: boolean
  ) => {
    const toolCount = buffer.filter((item) => item.type === 'tool').length;
    const thoughtCount = buffer.filter(
      (item) => item.type === 'message' && item.messageKind === 'thought'
    ).length;
    if (!toolCount && !thoughtCount) return null;
    const parts: string[] = [];
    if (toolCount) parts.push(pluralize(toolCount, 'tool call'));
    if (thoughtCount) parts.push(pluralize(thoughtCount, 'thought'));
    return (
      <div key={groupId} className="rounded-md">
        <button
          type="button"
          onClick={() => toggleExpanded(groupId)}
          aria-expanded={expanded}
          className="group flex items-center gap-2 rounded-md px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span>{parts.join(', ')}</span>
        </button>
        {expanded ? (
          <div className="mt-1 space-y-2">
            {buffer.map((item) => {
              if (item.type === 'tool') {
                return renderToolCall(item.toolCallId, {
                  showLoading: showLoading && item.toolCallId === latestToolCallId,
                });
              }
              if (item.type === 'message' && item.messageKind === 'thought') {
                return renderThoughtMessage(item);
              }
              return null;
            })}
          </div>
        ) : null}
        {showLoading && !expanded ? (
          <div className="mt-1">
            <LoadingTimer label={runTimerLabel} />
          </div>
        ) : null}
      </div>
    );
  };

  const renderThoughtMessage = (item: Extract<FeedItem, { type: 'message' }>) => {
    const expandedKey = `thought-${item.id}`;
    const expanded = Boolean(expandedItems[expandedKey]);
    const text = extractPrimaryText(item.blocks).trim();
    const summary = text ? truncateText(text.split('\n')[0], 120) : 'Thinking...';
    return (
      <ActionRow
        key={expandedKey}
        id={expandedKey}
        icon={<Brain className="h-4 w-4" />}
        label="thinking"
        target={summary}
        expanded={expanded}
        onToggle={() => toggleExpanded(expandedKey)}
      >
        <div className={item.streaming ? 'shimmer-text' : ''}>
          {renderContentBlocks(item.blocks, { compact: true, maxPreviewChars: 800 })}
        </div>
      </ActionRow>
    );
  };

  const renderMessage = (item: Extract<FeedItem, { type: 'message' }>) => {
    if (item.messageKind === 'thought') {
      return renderThoughtMessage(item);
    }
    const isUser = item.role === 'user';
    const isSystem = item.role === 'system';
    const wrapperClass = isSystem
      ? 'flex justify-center'
      : isUser
        ? 'flex justify-end'
        : 'flex justify-start';
    const base = isSystem
      ? 'max-w-[80%] rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs text-muted-foreground'
      : isUser
        ? 'max-w-[75%] rounded-2xl border border-sky-500/40 bg-sky-600 px-4 py-3 text-white shadow-sm dark:bg-sky-500/80'
        : 'max-w-[80%] text-sm text-foreground';
    const showFooter =
      item.role === 'assistant' && !item.messageKind && typeof item.runDurationMs === 'number';
    const messageText = showFooter ? buildCopyText(item.blocks) : '';
    const CopyIcon = copiedMessageId === item.id ? Check : Copy;
    return (
      <div key={item.id} className={wrapperClass}>
        <div className={base}>
          <div className={item.streaming && !isUser ? 'shimmer-text' : ''}>
            {renderContentBlocks(item.blocks)}
          </div>
          {showFooter ? (
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="tabular-nums">{formatDuration(item.runDurationMs ?? 0)}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] text-foreground hover:bg-background"
                onClick={() => handleCopyMessage(item.id, messageText)}
                disabled={!messageText}
              >
                <CopyIcon className="h-3 w-3" />
                <span>{copiedMessageId === item.id ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div
      className={cn(
        'flex h-full flex-col bg-white transition-colors duration-300 dark:bg-gray-900',
        planModeEnabled && 'bg-sky-50/30 dark:bg-sky-950/20',
        className || ''
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-6">
          <div className="mx-auto max-w-4xl space-y-2">
            {isProviderInstalled === false ? (
              <InstallBanner
                provider={provider as any}
                installCommand={getInstallCommandForProvider(provider as any)}
                onRunInstall={runInstallCommand}
                onOpenExternal={(url) => window.electronAPI.openExternal(url)}
              />
            ) : null}
          </div>
        </div>

        {plan && plan.length ? (
          <div className="px-6 pt-3">
            <div className="mx-auto max-w-4xl rounded-md border border-border bg-muted/20 p-3 text-sm">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                onClick={() => setShowPlan((v) => !v)}
              >
                Plan
                <ChevronDown className={`h-3.5 w-3.5 transition ${showPlan ? 'rotate-180' : ''}`} />
              </button>
              {showPlan ? (
                <div className="mt-2 space-y-2">
                  {plan.map((entry, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-sm text-foreground">
                      <Circle className="mt-0.5 h-3 w-3 text-muted-foreground" />
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{entry.content || ''}</span>
                          {entry.priority ? (
                            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {entry.priority}
                            </span>
                          ) : null}
                        </div>
                        {entry.status ? (
                          <div className="text-xs text-muted-foreground">{entry.status}</div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Plan Mode Info Banner */}
        <AnimatePresence initial={false}>
          {planModeEnabled && !planBannerDismissed && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginTop: 0 }}
              animate={{ opacity: 1, height: 'auto', marginTop: '0.75rem' }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="px-6"
            >
              <div className="mx-auto max-w-4xl">
                <div className="flex items-start gap-3 rounded-md border border-sky-200/60 bg-sky-50/80 px-3 py-2.5 text-xs shadow-sm dark:border-sky-700/40 dark:bg-sky-950/40">
                  <div className="mt-0.5 flex-shrink-0">
                    <svg
                      className="h-4 w-4 text-sky-600 dark:text-sky-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <div className="font-semibold text-sky-900 dark:text-sky-100">
                      Plan Mode Active
                    </div>
                    <div className="mt-0.5 text-sky-700 dark:text-sky-300">
                      Ask questions and explore changes. When ready, approve the plan to apply
                      modifications.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPlanBannerDismissed(true);
                      writeLocalStorage(planBannerStorageKey, '1');
                    }}
                    className="flex-shrink-0 rounded-sm p-0.5 text-sky-600 hover:bg-sky-200/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-sky-400 dark:hover:bg-sky-800/50"
                    aria-label="Dismiss plan mode banner"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative mt-4 min-h-0 flex-1">
          <div
            ref={scrollContainerRef}
            onScroll={updatePinnedState}
            className="h-full overflow-y-auto px-6"
          >
            <div className="mx-auto flex max-w-4xl flex-col gap-3 pb-8">
              {(() => {
                const rendered: React.ReactNode[] = [];
                let buffer: FeedItem[] = [];

                const flushInline = () => {
                  if (!buffer.length) return;
                  buffer.forEach((item) => {
                    if (item.type === 'tool') {
                      rendered.push(
                        renderToolCall(item.toolCallId, {
                          showLoading:
                            showInlineToolLoading && item.toolCallId === latestToolCallId,
                        })
                      );
                    }
                    if (item.type === 'message' && item.messageKind === 'thought') {
                      rendered.push(renderThoughtMessage(item));
                    }
                  });
                  buffer = [];
                };

                const canCollapseBuffer = (
                  assistantItem: Extract<FeedItem, { type: 'message' }>
                ) => {
                  if (!buffer.length) return false;
                  if (assistantItem.streaming) return false;
                  for (const item of buffer) {
                    if (item.type === 'tool') {
                      const status = toolCalls[item.toolCallId]?.status;
                      if (!status || !['completed', 'failed', 'cancelled'].includes(status)) {
                        return false;
                      }
                    }
                    if (item.type === 'message' && item.messageKind === 'thought') {
                      if (item.streaming) return false;
                    }
                  }
                  return true;
                };

                feed.forEach((item) => {
                  if (
                    item.type === 'tool' ||
                    (item.type === 'message' && item.messageKind === 'thought')
                  ) {
                    buffer.push(item);
                    return;
                  }

                  if (item.type === 'message' && item.role === 'assistant') {
                    const shouldCollapse = canCollapseBuffer(item);
                    if (!shouldCollapse) {
                      flushInline();
                    } else {
                      const groupId = `tools-${item.id}`;
                      const expanded = Boolean(expandedItems[groupId]);
                      const hasLatest =
                        showInlineToolLoading &&
                        Boolean(
                          latestToolCallId &&
                            buffer.some(
                              (buffered) =>
                                buffered.type === 'tool' && buffered.toolCallId === latestToolCallId
                            )
                        );
                      rendered.push(renderToolThoughtGroup(groupId, buffer, expanded, hasLatest));
                      buffer = [];
                    }
                    rendered.push(renderMessage(item));
                    return;
                  }

                  flushInline();

                  if (item.type === 'message') {
                    rendered.push(renderMessage(item));
                    return;
                  }
                  if (item.type === 'permission') {
                    const request = permissions[item.requestId];
                    rendered.push(request ? renderPermission(request) : null);
                    return;
                  }
                });

                flushInline();
                return rendered;
              })()}
              {showBottomLoading ? <LoadingTimer label={runTimerLabel} /> : null}
              <div ref={bottomRef} />
            </div>
          </div>
          {showJumpToLatest ? (
            <div className="pointer-events-none absolute bottom-6 left-8 z-20">
              <button
                type="button"
                onClick={handleJumpToLatest}
                className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-md hover:bg-background"
              >
                Jump to latest
                {unseenCount > 0 ? (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                    {unseenCount}
                  </span>
                ) : null}
              </button>
            </div>
          ) : null}
        </div>

        <div className="bg-transparent px-4 pb-4">
          <div className="mx-auto max-w-4xl space-y-3">
            {commandSuggestions.length ? (
              <div className="rounded-lg border border-border bg-background p-2 text-xs shadow-lg">
                {commandSuggestions.map((cmd) => (
                  <button
                    key={cmd.name}
                    type="button"
                    className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-muted/40"
                    onClick={() => setInput(`/${cmd.name} `)}
                  >
                    <span className="font-medium text-foreground">/{cmd.name}</span>
                    {cmd.description ? (
                      <span className="text-muted-foreground">{cmd.description}</span>
                    ) : null}
                    {cmd.hint ? (
                      <span className="text-muted-foreground/70">- {cmd.hint}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            {fileMentions.active && (
              <FileMentionDropdown
                items={fileMentions.items}
                query={fileMentions.query}
                selectedIndex={fileMentions.selectedIndex}
                onSelect={handleMentionDropdownSelect}
                getDisplayName={fileMentions.getDisplayName}
                anchorRect={caretPosition}
                error={fileMentions.error}
                loading={fileMentions.loading}
              />
            )}
            <div
              className={cn(
                'relative rounded-xl border shadow-sm backdrop-blur-sm transition-all duration-300',
                'border-border/60 bg-background/90',
                planModeEnabled &&
                  'border-sky-400/60 bg-sky-50/50 dark:border-sky-500/50 dark:bg-sky-950/30'
              )}
            >
              {/* Plan Mode Badge - top-left overlay when active */}
              <AnimatePresence initial={false}>
                {planModeEnabled && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, x: -4 }}
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.95, x: -4 }}
                    transition={{ duration: 0.15 }}
                    className="absolute -top-2.5 left-4 z-10"
                  >
                    <Badge
                      variant="outline"
                      className="border-sky-300/60 bg-sky-50/90 text-sky-700 dark:border-sky-600/50 dark:bg-sky-950/80 dark:text-sky-300"
                    >
                      <Clipboard className="h-3 w-3" aria-hidden="true" />
                      <span>Plan Mode</span>
                    </Badge>
                  </motion.div>
                )}
              </AnimatePresence>
              {sessionError ? (
                <div className="absolute -top-16 left-4 right-4 z-10 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/95 px-3 py-2 text-xs text-destructive-foreground shadow-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">ACP session failed</div>
                    <div className="whitespace-pre-wrap break-words">{sessionErrorPreview}</div>
                    <div className="mt-1 flex items-center gap-2">
                      {!sessionId ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive-foreground hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={handleReconnect}
                          disabled={!historyReady}
                          aria-label={
                            historyReady
                              ? 'Reconnect to ACP session'
                              : 'Reconnect disabled - waiting for chat history to load'
                          }
                        >
                          Reconnect
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive-foreground hover:bg-destructive/20"
                        onClick={() => handleCopyMessage(SESSION_ERROR_COPY_ID, sessionError ?? '')}
                        disabled={!sessionError}
                      >
                        {copiedMessageId === SESSION_ERROR_COPY_ID ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        <span>
                          {copiedMessageId === SESSION_ERROR_COPY_ID ? 'Copied' : 'Copy full error'}
                        </span>
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss ACP session error"
                    onClick={() => sessionActions.clearSessionError()}
                    className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-destructive-foreground/80 hover:bg-destructive/20 hover:text-destructive-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {planModeEnabled && lastUserPlanModeSent ? (
                <div className="absolute -top-4 right-4 z-20">
                  <button
                    type="button"
                    onClick={handleApprovePlan}
                    disabled={isRunning}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground shadow-md hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
                    title="Approve Plan & Exit"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Approve Plan</span>
                  </button>
                </div>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                onChange={(event) => {
                  if (!event.target.files) return;
                  void handleFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <div className="px-4 pt-4">
                {sessionStarting && !sessionId ? (
                  <div className="mb-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                    <Spinner size="sm" className="text-muted-foreground/70" aria-hidden="true" />
                    <span>Connecting to ACP...</span>
                  </div>
                ) : null}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => {
                    setInput(event.currentTarget.value);
                    // Track cursor position for mention detection
                    setCursorPosition(event.currentTarget.selectionStart || 0);
                  }}
                  onSelect={(event) => {
                    // Update cursor position when user clicks or drags
                    setCursorPosition(event.currentTarget.selectionStart || 0);
                  }}
                  placeholder={
                    planModeEnabled
                      ? 'Ask questions or explore changes (Plan Mode)...'
                      : 'Ask to make changes...'
                  }
                  rows={1}
                  className="w-full resize-none overflow-y-auto bg-transparent text-sm leading-relaxed text-foreground selection:bg-primary/20 placeholder:text-muted-foreground focus:outline-none"
                  style={{ minHeight: '40px', maxHeight: '200px' }}
                  onKeyDown={(event) => {
                    const mentionKeyAction = getMentionKeyAction({
                      active: fileMentions.active,
                      hasItems: fileMentions.items.length > 0,
                      key: event.key,
                      shiftKey: event.shiftKey,
                    });

                    if (mentionKeyAction !== 'none') {
                      event.preventDefault();
                      if (mentionKeyAction === 'next') {
                        fileMentions.selectNext();
                      } else if (mentionKeyAction === 'prev') {
                        fileMentions.selectPrevious();
                      } else if (mentionKeyAction === 'select') {
                        fileMentions.selectItem(fileMentions.selectedIndex);
                      } else if (mentionKeyAction === 'close') {
                        // Close dropdown by clearing trigger (handled by hook state)
                        setCursorPosition(0);
                      }
                      return;
                    }

                    // Normal send behavior when dropdown is closed
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (event.dataTransfer?.files?.length) {
                      void handleFiles(event.dataTransfer.files);
                    }
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  spellCheck={false}
                />
              </div>
              {attachments.length ? (
                <div className="flex flex-wrap items-center gap-2 px-4 pt-2">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs"
                    >
                      <span className="truncate">{att.name}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => removeAttachment(att.id)}
                        aria-label="Remove attachment"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3">
                <div className="flex items-center gap-2">
                  <Select value={resolvedModelValue} onValueChange={handleModelChange}>
                    <SelectTrigger
                      disabled={!canSetModel || modelOptions.length === 0}
                      className="h-8 w-auto gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 text-xs font-medium text-foreground shadow-sm"
                    >
                      {provider === 'claude' ? (
                        <img src={claudeLogo} alt="Claude" className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <OpenAIIcon className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <SelectValue
                        placeholder={modelOptions.length ? 'Model' : 'Model (not supported)'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.length > 0 ? (
                        modelOptions.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="__empty" disabled>
                          No models available
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => setPlanModeEnabled((prev) => !prev)}
                    aria-pressed={planModeEnabled}
                    title={planModeEnabled ? 'Plan mode: read-only' : 'Full access'}
                    className={`flex h-8 items-center justify-center rounded-md px-2 text-muted-foreground transition ${
                      planModeEnabled
                        ? 'bg-sky-100/70 text-sky-700 hover:bg-sky-100/90 dark:bg-sky-500/10 dark:text-sky-200 dark:hover:bg-sky-500/15'
                        : 'bg-transparent hover:bg-muted/40 hover:text-foreground'
                    }`}
                  >
                    <Clipboard className="h-4 w-4" />
                  </button>
                  {showThinkingBudget ? (
                    <button
                      type="button"
                      onClick={handleThinkingBudgetClick}
                      title={
                        canSetThinkingBudget
                          ? `Thinking budget: ${activeBudgetLabel}`
                          : `Thinking budget: ${activeBudgetLabel} (not supported)`
                      }
                      aria-label={`Thinking budget: ${activeBudgetLabel}`}
                      disabled={!canSetThinkingBudget}
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
                      <span className="text-xs font-medium">{activeBudgetLabel}</span>
                    </button>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 rounded-md bg-background/90 text-muted-foreground hover:bg-background hover:text-foreground"
                    onClick={handleAttachClick}
                    disabled={!sessionId}
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    onClick={isRunning ? handleCancel : handleSend}
                    className="h-8 w-8 rounded-md"
                    disabled={!sessionId || (isRunning ? false : !canSend)}
                    variant={isRunning ? 'secondary' : 'default'}
                  >
                    {isRunning ? (
                      <Square className="h-4 w-4" />
                    ) : sessionStarting && !sessionId ? (
                      <Spinner size="sm" className="text-current" aria-hidden="true" />
                    ) : (
                      <ArrowUp className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
            {commandHint ? (
              <div className="text-xs text-muted-foreground">Hint: {commandHint}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AcpChatInterface;

async function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function readFileAsText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}
