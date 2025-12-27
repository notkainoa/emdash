import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFileIndex } from './useFileIndex';

type Item = { path: string; type: 'file' | 'dir' };

type MentionTrigger = {
  active: true;
  query: string;
  startIndex: number;
};

type MentionState = MentionTrigger | { active: false };

type UseFileMentionsProps = {
  input: string;
  cursorPosition: number;
  rootPath: string | undefined;
  onSelect: (filePath: string, startIndex: number, endIndex: number) => void;
};

/**
 * Detect if the cursor is in a mention context.
 * Only triggers when @ is at start of word (after space or start of input).
 */
export function detectMentionTrigger(
  input: string,
  cursorPosition: number
): MentionState {
  const textBeforeCursor = input.slice(0, cursorPosition);

  // Match @ at start of word: (start of string or after whitespace) + @ + path
  const match = textBeforeCursor.match(/(?:^|\s)@([/\w\-.]*)$/);

  if (!match) {
    return { active: false };
  }

  const query = match[1] || '';
  // Calculate where the @ symbol starts (avoid consuming the leading whitespace from match[0])
  const startIndex = Math.max(0, cursorPosition - (query.length + 1));

  return { active: true, query, startIndex };
}

/**
 * Filter items based on path query.
 * - Empty query: show top-level items
 * - Path query: show items starting with that path
 */
export function filterByPath(items: Item[], query: string, limit = 100): Item[] {
  const normalizedQuery = query.replace(/\\/g, '/');
  const lastSlash = normalizedQuery.lastIndexOf('/');
  const dirPrefix = lastSlash >= 0 ? normalizedQuery.slice(0, lastSlash + 1) : '';
  const namePrefix = lastSlash >= 0 ? normalizedQuery.slice(lastSlash + 1) : normalizedQuery;

  const dirPrefixLower = dirPrefix.toLowerCase();
  const namePrefixLower = namePrefix.toLowerCase();

  const filtered = items.filter((item) => {
    const itemPath = item.path.replace(/\\/g, '/');
    const itemLower = itemPath.toLowerCase();
    if (!itemLower.startsWith(dirPrefixLower)) return false;

    const remainder = itemPath.slice(dirPrefix.length);
    if (!remainder) return false;

    // Only show direct children in the current "directory" prefix.
    if (remainder.includes('/')) return false;

    if (!namePrefixLower) return true;
    return remainder.toLowerCase().startsWith(namePrefixLower);
  });

  // Sort: directories first, then alphabetically within the directory prefix.
  return filtered
    .sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;

      const aName = a.path.replace(/\\/g, '/').slice(dirPrefix.length);
      const bName = b.path.replace(/\\/g, '/').slice(dirPrefix.length);
      return aName.localeCompare(bName);
    })
    .slice(0, limit);
}

/**
 * Get the display name for an item.
 * For nested paths, show just the last segment.
 */
export function getDisplayName(item: Item, query: string): string {
  const normalizedQuery = query.replace(/\\/g, '/');
  const lastSlash = normalizedQuery.lastIndexOf('/');
  const dirPrefix = lastSlash >= 0 ? normalizedQuery.slice(0, lastSlash + 1) : '';
  if (!dirPrefix) return item.path;

  const itemPath = item.path.replace(/\\/g, '/');
  if (itemPath.toLowerCase().startsWith(dirPrefix.toLowerCase())) {
    return itemPath.slice(dirPrefix.length);
  }

  return itemPath;
}

/**
 * Hook for managing file mention autocomplete.
 *
 * Features:
 * - Detects @ trigger based on cursor position
 * - Filters files by path query
 * - Manages dropdown state (open/closed, selected index)
 * - Handles keyboard navigation
 * - Calls onSelect when user selects a file
 */
export function useFileMentions({
  input,
  cursorPosition,
  rootPath,
  onSelect,
}: UseFileMentionsProps) {
  // Detect mention trigger
  const trigger = useMemo<MentionState>(
    () => detectMentionTrigger(input, cursorPosition),
    [input, cursorPosition]
  );

  // Lazy-load the file index only when the user is actively in a mention context.
  const { items, loading } = useFileIndex(trigger.active ? rootPath : undefined);

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter items based on query
  const filteredItems = useMemo<Item[]>(() => {
    if (!trigger.active) return [];
    return filterByPath(items, trigger.query, 100);
  }, [items, trigger]);

  const activeQuery = trigger.active ? trigger.query : null;

  // Reset selected index when query changes (keeps navigation predictable)
  useEffect(() => {
    if (activeQuery === null) return;
    setSelectedIndex(0);
  }, [activeQuery]);

  // Bound selected index to the available items
  const maxIndex = Math.max(0, filteredItems.length - 1);
  const boundedSelectedIndex = Math.min(selectedIndex, maxIndex);

  // Actions
  const selectItem = useCallback(
    (index: number) => {
      const item = filteredItems[index];
      if (!item || !trigger.active) return;

      const endIndex = cursorPosition;
      const normalizedPath = item.path.replace(/\\/g, '/');
      const filePath = item.type === 'dir' ? `${normalizedPath}/` : normalizedPath;

      onSelect(filePath, trigger.startIndex, endIndex);
      setSelectedIndex(0);
    },
    [filteredItems, trigger, cursorPosition, onSelect]
  );

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) =>
      prev >= maxIndex ? 0 : prev + 1
    );
  }, [maxIndex]);

  const selectPrevious = useCallback(() => {
    setSelectedIndex((prev) =>
      prev <= 0 ? maxIndex : prev - 1
    );
  }, [maxIndex]);

  return {
    active: trigger.active,
    query: trigger.active ? trigger.query : '',
    items: filteredItems,
    loading,
    selectedIndex: boundedSelectedIndex,
    setSelectedIndex,
    selectItem,
    selectNext,
    selectPrevious,
    getDisplayName,
  };
}

export type { Item, MentionState, UseFileMentionsProps };
