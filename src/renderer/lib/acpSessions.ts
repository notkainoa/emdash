import { useMemo, useSyncExternalStore } from 'react';
import { extractCurrentModelId, extractModelsFromPayload } from '@shared/acpUtils';
import type { AcpConfigOption, AcpModel } from '@shared/types/acp';
import {
  type AcpHydratedState,
  type AcpMessageItem,
  type AcpMetaEnvelope,
  type AcpMetaType,
  type AcpPlanItem,
  type AcpToolItem,
  type ContentBlock,
  type FeedItem,
  type PermissionRequest,
  type ToolCall,
  type ToolCallContent,
  buildDiffPreview,
  getTailLines,
  truncateText,
  truncateToTailLines,
} from './acpChatUtils';
import { log } from './logger';
import { activityStore } from './activityStore';

type PromptCaps = {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
};

export type AcpSessionState = {
  taskId: string;
  providerId: string;
  sessionId: string | null;
  sessionStarting: boolean;
  sessionError: string | null;
  status: 'idle' | 'starting' | 'ready' | 'error' | 'exited';
  isRunning: boolean;
  runStartedAt: number | null;
  runElapsedMs: number;
  promptCaps: PromptCaps;
  configOptions: AcpConfigOption[];
  models: AcpModel[];
  currentModelId: string | null;
  feed: FeedItem[];
  toolCalls: Record<string, ToolCall>;
  permissions: Record<number, PermissionRequest>;
  terminalOutputs: Record<string, string>;
  plan: Array<{ content?: string; status?: string; priority?: string }> | null;
  historyReady: boolean;
  historyHasMessages: boolean;
};

type AcpSessionMeta = {
  hydrating: boolean;
  savedMessageIds: Set<string>;
  savedToolCallIds: Set<string>;
  lastSavedPlanHash: string | null;
  feedMeta: Record<string, { sequence: number; createdAt: string }>;
  sequence: number;
  lastAssistantMessageId: string | null;
};

type AcpSessionRecord = {
  key: string;
  state: AcpSessionState;
  meta: AcpSessionMeta;
  listeners: Set<() => void>;
};

type SessionKey = string;

type StartSessionArgs = {
  taskId: string;
  providerId: string;
  cwd: string;
};

type SendPromptArgs = {
  taskId: string;
  providerId: string;
  displayBlocks: ContentBlock[];
  promptBlocks: Array<{ type: string; [key: string]: any }>;
};

type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

const MAX_PERSISTED_BLOCKS = 40;
const MAX_PERSISTED_TEXT_CHARS = 4000;
const MAX_PERSISTED_RESOURCE_CHARS = 1200;
const MAX_PERSISTED_MESSAGE_CHARS = 12000;
const MAX_PERSISTED_TOOL_INPUT_CHARS = 4000;
const MAX_PERSISTED_TERMINAL_LINES = 120;
const LIVE_TERMINAL_LINES = 60;

const sessions = new Map<SessionKey, AcpSessionRecord>();
let subscribed = false;

const sessionKey = (taskId: string, providerId: string) => `${taskId}:${providerId}`;

const normalizePromptCaps = (caps: any): PromptCaps => ({
  image: Boolean(caps?.image ?? caps?.images ?? caps?.supportsImage ?? caps?.supportsImages),
  audio: Boolean(caps?.audio ?? caps?.supportsAudio ?? caps?.supportsAudioInput),
  embeddedContext: Boolean(
    caps?.embeddedContext ?? caps?.embedded_context ?? caps?.supportsEmbeddedContext
  ),
});

const optionMatchesConfigId = (option: AcpConfigOption, configId: string) => {
  const candidate =
    (option as any)?.id ??
    (option as any)?.key ??
    (option as any)?.configId ??
    (option as any)?.name ??
    (option as any)?.optionId ??
    (option as any)?.title;
  if (candidate === undefined || candidate === null) return false;
  return String(candidate) === configId;
};

const createEmptyState = (taskId: string, providerId: string): AcpSessionState => ({
  taskId,
  providerId,
  sessionId: null,
  sessionStarting: false,
  sessionError: null,
  status: 'idle',
  isRunning: false,
  runStartedAt: null,
  runElapsedMs: 0,
  promptCaps: {},
  configOptions: [],
  models: [],
  currentModelId: null,
  feed: [],
  toolCalls: {},
  permissions: {},
  terminalOutputs: {},
  plan: null,
  historyReady: false,
  historyHasMessages: false,
});

const createRecord = (taskId: string, providerId: string): AcpSessionRecord => {
  const key = sessionKey(taskId, providerId);
  return {
    key,
    state: createEmptyState(taskId, providerId),
    meta: {
      hydrating: false,
      savedMessageIds: new Set(),
      savedToolCallIds: new Set(),
      lastSavedPlanHash: null,
      feedMeta: {},
      sequence: 0,
      lastAssistantMessageId: null,
    },
    listeners: new Set(),
  };
};

const getOrCreateRecord = (taskId: string, providerId: string): AcpSessionRecord => {
  const key = sessionKey(taskId, providerId);
  const existing = sessions.get(key);
  if (existing) return existing;
  const record = createRecord(taskId, providerId);
  sessions.set(key, record);
  return record;
};

