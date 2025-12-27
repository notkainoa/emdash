import React, { useEffect, useRef } from 'react';
import { FileText, Folder } from 'lucide-react';
import type { Item } from '../hooks/useFileMentions';

type FileMentionDropdownProps = {
  items: Item[];
  query: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  getDisplayName: (item: Item, query: string) => string;
};

/**
 * Dropdown component for file mention autocomplete.
 *
 * Features:
 * - Shows file/folder items with icons
 * - Highlights selected item
 * - Shows directories with / suffix
 * - Max 8 visible items with scroll
 * - Empty state when no matches
 */
export const FileMentionDropdown: React.FC<FileMentionDropdownProps> = ({
  items,
  query,
  selectedIndex,
  onSelect,
  getDisplayName,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  // Handle click outside to close (parent handles this)
  // Scroll selected item into view when selection changes
  useEffect(() => {
    const selectedElement = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-mention-index="${selectedIndex}"]`
    );
    if (selectedElement) {
      selectedElement.scrollIntoView({
        block: 'nearest',
      });
    }
  }, [selectedIndex]);

  // Get the base path for highlighting (the part the user typed)
  const getBasePath = (itemPath: string, query: string): string => {
    if (!query) return '';
    if (itemPath.toLowerCase().startsWith(query.toLowerCase())) {
      return itemPath.slice(0, query.length);
    }
    return '';
  };

  // Get the remaining path (the part to highlight/dim)
  const getRemainingPath = (itemPath: string, basePath: string): string => {
    return itemPath.slice(basePath.length);
  };

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-background p-3 text-xs shadow-lg">
        <div className="text-muted-foreground">No matching files</div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background p-2 text-xs shadow-lg"
    >
      {items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const displayName = getDisplayName(item, query);
        const basePath = getBasePath(item.path, query);
        const remainingPath = getRemainingPath(item.path, basePath);
        const isDir = item.type === 'dir';

        return (
          <button
            key={item.path}
            data-mention-index={index}
            type="button"
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
              isSelected
                ? 'bg-muted/60'
                : 'hover:bg-muted/40'
            }`}
            onClick={() => onSelect(index)}
            onMouseEnter={() => {
              // Optional: update selection on hover
              // onSelect(index);
            }}
          >
            {isDir ? (
              <Folder className="h-4 w-4 text-blue-500 shrink-0" />
            ) : (
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {basePath ? (
                <>
                  <span className="text-foreground">{basePath}</span>
                  <span className="text-muted-foreground">{remainingPath}</span>
                </>
              ) : (
                <span className="text-foreground">{displayName}</span>
              )}
              {isDir && <span className="text-muted-foreground">/</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default FileMentionDropdown;
