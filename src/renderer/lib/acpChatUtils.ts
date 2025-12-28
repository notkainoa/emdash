export type ContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  name?: string;
  uri?: string;
  description?: string;
  title?: string;
  size?: number;
  resource?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    name?: string;
    title?: string;
    description?: string;
    size?: number;
  };
};

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path?: string; oldText?: string; newText?: string; preview?: DiffPreview }
  | { type: 'terminal'; terminalId: string };

export type ToolCall = {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: Array<{ path: string; line?: number }>;
  content?: ToolCallContent[];
  rawInput?: string;
  rawOutput?: string;
};

export type DiffPreviewLine = { type: 'context' | 'add' | 'del'; text: string };
export type DiffPreview = {
  path?: string;
  lines: DiffPreviewLine[];
  additions: number;
  deletions: number;
  truncated: boolean;
};

export type FeedItem =
  | {
      id: string;
      type: 'message';
      role: 'user' | 'assistant' | 'system';
      blocks: ContentBlock[];
      streaming?: boolean;
      messageKind?: 'thought' | 'system';
      runDurationMs?: number;
    }
  | { id: string; type: 'tool'; toolCallId: string }
  | {
      id: string;
      type: 'plan';
      entries: Array<{ content?: string; status?: string; priority?: string }>;
    }
  | { id: string; type: 'permission'; requestId: number };

export type AcpMetaType = 'message' | 'tool' | 'plan';

export type AcpMessageItem = {
  role: 'user' | 'assistant' | 'system';
  blocks: ContentBlock[];
  messageKind?: 'thought' | 'system';
  runDurationMs?: number;
};

export type AcpToolItem = {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: Array<{ path: string; line?: number }>;
  content?: ToolCallContent[];
  rawInput?: string;
  terminalPreview?: Array<{ terminalId: string; lines: string[]; truncated: boolean }>;
};

export type AcpPlanItem = {
  entries: Array<{ content?: string; status?: string; priority?: string }>;
};

export type AcpMetaEnvelope = {
  acp: {
    version: 1;
    type: AcpMetaType;
    feedId: string;
    sequence: number;
    createdAt: string;
    providerId?: string;
    sessionId?: string;
    taskId?: string;
    item: AcpMessageItem | AcpToolItem | AcpPlanItem;
  };
};

export type AcpHydratedState = {
  feedItems: FeedItem[];
  toolMap: Record<string, ToolCall>;
  terminalMap: Record<string, string>;
  latestPlan: AcpPlanItem | null;
  savedMessageIds: Set<string>;
  savedToolIds: Set<string>;
  metaMap: Record<string, { sequence: number; createdAt: string }>;
  nextSequence: number;
  hasHistoryMessages: boolean;
};

export type PermissionRequest = {
  requestId: number;
  toolCall?: ToolCall;
  options?: Array<{ id: string; label: string; kind?: string }>;
};

const DEFAULT_TRUNCATE_LIMIT = 120;
const DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_PREVIEW_LINES = 80;
const MAX_DIFF_SOURCE_LINES = 400;

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n');

export const splitLines = (text: string) => normalizeNewlines(text).split('\n');

export const truncateText = (text: string, limit: number = DEFAULT_TRUNCATE_LIMIT) => {
  if (!text) return text;
  if (text.length <= limit) return text;
  const clipped = Math.max(0, limit - 3);
  return text.slice(0, clipped) + '...';
};

const commonPrefixLength = (a: string[], b: string[]) => {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i += 1;
  return i;
};

const commonSuffixLength = (a: string[], b: string[], prefix: number) => {
  const maxLen = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < maxLen && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
};

const estimateLineChanges = (oldLines: string[], newLines: string[]) => {
  const prefix = commonPrefixLength(oldLines, newLines);
  const suffix = commonSuffixLength(oldLines, newLines, prefix);
  const removed = Math.max(0, oldLines.length - prefix - suffix);
  const added = Math.max(0, newLines.length - prefix - suffix);
  return { additions: added, deletions: removed };
};