const emit = (record: AcpSessionRecord) => {
  for (const listener of record.listeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
};

const updateState = (
  record: AcpSessionRecord,
  updater: (state: AcpSessionState) => AcpSessionState
) => {
  const prev = record.state;
  const next = updater(prev);
  record.state = next;
  if (prev.isRunning !== next.isRunning) {
    activityStore.setTaskBusy(record.state.taskId, next.isRunning);
  }
  emit(record);
};

const ensureSubscribed = () => {
  if (subscribed) return;
  const api: any = (window as any).electronAPI;
  if (!api?.onAcpEvent) return;
  subscribed = true;
  api.onAcpEvent((payload: any) => {
    try {
      handleAcpEvent(payload);
    } catch (error) {
      log.warn?.('[acp] event handling failed', error);
    }
  });
};

const ensureFeedMeta = (
  record: AcpSessionRecord,
  id: string,
  overrides?: { sequence?: number; createdAt?: string }
) => {
  const existing = record.meta.feedMeta[id];
  if (existing) return existing;
  const createdAt = overrides?.createdAt ?? new Date().toISOString();
  const sequence = overrides?.sequence ?? record.meta.sequence++;
  const next = { sequence, createdAt };
  record.meta.feedMeta[id] = next;
  return next;
};

const safeJsonParse = (value?: string) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const sanitizeBlocks = (blocks: ContentBlock[]) => {
  const sanitized: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = block.text ? truncateText(String(block.text), MAX_PERSISTED_TEXT_CHARS) : '';
      if (text) sanitized.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'resource' || block.type === 'resource_link') {
      const resource = block.resource || {};
      const uri = (resource.uri as string | undefined) || block.uri;
      const name = resource.name || block.name;
      const title = resource.title || block.title;
      const description = resource.description || block.description;
      const mimeType = resource.mimeType || block.mimeType;
      const size = resource.size || block.size;
      if (block.type === 'resource') {
        const textValue = resource.text || block.text;
        const text = textValue
          ? truncateText(String(textValue), MAX_PERSISTED_RESOURCE_CHARS)
          : undefined;
        sanitized.push({
          type: 'resource',
          uri,
          name,
          title,
          description,
          mimeType,
          size,
          resource: {
            uri,
            name,
            title,
            description,
            mimeType,
            size,
            text,
          },
        });
      } else {
        sanitized.push({
          type: 'resource_link',
          uri,
          name,
          title,
          mimeType,
          size,
        });
      }
      continue;
    }
    if (block.type === 'image') {
      sanitized.push({
        type: 'text',
        text: '[image omitted]',
      });
    }
    if (block.type === 'audio') {
      sanitized.push({
        type: 'text',
        text: '[audio omitted]',
      });
    }
  }
  return sanitized.slice(0, MAX_PERSISTED_BLOCKS);
};

const sanitizeRawInput = (rawInput?: string) => {
  if (!rawInput) return undefined;
  const parsed = safeJsonParse(rawInput);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const allowedKeys = [
      'command',
      'args',
      'path',
      'filePath',
      'filepath',
      'query',
      'search',
      'input',
      'prompt',
    ];
    const subset: Record<string, any> = {};
    for (const key of allowedKeys) {
      if (parsed[key] !== undefined) subset[key] = parsed[key];
    }
    const serialized = JSON.stringify(subset, null, 2);
    return truncateText(serialized, MAX_PERSISTED_TOOL_INPUT_CHARS);
  }
  return truncateText(rawInput, MAX_PERSISTED_TOOL_INPUT_CHARS);
};

const buildPersistedContent = (blocks: ContentBlock[]) => {
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
  const text = parts.join('\n\n').trim();
  if (text) return truncateText(text, MAX_PERSISTED_MESSAGE_CHARS);
  const resourceLabel = blocks.find(
    (block) => block.type === 'resource' || block.type === 'resource_link'
  );
  if (!resourceLabel) return '';
  const label =
    resourceLabel.title ||
    resourceLabel.name ||
    resourceLabel.resource?.title ||
    resourceLabel.resource?.name ||
    resourceLabel.uri ||
    resourceLabel.resource?.uri ||
    'resource';
  return truncateText(`[attachment] ${label}`, MAX_PERSISTED_MESSAGE_CHARS);
};

