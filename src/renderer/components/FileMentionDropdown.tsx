import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, FileText, Folder } from 'lucide-react';
import { getMentionBasePath } from '../lib/fileMentions';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import type { Item } from '../hooks/useFileMentions';

type FileMentionDropdownProps = {
  items: Item[];
  query: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  getDisplayName: (item: Item, query: string) => string;
  anchorRect: DOMRect | null;
  error?: string | null;
  loading?: boolean;
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
  anchorRect,
  error,
  loading,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<number | null>(null);

  // Virtual element for caret-based positioning
  const [virtualElement, setVirtualElement] = useState<{ current: { getBoundingClientRect: () => DOMRect } }>({
    current: {
      getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: 0, y: 0 })
    }
  });

  useEffect(() => {
    if (anchorRect) {
      setVirtualElement({
        current: {
          getBoundingClientRect: () => anchorRect
        }
      });
    }
  }, [anchorRect]);

  // Hover selection with debounce to prevent jittery navigation
  const handleMouseEnter = useCallback((index: number) => {
    if (hoverTimeoutRef.current !== null) {
      clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = window.setTimeout(() => {
      onSelect(index);
      hoverTimeoutRef.current = null;
    }, 150);
  }, [onSelect]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current !== null) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  // Cleanup hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current !== null) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

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

  // Get the remaining path (the part to highlight/dim)
  const getRemainingPath = (itemPath: string, basePath: string): string => {
    return itemPath.slice(basePath.length);
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-background p-3 text-xs shadow-lg">
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <span>Loading files...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200/70 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:border-red-500/40 dark:text-red-400 shadow-lg">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-background p-3 text-xs shadow-lg">
        <div className="text-muted-foreground">No matching files</div>
      </div>
    );
  }

  return (
    <Popover open={true}>
      <PopoverAnchor virtualRef={virtualElement} />
      <PopoverContent
        align="start"
        sideOffset={4}
        side="bottom"
        className="z-[100] w-auto min-w-[200px] max-w-[400px] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div
          ref={listRef}
          className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background p-2 text-xs shadow-lg"
        >
          {items.map((item, index) => {
            const isSelected = index === selectedIndex;
            const displayName = getDisplayName(item, query);
            const basePath = getMentionBasePath(item.path, query);
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
                onMouseEnter={() => handleMouseEnter(index)}
                onMouseLeave={handleMouseLeave}
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
      </PopoverContent>
    </Popover>
  );
};

export default FileMentionDropdown;
