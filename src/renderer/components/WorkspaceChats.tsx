import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import ChatInterface from './ChatInterface';
import { Button } from './ui/button';
import { useToast } from '@/hooks/use-toast';
import { classifyActivity } from '@/lib/activityClassifier';
import { BUSY_HOLD_MS, CLEAR_BUSY_MS } from '@/lib/activityConstants';
import { activityStore } from '@/lib/activityStore';
import { Spinner } from './ui/spinner';
import type { Workspace } from '../types/chat';
import type { Provider } from '../types';
import { providerAssets } from '@/providers/assets';
import { providerMeta } from '@/providers/meta';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

type Conversation = {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
};

const MAX_TABS = 8;
const WARN_THRESHOLD = 3; // show toast when creating the 4th tab

interface Props {
  workspace: Workspace;
  projectName: string;
  projectId: string;
}

function makeTerminalId(provider: Provider, conversationId: string, workspaceId: string) {
  const base = `${conversationId}--${workspaceId}`;
  return `${provider}-main-${base}`;
}

function nextChatTitle(existing: Conversation[]) {
  const nums = existing
    .map((c) => {
      const match = c.title?.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((n): n is number => Number.isFinite(n));
  const maxNum = nums.length ? Math.max(...nums) : 0;
  return `Chat ${maxNum + 1}`;
}

const WorkspaceChats: React.FC<Props> = ({ workspace, projectName, projectId: _projectId }) => {
  const { toast } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<string, Provider>>({});
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const providerOptions = useMemo(() => Object.keys(providerMeta) as Provider[], []);

  const handleProviderChange = useCallback((conversationId: string, provider: Provider) => {
    setProviders((prev) => {
      if (prev[conversationId] === provider) return prev;
      return { ...prev, [conversationId]: provider };
    });
  }, []);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.getConversations(workspace.id);
      let list: Conversation[] =
        res?.success && Array.isArray(res.conversations)
          ? res.conversations
              .map((c: any) => ({
                id: c.id,
                title:
                  c.title === 'Default Conversation' || c.title === 'Default'
                    ? 'Default'
                    : c.title || 'Chat',
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
              }))
              .sort((a, b) => {
                const aTime = Date.parse(a.createdAt || a.updatedAt || '') || 0;
                const bTime = Date.parse(b.createdAt || b.updatedAt || '') || 0;
                return aTime - bTime;
              })
          : [];

      // Auto-provision a default chat for brand-new workspaces
      if (!list.length) {
        const created = await window.electronAPI.getOrCreateDefaultConversation(workspace.id);
        if (created?.success && created.conversation?.id) {
          list = [
            {
              id: created.conversation.id,
              title: 'Default',
              createdAt: created.conversation.createdAt,
              updatedAt: created.conversation.updatedAt,
            },
          ];
        }
      }

      setConversations(list);
      if (list.length) {
        const saved = localStorage.getItem(`activeConversation:${workspace.id}`);
        const match = saved && list.find((c) => c.id === saved);
        const idToUse = match ? match.id : list[0].id;
        setActiveId(idToUse);
        // Seed provider cache for the default chat
        if (idToUse && !providers[idToUse]) {
          handleProviderChange(idToUse, ((workspace.agentId as Provider) || 'codex') as Provider);
        }
      } else {
        setActiveId(null);
      }
    } finally {
      setLoading(false);
    }
  }, [handleProviderChange, providers, workspace.agentId, workspace.id]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (activeId) {
      try {
        localStorage.setItem(`activeConversation:${workspace.id}`, activeId);
      } catch {}
    } else {
      try {
        localStorage.removeItem(`activeConversation:${workspace.id}`);
      } catch {}
    }
  }, [activeId, workspace.id]);

  const getProviderForConversation = useCallback(
    (conversationId: string): Provider => {
      const cached = providers[conversationId];
      if (cached) return cached;
      try {
        const saved = localStorage.getItem(`provider:last:${conversationId}`) as Provider | null;
        if (saved) return saved;
      } catch {}
      const fallback = (workspace.agentId as Provider) || 'codex';
      return fallback;
    },
    [providers, workspace.agentId]
  );

  const handleCreate = useCallback(
    async (providerForChat?: Provider) => {
      if (conversations.length >= MAX_TABS) return;
      const nextCount = conversations.length + 1;
      if (nextCount === WARN_THRESHOLD + 1) {
        const warnKey = `tabsWarned:${workspace.id}`;
        const warned = localStorage.getItem(warnKey) === '1';
        if (!warned) {
          toast({
            title: 'Lots of tabs may impact performance.',
            description: 'Consider closing chats you are not using.',
          });
          try {
            localStorage.setItem(warnKey, '1');
          } catch {}
        }
      }
      const id = `conv-${workspace.id}-${Date.now()}`;
      const title = nextChatTitle(conversations);
      const res = await window.electronAPI.saveConversation({
        id,
        workspaceId: workspace.id,
        title,
      });
      if (!res?.success) {
        toast({ title: 'Failed to create chat', description: res?.error || 'Unknown error' });
        return;
      }
      const updated = [...conversations, { id, title }];
      setConversations(updated);
      setActiveId(id);
      // Default provider per chat picks workspace agent or codex
      const chosen =
        providerForChat ||
        getProviderForConversation(activeId || '') ||
        ((workspace.agentId as Provider) || 'codex');
      handleProviderChange(id, chosen as Provider);
    },
    [activeId, conversations, getProviderForConversation, handleProviderChange, toast, workspace.agentId, workspace.id]
  );

  const handleDelete = useCallback(
    async (conversation: Conversation) => {
      const provider = getProviderForConversation(conversation.id);
      const ptyId = makeTerminalId(provider, conversation.id, workspace.id);
      try {
        window.electronAPI.ptyKill(ptyId);
        await window.electronAPI.ptyClearSnapshot({ id: ptyId });
      } catch {}
      try {
        await window.electronAPI.deleteConversation(conversation.id);
      } catch (error: any) {
        toast({
          title: 'Failed to delete chat',
          description: error?.message || 'Unknown error',
        });
      }
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== conversation.id);
        if (activeId === conversation.id) {
          setActiveId(next[0]?.id ?? null);
        }
        return next;
      });
      setBusyMap((prev) => {
        const next = { ...prev };
        delete next[conversation.id];
        return next;
      });
    },
    [activeId, conversations, getProviderForConversation, toast, workspace.id]
  );

  useEffect(() => {
    if (!conversations.length) {
      activityStore.setWorkspaceBusy(workspace.id, false);
      return;
    }

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const busySince = new Map<string, number>();

    const setBusy = (convId: string, busy: boolean) => {
      setBusyMap((prev) => {
        if (prev[convId] === busy) return prev;
        return { ...prev, [convId]: busy };
      });
    };

    const handleIdle = (convId: string) => {
      const started = busySince.get(convId) || 0;
      const elapsed = started ? Date.now() - started : BUSY_HOLD_MS;
      const remaining = elapsed < BUSY_HOLD_MS ? BUSY_HOLD_MS - elapsed : 0;
      const clear = () => {
        timers.delete(convId);
        busySince.delete(convId);
        setBusy(convId, false);
      };
      if (remaining > 0) {
        const t = setTimeout(clear, remaining);
        timers.set(convId, t);
      } else {
        clear();
      }
    };

    const cleanups: Array<() => void> = [];
    conversations.forEach((conv) => {
      const provider = getProviderForConversation(conv.id);
      const ptyId = makeTerminalId(provider, conv.id, workspace.id);

      const offData = (window as any).electronAPI?.onPtyData?.(ptyId, (chunk: string) => {
        try {
          const signal = classifyActivity(provider, chunk || '');
          if (signal === 'busy') {
            busySince.set(conv.id, Date.now());
            setBusy(conv.id, true);
          } else if (signal === 'idle') {
            handleIdle(conv.id);
          }
        } catch {}
      });
      if (offData) cleanups.push(offData);

      const offExit = (window as any).electronAPI?.onPtyExit?.(ptyId, () => {
        setBusy(conv.id, false);
      });
      if (offExit) cleanups.push(offExit);
    });

    return () => {
      cleanups.forEach((off) => {
        try {
          off?.();
        } catch {}
      });
      timers.forEach((t) => clearTimeout(t));
    };
  }, [conversations, getProviderForConversation, workspace.id]);

  useEffect(() => {
    const anyBusy = Object.values(busyMap).some(Boolean);
    activityStore.setWorkspaceBusy(workspace.id, anyBusy);
  }, [busyMap, workspace.id]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );
  const primaryConversationId = conversations[0]?.id || null;
  const createDisabled = conversations.length >= MAX_TABS;
  const currentProvider =
    (activeId && getProviderForConversation(activeId)) ||
    (workspace.agentId as Provider) ||
    'codex';
  const currentAsset = providerAssets[currentProvider];
  const currentMeta = providerMeta[currentProvider];

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading chats...
      </div>
    );
  }

  if (!conversations.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center space-y-4 text-sm text-muted-foreground">
        <div>No chats yet in this worktree.</div>
        <Button onClick={() => void handleCreate()}>Create first chat</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {conversations.map((conv) => {
            const isActive = conv.id === activeId;
            const provider = getProviderForConversation(conv.id);
            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => setActiveId(conv.id)}
                className={`inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                  isActive
                    ? 'border border-border bg-background text-foreground shadow-sm'
                    : 'border border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                }`}
                title={conv.title}
              >
                <span className="truncate max-w-[150px]">{conv.title}</span>
                {busyMap[conv.id] ? <Spinner size="sm" /> : null}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(conv);
                  }}
                  className="ml-1 flex h-4 w-4 items-center justify-center rounded hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`flex items-center overflow-hidden rounded-md border border-border/70 bg-card text-xs shadow-sm ${
              createDisabled ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            <button
              type="button"
              onClick={() => void handleCreate(currentProvider)}
              className="flex h-8 w-8 items-center justify-center border-r border-border/70 bg-transparent px-1.5 transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              title={
                createDisabled
                  ? 'Max 8 chats reached'
                  : `New chat with ${currentMeta?.label || currentProvider}`
              }
              aria-label={
                createDisabled
                  ? 'Max chats reached'
                  : `Create chat with ${currentMeta?.label || currentProvider}`
              }
            >
              {currentAsset?.logo ? (
                <img
                  src={currentAsset.logo}
                  alt={currentMeta?.label || currentProvider}
                  className={`h-4 w-4 shrink-0 object-contain ${currentAsset?.invertInDark ? 'dark:invert' : ''}`}
                />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </button>
            <Select
              disabled={createDisabled}
              onValueChange={(prov) => {
                void handleCreate(prov as Provider);
              }}
            >
              <SelectTrigger
                className="h-8 rounded-none border-0 border-l border-border/70 bg-transparent px-3 py-0 text-xs font-medium shadow-none transition hover:bg-muted focus-visible:ring-0 data-[state=open]:bg-muted"
                title={createDisabled ? 'Max 8 chats reached' : 'New chat'}
              >
                <SelectValue placeholder="New" />
              </SelectTrigger>
              <SelectContent className="min-w-[12rem] border border-border bg-card shadow-lg">
                {providerOptions.map((prov) => {
                  const asset = providerAssets[prov];
                  const meta = providerMeta[prov];
                  return (
                    <SelectItem key={prov} value={prov} className="flex items-center gap-2">
                      <div className="flex items-center gap-2">
                        {asset?.logo ? (
                          <img
                            src={asset.logo}
                            alt={meta?.label || prov}
                            className={`h-4 w-4 shrink-0 object-contain ${asset?.invertInDark ? 'dark:invert' : ''}`}
                          />
                        ) : null}
                        <span>{meta?.label || prov}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activeConversation ? (
          <ChatInterface
            key={activeConversation.id}
            workspace={workspace}
            projectName={projectName}
            conversationId={activeConversation.id}
            initialProvider={getProviderForConversation(activeConversation.id)}
            onProviderChange={(p) => handleProviderChange(activeConversation.id, p)}
            allowInitialInjection={
              activeConversation.id === primaryConversationId && !workspace.metadata?.initialInjectionSent
            }
            className="min-h-0 flex-1"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select or create a chat to begin.
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkspaceChats;