const buildToolCallSnapshot = (record: AcpSessionRecord, toolCall: ToolCall): AcpToolItem => {
  const content: ToolCallContent[] = [];
  const diffItems = (toolCall.content?.filter((item) => item.type === 'diff') || []) as Array<{
    type: 'diff';
    path?: string;
    oldText?: string;
    newText?: string;
    original?: string;
    updated?: string;
    preview?: any;
  }>;
  diffItems.forEach((item) => {
    if (item.preview) {
      content.push({
        type: 'diff',
        path: item.path,
        preview: item.preview,
      });
      return;
    }
    const before = (item as any).oldText ?? (item as any).original ?? '';
    const after = (item as any).newText ?? (item as any).updated ?? '';
    const preview = buildDiffPreview(String(before ?? ''), String(after ?? ''));
    content.push({
      type: 'diff',
      path: item.path,
      preview,
    });
  });

  const contentBlocks =
    (toolCall.content?.filter((item) => item.type === 'content') as
      | Array<{ type: 'content'; content: ContentBlock }>
      | undefined) || [];
  const sanitizedBlocks = sanitizeBlocks(contentBlocks.map((item) => item.content)).slice(
    0,
    MAX_PERSISTED_BLOCKS
  );
  sanitizedBlocks.forEach((block) => {
    content.push({ type: 'content', content: block });
  });

  const terminalItems =
    (toolCall.content?.filter((item) => item.type === 'terminal') as
      | Array<{ type: 'terminal'; terminalId: string }>
      | undefined) || [];
  const terminalPreview: Array<{ terminalId: string; lines: string[]; truncated: boolean }> = [];
  const seenTerminalIds = new Set<string>();
  terminalItems.forEach((item) => {
    if (!item.terminalId || seenTerminalIds.has(item.terminalId)) return;
    seenTerminalIds.add(item.terminalId);
    content.push({ type: 'terminal', terminalId: item.terminalId });
    const output = record.state.terminalOutputs[item.terminalId] || '';
    const tail = getTailLines(output, MAX_PERSISTED_TERMINAL_LINES);
    terminalPreview.push({
      terminalId: item.terminalId,
      lines: tail.lines,
      truncated: tail.truncated,
    });
  });

  return {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    kind: toolCall.kind,
    status: toolCall.status,
    locations: toolCall.locations?.map((loc) => ({
      path: loc.path,
      line: loc.line,
    })),
    content,
    rawInput: sanitizeRawInput(toolCall.rawInput),
    terminalPreview: terminalPreview.length ? terminalPreview : undefined,
  };
};

const persistAcpMessage = async (
  record: AcpSessionRecord,
  args: {
    messageId: string;
    feedId: string;
    type: AcpMetaType;
    item: AcpMessageItem | AcpToolItem | AcpPlanItem;
    sender: 'user' | 'agent';
    content: string;
  }
) => {
  const api: any = (window as any).electronAPI;
  if (!api?.saveMessage) return;
  const meta = ensureFeedMeta(record, args.feedId);
  const payload: { acp: AcpMetaEnvelope['acp'] } = {
    acp: {
      version: 1,
      type: args.type,
      feedId: args.feedId,
      sequence: meta.sequence,
      createdAt: meta.createdAt,
      providerId: record.state.providerId,
      sessionId: record.state.sessionId ?? undefined,
      taskId: record.state.taskId,
      item: args.item,
    },
  };
  try {
    const conversationId = `conv-${record.state.taskId}-acp`;
    const res = await api.saveMessage({
      id: args.messageId,
      conversationId,
      content: args.content || '',
      sender: args.sender,
      metadata: payload,
    });
    if (!res?.success) {
      log.warn?.('[acp] persist message failed', res?.error);
    }
  } catch (error) {
    log.warn?.('[acp] persist message error', error);
  }
};

const persistMessages = (record: AcpSessionRecord) => {
  if (record.meta.hydrating) return;
  if (!record.state.feed.length) return;
  record.state.feed.forEach((item) => {
    if (item.type !== 'message') return;
    if (item.streaming) return;
    if (record.meta.savedMessageIds.has(item.id)) return;
    const blocks = sanitizeBlocks(item.blocks);
    if (!blocks.length) return;
    const content = buildPersistedContent(blocks);
    const messageId = `acp-${item.id}`;
    void persistAcpMessage(record, {
      messageId,
      feedId: item.id,
      type: 'message',
      item: {
        role: item.role,
        blocks,
        messageKind: item.messageKind,
        runDurationMs: item.runDurationMs,
      },
      sender: item.role === 'user' ? 'user' : 'agent',
      content,
    });
    record.meta.savedMessageIds.add(item.id);
  });
};

const persistToolCalls = (record: AcpSessionRecord) => {
  if (record.meta.hydrating) return;
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  Object.values(record.state.toolCalls).forEach((call) => {
    if (!call.toolCallId) return;
    if (!call.status || !terminalStatuses.has(call.status)) return;
    if (record.meta.savedToolCallIds.has(call.toolCallId)) return;
    const feedId = `tool-${call.toolCallId}`;
    ensureFeedMeta(record, feedId);
    const snapshot = buildToolCallSnapshot(record, call);
    const label = call.title || call.kind || 'Tool call';
    void persistAcpMessage(record, {
      messageId: `acp-tool-${call.toolCallId}`,
      feedId,
      type: 'tool',
      item: snapshot,
      sender: 'agent',
      content: label,
    });
    record.meta.savedToolCallIds.add(call.toolCallId);
  });
};

const maybePersistPlan = (
  record: AcpSessionRecord,
  entries: Array<{ content?: string; status?: string; priority?: string }>
) => {
  if (record.meta.hydrating) return;
  if (!entries?.length) return;
  const hash = JSON.stringify(entries);
  if (record.meta.lastSavedPlanHash === hash) return;
  record.meta.lastSavedPlanHash = hash;
  const feedId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  ensureFeedMeta(record, feedId);
  void persistAcpMessage(record, {
    messageId: `acp-${feedId}`,
    feedId,
    type: 'plan',
    item: { entries },
    sender: 'agent',
    content: 'Plan updated',
  });
};