const myersDiff = (oldLines: string[], newLines: string[]): DiffPreviewLine[] => {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  const offset = max;
  const v = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d += 1) {
    const vCopy = v.slice();
    trace.push(vCopy);
    for (let k = -d; k <= d; k += 2) {
      const kIndex = k + offset;
      let x: number;
      if (k === -d || (k !== d && v[kIndex - 1] < v[kIndex + 1])) {
        x = v[kIndex + 1];
      } else {
        x = v[kIndex - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[kIndex] = x;
      if (x >= n && y >= m) {
        const result: DiffPreviewLine[] = [];
        let prevX = n;
        let prevY = m;
        for (let dBack = d; dBack >= 0; dBack -= 1) {
          const vBack = trace[dBack];
          const kBack = prevX - prevY;
          const kIdx = kBack + offset;
          let xStart: number;
          if (kBack === -dBack || (kBack !== dBack && vBack[kIdx - 1] < vBack[kIdx + 1])) {
            xStart = vBack[kIdx + 1];
          } else {
            xStart = vBack[kIdx - 1] + 1;
          }
          const yStart = xStart - kBack;
          while (prevX > xStart && prevY > yStart) {
            result.push({ type: 'context', text: oldLines[prevX - 1] });
            prevX -= 1;
            prevY -= 1;
          }
          if (dBack === 0) break;
          if (prevX === xStart) {
            result.push({ type: 'add', text: newLines[prevY - 1] });
            prevY -= 1;
          } else {
            result.push({ type: 'del', text: oldLines[prevX - 1] });
            prevX -= 1;
          }
        }
        return result.reverse();
      }
    }
  }
  return [];
};

const buildFallbackDiffLines = (
  oldLines: string[],
  newLines: string[],
  context: number
): DiffPreviewLine[] => {
  const prefix = commonPrefixLength(oldLines, newLines);
  const suffix = commonSuffixLength(oldLines, newLines, prefix);
  const beforeStart = Math.max(0, prefix - context);
  const before = oldLines.slice(beforeStart, prefix);
  const afterStart = Math.max(prefix, oldLines.length - suffix);
  const afterEnd = Math.min(oldLines.length, afterStart + context);
  const after = oldLines.slice(afterStart, afterEnd);
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);

  return [
    ...before.map((text) => ({ type: 'context' as const, text })),
    ...removed.map((text) => ({ type: 'del' as const, text })),
    ...added.map((text) => ({ type: 'add' as const, text })),
    ...after.map((text) => ({ type: 'context' as const, text })),
  ];
};

const trimDiffLines = (
  lines: DiffPreviewLine[],
  maxLines: number,
  context: number
): { lines: DiffPreviewLine[]; truncated: boolean } => {
  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }
  const changeIndexes = lines
    .map((line, idx) => (line.type === 'context' ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (changeIndexes.length === 0) {
    return { lines: lines.slice(0, maxLines), truncated: true };
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIndexes) {
    const start = Math.max(0, idx - context);
    const end = Math.min(lines.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const total = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
  const output: DiffPreviewLine[] = [];

  if (total <= maxLines) {
    ranges.forEach((range, idx) => {
      if (idx > 0) output.push({ type: 'context', text: '...' });
      output.push(...lines.slice(range.start, range.end + 1));
    });
    return { lines: output, truncated: total < lines.length };
  }

  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first.start === last.start && first.end === last.end) {
    return { lines: lines.slice(first.start, first.end + 1), truncated: true };
  }
  const half = Math.max(4, Math.floor((maxLines - 1) / 2));
  let firstSlice = lines.slice(first.start, first.end + 1);
  let lastSlice = lines.slice(last.start, last.end + 1);
  if (firstSlice.length > half) firstSlice = firstSlice.slice(0, half);
  if (lastSlice.length > half) lastSlice = lastSlice.slice(lastSlice.length - half);
  return {
    lines: [...firstSlice, { type: 'context', text: '...' }, ...lastSlice],
    truncated: true,
  };
};

export const buildDiffPreview = (oldText: string, newText: string): DiffPreview => {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const useFallback = oldLines.length + newLines.length > MAX_DIFF_SOURCE_LINES * 2;
  const diffLines = useFallback
    ? buildFallbackDiffLines(oldLines, newLines, DIFF_CONTEXT_LINES)
    : myersDiff(oldLines, newLines);
  const { additions, deletions } = useFallback
    ? estimateLineChanges(oldLines, newLines)
    : diffLines.reduce(
        (acc, line) => {
          if (line.type === 'add') acc.additions += 1;
          if (line.type === 'del') acc.deletions += 1;
          return acc;
        },
        { additions: 0, deletions: 0 }
      );
  const trimmed = trimDiffLines(diffLines, MAX_DIFF_PREVIEW_LINES, DIFF_CONTEXT_LINES);
  return {
    lines: trimmed.lines,
    additions,
    deletions,
    truncated: trimmed.truncated,
  };
};

export const getTailLines = (text: string, maxLines: number) => {
  const lines = splitLines(text);
  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }
  return { lines: lines.slice(lines.length - maxLines), truncated: true };
};

// Truncate text to last N lines to prevent unbounded state growth.
// Uses a buffer (maxLines + 10) to avoid truncating on every chunk.
export const truncateToTailLines = (text: string, maxLines: number): string => {
  const lines = splitLines(text);
  if (lines.length <= maxLines) {
    return text;
  }
  const buffer = 10;
  const limit = maxLines + buffer;
  if (lines.length <= limit) {
    return text;
  }
  return lines.slice(lines.length - maxLines).join('\n');
};
