import { useCallback, useMemo, useState } from 'react';
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
function detectMentionTrigger(
  input: string,
  cursorPosition: number
): MentionState {
  const textBeforeCursor = input.slice(0, cursorPosition);

  // Match @ at start of word: (start of string or after whitespace) + @ + path
  const match = textBeforeCursor.match(/(?:^|\s)@([/\w\-.]*)$/);

  if (!match) {
    return { active: false };
  }

  // Calculate where the @ symbol starts
  const startIndex = cursorPosition - match[0].length;
  const query = match[1] || '';

  return { active: true, query, startIndex };
}

/**
 * Filter items based on path query.
 * - Empty query: show top-level items
 * - Path query: show items starting with that path
 */
function filterByPath(items: Item[], query: string, limit = 100): Item[] {
  if (!query) {
    // Show top-level items only (no path separators)
    return items
      .filter((item) => !item.path.includes('/'))
      .slice(0, limit);
  }

  const normalizedQuery = query.toLowerCase();

  // Filter items that start with the query path
  // For directories, also include their direct children
  const filtered = items.filter((item) => {
    const itemPath = item.path.toLowerCase();

    // Exact prefix match
    if (itemPath.startsWith(normalizedQuery)) {
      // If query ends with /, show children (but not the directory itself unless it's a direct match)
      if (normalizedQuery.endsWith('/')) {
        return itemPath.startsWith(normalizedQuery);
      }
      // Otherwise show matches that either are the path itself or are prefixed by the path + /
      return (
        itemPath === normalizedQuery ||
        itemPath.startsWith(normalizedQuery + '/')
      );
    }

    return false;
  });

  // Sort: directories first, then by path length, then alphabetically
  return filtered
    .sort((a, b) => {
      // Directories first
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;

      // Then by path length (shorter first)
      const aLen = a.path.length;
      const bLen = b.path.length;
      if (aLen !== bLen) return aLen - bLen;

      // Then alphabetically
      return a.path.localeCompare(b.path);
    })
    .slice(0, limit);
}

/**
 * Get the display name for an item.
 * For nested paths, show just the last segment.
 */
function getDisplayName(item: Item, query: string): string {
  if (!query) return item.path;

  // If query contains /, show the relative path from query
  if (query.includes('/')) {
    const base = query.endsWith('/') ? query : query + '/';
    if (item.path.startsWith(base)) {
      return item.path.slice(base.length);
    }
  }

  return item.path;
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
  const { items, loading } = useFileIndex(rootPath);

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Detect mention trigger
  const trigger = useMemo<MentionState>(
    () => detectMentionTrigger(input, cursorPosition),
    [input, cursorPosition]
  );

  // Filter items based on query
  const filteredItems = useMemo<Item[]>(() => {
    if (!trigger.active) return [];
    return filterByPath(items, trigger.query, 100);
  }, [items, trigger]);

  // Reset selected index when filtered items change
  const maxIndex = Math.max(0, filteredItems.length - 1);
  const boundedSelectedIndex = Math.min(selectedIndex, maxIndex);

  // Actions
  const selectItem = useCallback(
    (index: number) => {
      const item = filteredItems[index];
      if (!item || !trigger.active) return;

      const endIndex = cursorPosition;
      const filePath = item.path;

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