const mergeBlocks = (base: ContentBlock[], incoming: ContentBlock[]) => {
  const next = [...base];
  for (const block of incoming) {
    if (block.type === 'text') {
      const last = next[next.length - 1];
      if (last && last.type === 'text') {
        last.text = (last.text || '') + (block.text || '');
      } else {
        next.push({ ...block });
      }
    } else {
      next.push({ ...block });
    }
  }
  return next;
};

const appendMessage = (
  record: AcpSessionRecord,
  role: 'user' | 'assistant' | 'system',
  blocks: ContentBlock[],
  options?: { streaming?: boolean; messageKind?: 'thought' | 'system' }
) => {
  if (!blocks.length) return;
  const streaming = options?.streaming ?? role === 'assistant';
  const messageKind = options?.messageKind;
  updateState(record, (prev) => {
    const last = prev.feed[prev.feed.length - 1];
    if (
      last &&
      last.type === 'message' &&
      last.role === role &&
      last.streaming &&
      last.messageKind === messageKind
    ) {
      const merged = mergeBlocks(last.blocks, blocks);
      const nextFeed = [...prev.feed];
      nextFeed[nextFeed.length - 1] = { ...last, blocks: merged };
      if (role === 'assistant' && messageKind !== 'thought') {
        record.meta.lastAssistantMessageId = last.id;
      }
      return { ...prev, feed: nextFeed };
    }
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    ensureFeedMeta(record, id);
    const newItem: FeedItem = {
      id,
      type: 'message',
      role,
      blocks,
      streaming,
      messageKind,
    };
    if (role === 'assistant' && messageKind !== 'thought') {
      record.meta.lastAssistantMessageId = newItem.id;
    }
    return { ...prev, feed: [...prev.feed, newItem] };
  });
  if (!streaming) {
    persistMessages(record);
  }
};

const normalizeRawValue = (value: any): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const handleConfigAndModelUpdates = (record: AcpSessionRecord, payload: any) => {
  if (!payload) return;
  let nextConfigOptions: AcpConfigOption[] | null = null;
  if (Array.isArray(payload.configOptions)) {
    nextConfigOptions = payload.configOptions;
  } else if (Array.isArray(payload.config_options)) {
    nextConfigOptions = payload.config_options;
  }
  const nextModels = extractModelsFromPayload(payload);
  const nextCurrentModelId = extractCurrentModelId(payload);
  if (
    nextConfigOptions?.length ||
    nextModels.length ||
    (nextCurrentModelId !== null && nextCurrentModelId !== undefined)
  ) {
    updateState(record, (prev) => ({
      ...prev,
      configOptions: nextConfigOptions ?? prev.configOptions,
      models: nextModels.length ? nextModels : prev.models,
      currentModelId: nextCurrentModelId ?? prev.currentModelId,
    }));
  }
};

const hydrateAcpHistory = (rows: any[]): AcpHydratedState => {
  const feedItems: FeedItem[] = [];
  const toolMap: Record<string, ToolCall> = {};
  const terminalMap: Record<string, string> = {};
  let latestPlan: AcpPlanItem | null = null;
  const savedMessageIds = new Set<string>();
  const savedToolIds = new Set<string>();
  const metaMap: Record<string, { sequence: number; createdAt: string }> = {};

  const parsed = rows
    .map((row) => {
      if (!row?.metadata) return null;
      try {
        const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        const acp = metadata?.acp;
        if (!acp || acp.version !== 1) return null;
        return { row, acp };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ row: any; acp: AcpMetaEnvelope['acp'] }>;

  parsed.sort((a, b) => {
    const aSeq = Number.isFinite(a.acp.sequence) ? a.acp.sequence : null;
    const bSeq = Number.isFinite(b.acp.sequence) ? b.acp.sequence : null;
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
    const aTime = Date.parse(a.row.timestamp || a.acp.createdAt || '') || 0;
    const bTime = Date.parse(b.row.timestamp || b.acp.createdAt || '') || 0;
    return aTime - bTime;
  });

  let nextSequence = 0;
  parsed.forEach(({ row, acp }) => {
    const feedId = acp.feedId || row.id;
    const createdAt = acp.createdAt || row.timestamp || new Date().toISOString();
    const sequence = Number.isFinite(acp.sequence) ? acp.sequence : nextSequence;
    nextSequence = Math.max(nextSequence, sequence + 1);
    metaMap[feedId] = { sequence, createdAt };

    if (acp.type === 'message') {
      const item = acp.item as AcpMessageItem;
      const blocks =
        Array.isArray(item?.blocks) && item.blocks.length
          ? item.blocks
          : row.content
            ? [{ type: 'text', text: String(row.content) }]
            : [];
      if (!blocks.length) return;
      const role = item?.role || (row.sender === 'user' ? 'user' : 'assistant');
      feedItems.push({
        id: feedId,
        type: 'message',
        role,
        blocks,
        streaming: false,
        messageKind: item?.messageKind,
        runDurationMs: item?.runDurationMs,
      });
      savedMessageIds.add(feedId);
      return;
    }
    if (acp.type === 'tool') {
      const item = acp.item as AcpToolItem;
      if (!item?.toolCallId) return;
      toolMap[item.toolCallId] = {
        toolCallId: item.toolCallId,
        title: item.title,
        kind: item.kind,
        status: item.status,
        locations: item.locations,
        content: item.content,
        rawInput: item.rawInput,
      };
      if (item.terminalPreview?.length) {
        item.terminalPreview.forEach((preview) => {
          terminalMap[preview.terminalId] = preview.lines.join('\n');
        });
      }
      if (
        !feedItems.some((entry) => entry.type === 'tool' && entry.toolCallId === item.toolCallId)
      ) {
        feedItems.push({ id: feedId, type: 'tool', toolCallId: item.toolCallId });
      }
      savedToolIds.add(item.toolCallId);
      return;
    }
    if (acp.type === 'plan') {
      const item = acp.item as AcpPlanItem;
      if (item?.entries?.length) {
        latestPlan = item;
      }
    }
  });

  const hasHistoryMessages = feedItems.some((item) => item.type === 'message');

  return {
    feedItems,
    toolMap,
    terminalMap,
    latestPlan,
    savedMessageIds,
    savedToolIds,
    metaMap,
    nextSequence,
    hasHistoryMessages,
  };
};

const handleSessionUpdate = (record: AcpSessionRecord, update: any) => {
  if (!update) return;
  const updateType = (update.sessionUpdate as string) || (update.type as string) || (update.kind as string);
  if (!updateType) return;
  handleConfigAndModelUpdates(record, update);
  if (
    updateType === 'config_option_update' ||
    updateType === 'config_options_update' ||
    updateType === 'model_update'
  ) {
    return;
  }

  if (
    updateType === 'agent_message_chunk' ||
    updateType === 'user_message_chunk' ||
    updateType === 'agent_message' ||
    updateType === 'user_message' ||
    updateType === 'thought_message' ||
    updateType === 'thought_message_chunk'
  ) {
    updateState(record, (prev) => ({ ...prev, sessionError: null }));
    const isThought = updateType.startsWith('thought');
    const role =
      updateType === 'agent_message_chunk' || updateType === 'agent_message'
        ? 'assistant'
        : isThought
          ? 'system'
          : 'user';
    const blocks = Array.isArray(update.content)
      ? (update.content as ContentBlock[])
      : update.content
        ? [update.content as ContentBlock]
        : [];
    appendMessage(record, role, blocks, {
      streaming: updateType.endsWith('_chunk'),
      messageKind: isThought ? 'thought' : role === 'system' ? 'system' : undefined,
    });
    return;
  }

  if (updateType === 'plan') {
    updateState(record, (prev) => ({ ...prev, sessionError: null }));
    const entries = Array.isArray(update.entries) ? update.entries : [];
    updateState(record, (prev) => {
      const existing = prev.feed.find((item) => item.type === 'plan');
      const planItem: FeedItem = { id: `plan-${Date.now()}`, type: 'plan', entries };
      const nextFeed: FeedItem[] = existing
        ? prev.feed.map((item) => (item.type === 'plan' ? { ...item, entries } : item))
        : [...prev.feed, planItem];
      return { ...prev, plan: entries, feed: nextFeed };
    });
    maybePersistPlan(record, entries);
    return;
  }

  if (updateType === 'tool_call' || updateType === 'tool_call_update') {
    updateState(record, (prev) => ({ ...prev, sessionError: null }));
    const payloadUpdate = update.toolCall ?? update;
    const toolCallId = payloadUpdate.toolCallId as string;
    if (!toolCallId) return;
    updateState(record, (prev) => {
      const existing = prev.toolCalls[toolCallId] || { toolCallId };
      let content = existing.content || [];
      if (Array.isArray(payloadUpdate.content)) {
        content = [...content, ...payloadUpdate.content];
      } else if (payloadUpdate.content) {
        content = [...content, payloadUpdate.content];
      }
      const rawInput = payloadUpdate.rawInput ?? payloadUpdate.input ?? undefined;
      const rawOutput = payloadUpdate.rawOutput ?? payloadUpdate.output ?? undefined;
      const nextCall: ToolCall = {
        ...existing,
        ...payloadUpdate,
        toolCallId,
        content,
        rawInput: rawInput === undefined ? existing.rawInput : normalizeRawValue(rawInput),
        rawOutput: rawOutput === undefined ? existing.rawOutput : normalizeRawValue(rawOutput),
      };
      const nextToolCalls = { ...prev.toolCalls, [toolCallId]: nextCall };
      const already = prev.feed.some((item) => item.type === 'tool' && item.toolCallId === toolCallId);
      if (already) {
        return { ...prev, toolCalls: nextToolCalls };
      }
      const feedId = `tool-${toolCallId}`;
      ensureFeedMeta(record, feedId);
      return {
        ...prev,
        toolCalls: nextToolCalls,
        feed: [...prev.feed, { id: feedId, type: 'tool', toolCallId }],
      };
    });
    persistToolCalls(record);
    return;
  }
};

const handlePromptEnd = (record: AcpSessionRecord, payload: any) => {
  const durationMs =
    record.state.runStartedAt !== null ? Date.now() - record.state.runStartedAt : record.state.runElapsedMs;
  updateState(record, (prev) => {
    const lastAssistantId = record.meta.lastAssistantMessageId;
    const nextFeed = prev.feed.map((item) => {
      if (item.type === 'message' && item.streaming) {
        return { ...item, streaming: false };
      }
      return item;
    });
    if (lastAssistantId && Number.isFinite(durationMs)) {
      const targetIndex = nextFeed.findIndex(
        (item) => item.type === 'message' && item.id === lastAssistantId
      );
      if (targetIndex >= 0) {
        const target = nextFeed[targetIndex];
        if (target.type === 'message') {
          nextFeed[targetIndex] = { ...target, runDurationMs: durationMs };
        }
      }
    }
    return {
      ...prev,
      isRunning: false,
      runStartedAt: null,
      runElapsedMs: durationMs,
      feed: nextFeed,
    };
  });
  record.meta.lastAssistantMessageId = null;
  if (payload?.stopReason) {
    const stopReason = String(payload.stopReason).trim();
    if (stopReason && stopReason !== 'end_turn') {
      const stopId = `stop-${Date.now()}`;
      ensureFeedMeta(record, stopId);
      updateState(record, (prev) => ({
        ...prev,
        feed: [
          ...prev.feed,
          {
            id: stopId,
            type: 'message',
            role: 'system',
            blocks: [{ type: 'text', text: `Stopped: ${stopReason}` }],
          },
        ],
      }));
    }
  }
  persistMessages(record);
};

const handleAcpEvent = (payload: any) => {
  if (!payload) return;
  const taskId = payload.taskId as string;
  const providerId = payload.providerId as string;
  if (!taskId || !providerId) return;
  const record = getOrCreateRecord(taskId, providerId);

  if (payload.type === 'session_started') {
    updateState(record, (prev) => ({
      ...prev,
      sessionError: null,
      sessionStarting: false,
      status: 'ready',
      sessionId: payload.sessionId || prev.sessionId,
    }));
    const caps =
      payload.agentCapabilities?.promptCapabilities ??
      payload.agentCapabilities?.prompt ??
      payload.agentCapabilities?.prompt_caps;
    if (caps) {
      updateState(record, (prev) => ({ ...prev, promptCaps: normalizePromptCaps(caps) }));
    }
    handleConfigAndModelUpdates(record, payload);
    return;
  }

  if (payload.type === 'session_error') {
    updateState(record, (prev) => ({
      ...prev,
      sessionError: payload.error || 'ACP session error',
      sessionStarting: false,
      status: 'error',
      isRunning: false,
      runStartedAt: null,
    }));
    return;
  }

  if (payload.type === 'session_exit') {
    updateState(record, (prev) => ({
      ...prev,
      isRunning: false,
      runStartedAt: null,
      sessionId: null,
      sessionStarting: false,
      status: 'exited',
      sessionError: prev.sessionError ?? 'ACP session ended.',
    }));
    return;
  }

  if (payload.type === 'prompt_end') {
    handlePromptEnd(record, payload);
    return;
  }

  if (payload.type === 'terminal_output') {
    const terminalId = payload.terminalId as string;
    const chunk = String(payload.chunk ?? '');
    if (!terminalId || !chunk) return;
    updateState(record, (prev) => ({
      ...prev,
      sessionError: null,
      terminalOutputs: {
        ...prev.terminalOutputs,
        [terminalId]: truncateToTailLines((prev.terminalOutputs[terminalId] || '') + chunk, LIVE_TERMINAL_LINES),
      },
    }));
    return;
  }

  if (payload.type === 'session_update') {
    handleSessionUpdate(record, payload.update);
    return;
  }

  if (payload.type === 'permission_request') {
    const requestId = payload.requestId as number;
    if (!requestId) return;
    const toolCall = payload.params?.toolCall as ToolCall | undefined;
    const options = Array.isArray(payload.params?.options)
      ? payload.params.options.map((opt: any) => ({
          id: String(opt.optionId ?? opt.id ?? ''),
          label: String(opt.name ?? opt.label ?? opt.title ?? opt.optionId ?? 'Allow'),
          kind: opt.kind,
        }))
      : [];
    updateState(record, (prev) => ({
      ...prev,
      permissions: { ...prev.permissions, [requestId]: { requestId, toolCall, options } },
      feed: [...prev.feed, { id: `perm-${requestId}`, type: 'permission', requestId }],
    }));
    return;
  }
};

const startSession = async (args: StartSessionArgs) => {
  ensureSubscribed();
  const record = getOrCreateRecord(args.taskId, args.providerId);
  if (record.state.sessionStarting || record.state.status === 'ready') {
    return { success: true, sessionId: record.state.sessionId ?? undefined };
  }
  updateState(record, (prev) => ({
    ...prev,
    sessionStarting: true,
    sessionError: null,
    status: 'starting',
  }));
  const api: any = (window as any).electronAPI;
  try {
    const res = await api.acpStartSession({
      taskId: args.taskId,
      providerId: args.providerId,
      cwd: args.cwd,
    });
    if (!res?.success || !res.sessionId) {
      updateState(record, (prev) => ({
        ...prev,
        sessionStarting: false,
        sessionError: res?.error || 'Failed to start ACP session.',
        status: 'error',
      }));
      return { success: false, error: res?.error || 'Failed to start ACP session.' };
    }
    updateState(record, (prev) => ({
      ...prev,
      sessionId: res.sessionId,
      sessionStarting: false,
      status: 'ready',
    }));
    return { success: true, sessionId: res.sessionId };
  } catch (error: any) {
    updateState(record, (prev) => ({
      ...prev,
      sessionStarting: false,
      sessionError: error?.message || String(error),
      status: 'error',
    }));
    return { success: false, error: error?.message || String(error) };
  }
};

const hydrateHistory = async (taskId: string, providerId: string) => {
  ensureSubscribed();
  const record = getOrCreateRecord(taskId, providerId);
  if (record.meta.hydrating || record.state.historyReady) return;
  record.meta.hydrating = true;
  updateState(record, (prev) => ({
    ...prev,
    historyReady: false,
    historyHasMessages: false,
  }));
  const api: any = (window as any).electronAPI;
  try {
    const conversationId = `conv-${taskId}-acp`;
    await api?.saveConversation?.({
      id: conversationId,
      taskId,
      title: 'ACP Chat',
    });
    const res = await api?.getMessages?.(conversationId);
    if (res?.success && Array.isArray(res.messages) && res.messages.length) {
      const hydrated = hydrateAcpHistory(res.messages);
      record.meta.feedMeta = hydrated.metaMap;
      record.meta.sequence = hydrated.nextSequence;
      record.meta.savedMessageIds = hydrated.savedMessageIds;
      record.meta.savedToolCallIds = hydrated.savedToolIds;
      record.meta.lastSavedPlanHash = hydrated.latestPlan?.entries?.length
        ? JSON.stringify(hydrated.latestPlan.entries)
        : null;
      updateState(record, (prev) => ({
        ...prev,
        feed: hydrated.feedItems,
        toolCalls: hydrated.toolMap,
        terminalOutputs: hydrated.terminalMap,
        plan: hydrated.latestPlan?.entries?.length ? hydrated.latestPlan.entries : null,
        historyHasMessages: hydrated.hasHistoryMessages,
      }));
    }
  } catch (error) {
    log.warn?.('[acp] hydrate history failed', error);
  } finally {
    record.meta.hydrating = false;
    updateState(record, (prev) => ({
      ...prev,
      historyReady: true,
    }));
  }
};

const sendPrompt = async (args: SendPromptArgs) => {
  const record = getOrCreateRecord(args.taskId, args.providerId);
  if (!record.state.sessionId) {
    return { success: false, error: 'Session not ready' };
  }
  if (!args.displayBlocks.length) {
    return { success: false, error: 'Empty prompt' };
  }
  appendMessage(record, 'user', args.displayBlocks);
  record.meta.lastAssistantMessageId = null;
  updateState(record, (prev) => ({
    ...prev,
    isRunning: true,
    runStartedAt: Date.now(),
    runElapsedMs: 0,
  }));
  const api: any = (window as any).electronAPI;
  const res = await api.acpSendPrompt({
    sessionId: record.state.sessionId,
    prompt: args.promptBlocks,
  });
  if (!res?.success) {
    updateState(record, (prev) => ({
      ...prev,
      sessionError: res?.error || 'Failed to send prompt.',
      isRunning: false,
      runStartedAt: null,
      runElapsedMs: 0,
    }));
  }
  return res;
};

const cancelSession = async (taskId: string, providerId: string) => {
  const record = getOrCreateRecord(taskId, providerId);
  if (!record.state.sessionId) return;
  const api: any = (window as any).electronAPI;
  try {
    await api.acpCancel({ sessionId: record.state.sessionId });
  } catch {}
  updateState(record, (prev) => ({
    ...prev,
    isRunning: false,
    runStartedAt: null,
  }));
  updateState(record, (prev) => {
    const nextCalls: Record<string, ToolCall> = {};
    for (const [id, call] of Object.entries(prev.toolCalls)) {
      if (call.status && ['completed', 'failed', 'cancelled'].includes(call.status)) {
        nextCalls[id] = call;
      } else {
        nextCalls[id] = { ...call, status: 'cancelled' };
      }
    }
    return { ...prev, toolCalls: nextCalls };
  });
  persistToolCalls(record);
  const pending = Object.keys(record.state.permissions).map((id) => Number(id));
  if (pending.length) {
    await Promise.all(
      pending.map((requestId) =>
        api.acpRespondPermission({
          sessionId: record.state.sessionId,
          requestId,
          outcome: { outcome: 'cancelled' },
        })
      )
    );
    updateState(record, (prev) => ({
      ...prev,
      permissions: {},
      feed: prev.feed.filter((item) => item.type !== 'permission'),
    }));
  }
};

const respondPermission = async (
  taskId: string,
  providerId: string,
  requestId: number,
  outcome: PermissionOutcome
) => {
  const record = getOrCreateRecord(taskId, providerId);
  if (!record.state.sessionId) return;
  const api: any = (window as any).electronAPI;
  await api.acpRespondPermission({ sessionId: record.state.sessionId, requestId, outcome });
  updateState(record, (prev) => {
    const next = { ...prev.permissions };
    delete next[requestId];
    return {
      ...prev,
      permissions: next,
      feed: prev.feed.filter(
        (item) => !(item.type === 'permission' && item.requestId === requestId)
      ),
    };
  });
};

const disposeSession = async (taskId: string, providerId: string) => {
  const record = getOrCreateRecord(taskId, providerId);
  if (record.state.sessionId) {
    const api: any = (window as any).electronAPI;
    try {
      await api.acpDispose({ sessionId: record.state.sessionId });
    } catch {}
  }
  updateState(record, (prev) => ({
    ...prev,
    sessionId: null,
    status: 'idle',
    sessionStarting: false,
    isRunning: false,
    runStartedAt: null,
  }));
};

const restartSession = async (taskId: string, providerId: string, cwd: string) => {
  await disposeSession(taskId, providerId);
  return startSession({ taskId, providerId, cwd });
};

const clearSessionError = (taskId: string, providerId: string) => {
  const record = getOrCreateRecord(taskId, providerId);
  if (!record.state.sessionError) return;
  updateState(record, (prev) => ({ ...prev, sessionError: null }));
};

const setModel = async (
  taskId: string,
  providerId: string,
  modelId: string,
  opts?: { optimistic?: boolean }
) => {
  const record = getOrCreateRecord(taskId, providerId);
  if (!record.state.sessionId || !modelId) return { success: false, error: 'Session not ready' };
  if (opts?.optimistic) {
    updateState(record, (prev) => ({ ...prev, currentModelId: modelId }));
  }
  const api: any = (window as any).electronAPI;
  return api.acpSetModel({ sessionId: record.state.sessionId, modelId });
};

const setConfigOption = async (
  taskId: string,
  providerId: string,
  configId: string,
  value: unknown,
  opts?: { optimistic?: boolean }
) => {
  const record = getOrCreateRecord(taskId, providerId);
  if (!record.state.sessionId || !configId) return { success: false, error: 'Session not ready' };
  if (opts?.optimistic) {
    updateState(record, (prev) => ({
      ...prev,
      configOptions: prev.configOptions.map((option) =>
        optionMatchesConfigId(option, configId)
          ? { ...option, value, currentValue: value }
          : option
      ),
    }));
  }
  const api: any = (window as any).electronAPI;
  return api.acpSetConfigOption({ sessionId: record.state.sessionId, configId, value });
};

const setMode = async (taskId: string, providerId: string, modeId: string) => {
  const record = getOrCreateRecord(taskId, providerId);
  if (!record.state.sessionId || !modeId) return { success: false, error: 'Session not ready' };
  const api: any = (window as any).electronAPI;
  return api.acpSetMode({ sessionId: record.state.sessionId, modeId });
};

const subscribe = (taskId: string, providerId: string, listener: () => void) => {
  ensureSubscribed();
  const record = getOrCreateRecord(taskId, providerId);
  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
  };
};

const getSnapshot = (taskId: string, providerId: string): AcpSessionState => {
  const record = getOrCreateRecord(taskId, providerId);
  return record.state;
};

export function useAcpSession(taskId: string, providerId: string) {
  const snapshot = useSyncExternalStore(
    (listener) => subscribe(taskId, providerId, listener),
    () => getSnapshot(taskId, providerId),
    () => getSnapshot(taskId, providerId)
  );

  const actions = useMemo(
    () => ({
      ensureHistory: () => hydrateHistory(taskId, providerId),
      ensureSession: (cwd: string) => startSession({ taskId, providerId, cwd }),
      restartSession: (cwd: string) => restartSession(taskId, providerId, cwd),
      sendPrompt: (displayBlocks: ContentBlock[], promptBlocks: Array<{ type: string; [k: string]: any }>) =>
        sendPrompt({ taskId, providerId, displayBlocks, promptBlocks }),
      cancelSession: () => cancelSession(taskId, providerId),
      respondPermission: (requestId: number, outcome: PermissionOutcome) =>
        respondPermission(taskId, providerId, requestId, outcome),
      disposeSession: () => disposeSession(taskId, providerId),
      clearSessionError: () => clearSessionError(taskId, providerId),
      setModel: (modelId: string, opts?: { optimistic?: boolean }) =>
        setModel(taskId, providerId, modelId, opts),
      setConfigOption: (configId: string, value: unknown, opts?: { optimistic?: boolean }) =>
        setConfigOption(taskId, providerId, configId, value, opts),
      setMode: (modeId: string) => setMode(taskId, providerId, modeId),
    }),
    [taskId, providerId]
  );

  return { state: snapshot, actions };
}

export const disposeAcpSessionsForTask = async (taskId: string) => {
  const matches = Array.from(sessions.values()).filter((record) => record.state.taskId === taskId);
  await Promise.all(matches.map((record) => disposeSession(record.state.taskId, record.state.providerId)));
};

export const getAcpSessionState = (taskId: string, providerId: string) =>
  getSnapshot(taskId, providerId);
