import React from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Spinner } from './ui/spinner';
import { useToast } from '../hooks/use-toast';

type SimulatorDevice = {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  runtime: { identifier: string; name: string; platform?: string; version?: string };
  isIphone: boolean;
  modelNumber: number;
};

type SnapshotState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  isIosProject: boolean;
  container?: { type: 'workspace' | 'project'; path: string } | null;
  devices: SimulatorDevice[];
  booted: SimulatorDevice[];
  bestUdid: string | null;
  schemes: string[];
  defaultScheme: string | null;
  error?: string | null;
  stage?: string | null;
  details?: { stdout?: string; stderr?: string; logPath?: string } | null;
  lastUpdated?: number;
};

type DetectState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  isIosProject: boolean;
  error?: string | null;
  stage?: string | null;
  lastChecked?: number;
};

const snapshotCache = new Map<string, SnapshotState>();
const detectCache = new Map<string, DetectState>();
const detectInFlight = new Map<string, Promise<void>>();

interface IosSimulatorBarProps {
  projectPath?: string | null;
  taskPath?: string | null;
  className?: string;
}

const IosSimulatorBar: React.FC<IosSimulatorBarProps> = ({ projectPath, taskPath, className }) => {
  const rootPath = React.useMemo(
    () => (taskPath || projectPath || '').trim(),
    [projectPath, taskPath]
  );
  const [snapshot, setSnapshot] = React.useState<SnapshotState>(
    () =>
      snapshotCache.get(rootPath || '') ?? {
        status: 'idle',
        isIosProject: false,
        devices: [],
        booted: [],
        bestUdid: null,
        schemes: [],
        defaultScheme: null,
        container: null,
        error: null,
        stage: null,
        details: null,
        lastUpdated: undefined,
      }
  );
  const [detectState, setDetectState] = React.useState<DetectState>(
    () =>
      detectCache.get(rootPath || '') ?? {
        status: 'idle',
        isIosProject: false,
        error: null,
        stage: null,
        lastChecked: undefined,
      }
  );
  const [targetId, setTargetId] = React.useState<string | null>(null);
  const [hasUserSelected, setHasUserSelected] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [actionStage, setActionStage] = React.useState<string | null>(null);
  const [actionStartedAt, setActionStartedAt] = React.useState<number | null>(null);
  const [actionNow, setActionNow] = React.useState<number | null>(null);
  const [isActionHovered, setIsActionHovered] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copyResetRef = React.useRef<number | null>(null);
  const { toast } = useToast();

  const schemeStorageKey = React.useMemo(
    () => (rootPath ? `emdash:ios-scheme:${rootPath}` : null),
    [rootPath]
  );

  React.useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const updateSnapshot = React.useCallback(
    (path: string, next: SnapshotState) => {
      snapshotCache.set(path, next);
      if (path === rootPath) {
        setSnapshot(next);
      }
    },
    [rootPath]
  );

  const updateDetectState = React.useCallback(
    (path: string, next: DetectState) => {
      detectCache.set(path, next);
      if (path === rootPath) {
        setDetectState(next);
      }
    },
    [rootPath]
  );

  const applySnapshotResponse = React.useCallback(
    (path: string, res: any) => {
      const next: SnapshotState = {
        status: res.ok ? 'ready' : 'error',
        isIosProject: Boolean(res.isIosProject),
        container: res.container ?? null,
        devices: Array.isArray(res.devices) ? res.devices : [],
        booted: Array.isArray(res.booted) ? res.booted : [],
        bestUdid: res.bestUdid ?? null,
        schemes: Array.isArray(res.schemes) ? res.schemes : [],
        defaultScheme: res.defaultScheme ?? null,
        error: res.error ?? null,
        stage: res.stage ?? null,
        details: res.details ?? null,
        lastUpdated: Date.now(),
      };
      updateSnapshot(path, next);
    },
    [updateSnapshot]
  );

  const refreshSnapshot = React.useCallback(
    async (path: string, opts?: { silent?: boolean }) => {
      const api = window.electronAPI;
      if (!api?.iosSimulatorSnapshot) return;
      const current = snapshotCache.get(path);
      if (!opts?.silent) {
        updateSnapshot(path, {
          status: 'loading',
          isIosProject: current?.isIosProject ?? true,
          container: current?.container ?? null,
          devices: current?.devices ?? [],
          booted: current?.booted ?? [],
          bestUdid: current?.bestUdid ?? null,
          schemes: current?.schemes ?? [],
          defaultScheme: current?.defaultScheme ?? null,
          error: current?.error ?? null,
          stage: current?.stage ?? null,
          details: current?.details ?? null,
          lastUpdated: current?.lastUpdated,
        });
      }
      const res = await api.iosSimulatorSnapshot({ projectPath: path });
      applySnapshotResponse(path, res);
    },
    [applySnapshotResponse, updateSnapshot]
  );

  const refreshDetect = React.useCallback(
    async (path: string, opts?: { silent?: boolean }) => {
      const api = window.electronAPI;
      if (!api?.iosSimulatorDetect) return;
      if (detectInFlight.has(path)) {
        await detectInFlight.get(path);
        return;
      }

      const task = (async () => {
        const current = detectCache.get(path);
        if (!opts?.silent) {
          updateDetectState(path, {
            status: 'loading',
            isIosProject: current?.isIosProject ?? false,
            error: current?.error ?? null,
            stage: current?.stage ?? null,
            lastChecked: current?.lastChecked,
          });
        }
        const res = await api.iosSimulatorDetect({ projectPath: path });
        updateDetectState(path, {
          status: res.ok ? 'ready' : 'error',
          isIosProject: Boolean(res.ok && res.isIosProject),
          error: res.error ?? null,
          stage: res.stage ?? null,
          lastChecked: Date.now(),
        });
        if (!res.ok || !res.isIosProject) {
          updateSnapshot(path, {
            status: 'idle',
            isIosProject: false,
            container: null,
            devices: [],
            booted: [],
            bestUdid: null,
            schemes: [],
            defaultScheme: null,
            error: null,
            stage: null,
            details: null,
            lastUpdated: undefined,
          });
          return;
        }
        const snapshotState = snapshotCache.get(path);
        if (!snapshotState || snapshotState.status === 'idle') {
          await refreshSnapshot(path, { silent: false });
        }
      })();

      detectInFlight.set(path, task);
      try {
        await task;
      } finally {
        detectInFlight.delete(path);
      }
    },
    [refreshSnapshot, updateDetectState, updateSnapshot]
  );

  React.useEffect(() => {
    if (!rootPath) {
      setSnapshot({
        status: 'idle',
        isIosProject: false,
        devices: [],
        booted: [],
        bestUdid: null,
        schemes: [],
        defaultScheme: null,
        container: null,
        error: null,
        stage: null,
        details: null,
        lastUpdated: undefined,
      });
      setDetectState({
        status: 'idle',
        isIosProject: false,
        error: null,
        stage: null,
        lastChecked: undefined,
      });
      return;
    }

    const cachedDetect = detectCache.get(rootPath);
    if (cachedDetect) {
      setDetectState(cachedDetect);
    } else {
      setDetectState({
        status: 'loading',
        isIosProject: false,
        error: null,
        stage: null,
        lastChecked: undefined,
      });
    }

    const cachedSnapshot = snapshotCache.get(rootPath);
    if (cachedSnapshot) {
      setSnapshot(cachedSnapshot);
    } else {
      setSnapshot({
        status: 'idle',
        isIosProject: false,
        devices: [],
        booted: [],
        bestUdid: null,
        schemes: [],
        defaultScheme: null,
        container: null,
        error: null,
        stage: null,
        details: null,
        lastUpdated: undefined,
      });
    }

    if (cachedDetect?.isIosProject) {
      const shouldShowLoading = !cachedSnapshot || cachedSnapshot.status === 'idle';
      void refreshSnapshot(rootPath, { silent: !shouldShowLoading });
      void refreshDetect(rootPath, { silent: true });
    } else {
      void refreshDetect(rootPath, { silent: false });
    }
  }, [refreshDetect, refreshSnapshot, rootPath]);

  React.useEffect(() => {
    if (!rootPath) return;
    if (!detectState.isIosProject) return;
    const api = window.electronAPI;
    if (!api?.iosSimulatorPollerStart || !api?.iosSimulatorPollerStop) return;
    const start = () => void api.iosSimulatorPollerStart();
    const stop = () => void api.iosSimulatorPollerStop();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        start();
        void refreshSnapshot(rootPath, { silent: true });
      } else {
        stop();
      }
    };
    const handleFocus = () => {
      start();
      void refreshSnapshot(rootPath, { silent: true });
    };
    const handleBlur = () => stop();

    start();
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
    };
  }, [detectState.isIosProject, refreshSnapshot, rootPath]);

  const parseTargetId = (value: string): { mode: 'running' | 'new'; id: string } | null => {
    const [mode, id] = value.split('::');
    if (!id || (mode !== 'running' && mode !== 'new')) return null;
    return { mode, id };
  };

  const runningSimulators = snapshot.booted;
  const runningIds = React.useMemo(
    () => new Set(runningSimulators.map((device) => device.udid)),
    [runningSimulators]
  );
  const newSimulators = React.useMemo(
    () => snapshot.devices.filter((device) => !runningIds.has(device.udid)),
    [runningIds, snapshot.devices]
  );
  const targetIdList = React.useMemo(
    () => [
      ...runningSimulators.map((device) => `running::${device.udid}`),
      ...newSimulators.map((device) => `new::${device.udid}`),
    ],
    [runningSimulators, newSimulators]
  );
  const defaultTarget = React.useMemo(() => {
    if (runningSimulators[0]?.udid) {
      return `running::${runningSimulators[0].udid}`;
    }
    if (snapshot.bestUdid) {
      return `new::${snapshot.bestUdid}`;
    }
    if (newSimulators[0]?.udid) {
      return `new::${newSimulators[0].udid}`;
    }
    return null;
  }, [newSimulators, runningSimulators, snapshot.bestUdid]);

  React.useEffect(() => {
    if (!defaultTarget) return;
    const isTargetValid = targetId ? targetIdList.includes(targetId) : false;
    if (!isTargetValid || !hasUserSelected) {
      setTargetId(defaultTarget);
    }
  }, [defaultTarget, hasUserSelected, targetId, targetIdList]);

  const selectedTarget = targetId ? parseTargetId(targetId) : null;
  const selectedDevice =
    selectedTarget?.mode === 'running'
      ? runningSimulators.find((device) => device.udid === selectedTarget.id)
      : newSimulators.find((device) => device.udid === selectedTarget?.id);
  const resolvedScheme = React.useMemo(() => {
    let stored: string | null = null;
    if (schemeStorageKey) {
      try {
        stored = window.localStorage.getItem(schemeStorageKey);
      } catch {
        stored = null;
      }
    }
    if (stored && snapshot.schemes.includes(stored)) return stored;
    if (snapshot.defaultScheme && snapshot.schemes.includes(snapshot.defaultScheme)) {
      return snapshot.defaultScheme;
    }
    if (snapshot.schemes.length === 1) return snapshot.schemes[0];
    return null;
  }, [schemeStorageKey, snapshot.defaultScheme, snapshot.schemes]);
  const isInitialLoading = detectState.isIosProject && snapshot.status === 'loading';
  const needsSchemeSelection = snapshot.schemes.length > 1 && !resolvedScheme;
  const hasSchemeError = snapshot.status === 'error' && snapshot.stage === 'schemes';
  const hasDeviceError =
    snapshot.status === 'error' && snapshot.stage !== 'schemes' && snapshot.stage !== 'build';
  const showSchemeSelect = snapshot.schemes.length > 1 || snapshot.status !== 'ready';
  const hasNoDevices = snapshot.status === 'ready' && snapshot.devices.length === 0;
  const hasCopyableError = Boolean(snapshot.error || snapshot.details?.stderr);
  const canRun =
    Boolean(selectedDevice) &&
    !isBusy &&
    !isInitialLoading &&
    Boolean(resolvedScheme) &&
    !hasSchemeError &&
    !hasNoDevices;
  const displayMode: 'running' | 'new' =
    selectedTarget?.mode ?? (runningSimulators.length > 0 ? 'running' : 'new');
  const actionLabel = 'Run';
  const actionHint = displayMode === 'running' ? 'Running' : 'New';
  const ActionIcon = Play;
  const actionChipLabel =
    isBusy && actionStage
      ? actionStage
      : isInitialLoading
        ? 'Loading iOS data'
        : hasDeviceError || hasSchemeError
          ? 'Error'
          : needsSchemeSelection
            ? 'Scheme'
            : actionHint;
  const actionElapsed =
    actionStartedAt && actionNow ? Math.floor((actionNow - actionStartedAt) / 1000) : 0;
  const isCancelMode = isBusy && isActionHovered;
  const ActionVisualIcon = isCancelMode ? X : ActionIcon;
  const actionTitle = isCancelMode
    ? 'Cancel the current simulator task'
    : hasSchemeError
      ? `Unable to load schemes: ${snapshot.error ?? 'Unknown error'}`
      : hasDeviceError
        ? `Simulator tools unavailable: ${snapshot.error ?? 'Unknown error'}`
        : hasNoDevices
          ? 'No iOS simulators are installed'
          : displayMode === 'running'
            ? 'Run on a running simulator'
            : 'Run on a new simulator';
  const actionText = isCancelMode
    ? 'Cancel'
    : isBusy
      ? `Working${actionElapsed > 0 ? ` ${actionElapsed}s` : ''}`
      : isInitialLoading
        ? 'Loading iOS data'
        : hasNoDevices
          ? 'No simulators'
          : actionLabel;
  const emptyState = React.useMemo(() => {
    if (hasDeviceError) {
      const isXcodeMissing = snapshot.stage === 'xcode';
      return {
        title: isXcodeMissing ? 'Install Xcode to continue' : 'Simulator tools unavailable',
        message: isXcodeMissing ? null : 'Check your Xcode install and command line tools.',
        linkUrl: isXcodeMissing
          ? 'https://developer.apple.com/documentation/safari-developer-tools/installing-xcode-and-simulators'
          : 'https://developer.apple.com/documentation/xcode',
        linkLabel: isXcodeMissing ? 'Open Xcode install instructions' : 'Learn more',
      };
    }
    if (hasNoDevices) {
      return {
        title: 'No simulators installed',
        message: null,
        linkLabel: 'Open simulator install instructions',
        linkUrl:
          'https://developer.apple.com/documentation/safari-developer-tools/adding-additional-simulators',
      };
    }
    return null;
  }, [hasDeviceError, hasNoDevices, snapshot.stage]);

  React.useEffect(() => {
    if (!isBusy || !actionStartedAt) return;
    setActionNow(Date.now());
    const interval = window.setInterval(() => setActionNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [actionStartedAt, isBusy]);

  const showActionSpinner = isBusy || isInitialLoading;
  const schemePlaceholder =
    snapshot.status === 'loading'
      ? 'Loading iOS data...'
      : snapshot.schemes.length === 0
        ? 'No schemes'
        : 'Select scheme';
  const devicePlaceholder = hasDeviceError
    ? 'Simulator tools unavailable'
    : hasNoDevices
      ? 'No simulators installed'
      : snapshot.status === 'loading'
        ? 'Loading iOS data...'
        : 'Select simulator';

  const storeScheme = React.useCallback(
    (value: string) => {
      if (!schemeStorageKey) return;
      try {
        window.localStorage.setItem(schemeStorageKey, value);
      } catch {}
    },
    [schemeStorageKey]
  );

  const handleCopy = React.useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    const payload = {
      timestamp: new Date().toISOString(),
      projectPath: rootPath,
      container: snapshot.container,
      status: snapshot.status,
      stage: snapshot.stage,
      error: snapshot.error,
      details: snapshot.details,
      devices: snapshot.devices,
      booted: snapshot.booted,
      schemes: snapshot.schemes,
      defaultScheme: snapshot.defaultScheme,
      bestUdid: snapshot.bestUdid,
      lastUpdated: snapshot.lastUpdated,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetRef.current = null;
      }, 2000);
      toast({ title: 'Copied', description: 'iOS simulator details copied.' });
    } catch (error) {
      toast({
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Unable to copy details.',
        variant: 'destructive',
      });
    }
  }, [rootPath, snapshot, toast]);

  const resetActionState = () => {
    setIsBusy(false);
    setActionStage(null);
    setActionStartedAt(null);
    setActionNow(null);
  };

  const handleCancel = async () => {
    resetActionState();
    try {
      const api = window.electronAPI;
      const res = await api?.iosSimulatorCancel?.();
      if (res && !res.cancelled) {
        toast({
          title: 'Nothing to cancel',
          description: 'No active simulator command was running.',
        });
      } else {
        toast({
          title: 'Build cancelled',
          description: 'Simulator task was cancelled.',
        });
      }
    } catch (error) {
      toast({
        title: 'Cancel failed',
        description: error instanceof Error ? error.message : 'Unable to cancel right now.',
        variant: 'destructive',
      });
    }
  };

  const handleRun = async () => {
    if (isCancelMode) {
      await handleCancel();
      void refreshSnapshot(rootPath, { silent: true });
      return;
    }
    if (isBusy) {
      return;
    }
    if (!selectedDevice || !selectedTarget) {
      toast({
        title: 'Select a simulator',
        description: 'Choose a running simulator or a device to boot.',
      });
      return;
    }
    if (!resolvedScheme) {
      toast({
        title: 'Select a scheme',
        description: 'Choose a scheme to build and run.',
      });
      return;
    }
    const api = window.electronAPI;
    if (!api?.iosSimulatorLaunch || !api?.iosSimulatorBuildRun) {
      toast({ title: 'Simulator unavailable', description: 'Missing native simulator support.' });
      return;
    }

    setIsBusy(true);
    const startTime = Date.now();
    setActionStartedAt(startTime);
    setActionNow(startTime);
    setActionStage(displayMode === 'new' ? 'Booting' : 'Building');

    try {
      if (displayMode === 'new') {
        const launchRes = await api.iosSimulatorLaunch({ udid: selectedDevice.udid });
        if (!launchRes.ok) {
          toast({
            title: 'Simulator launch failed',
            description: launchRes.error || 'Unable to launch simulator.',
            variant: 'destructive',
          });
          void refreshSnapshot(rootPath, { silent: true });
          return;
        }
      }

      setActionStage('Building');
      const buildRes = await api.iosSimulatorBuildRun({
        projectPath: rootPath,
        udid: selectedDevice.udid,
        scheme: resolvedScheme,
      });
      if (!buildRes.ok) {
        if (buildRes.stage === 'cancelled') {
          return;
        }
        toast({
          title: 'Run failed',
          description: buildRes.error || 'Unable to run the app.',
          variant: 'destructive',
        });
        return;
      }

      void refreshSnapshot(rootPath, { silent: true });
    } catch (error) {
      toast({
        title: 'Simulator command failed',
        description: error instanceof Error ? error.message : 'Unexpected simulator error.',
        variant: 'destructive',
      });
    } finally {
      resetActionState();
      void refreshSnapshot(rootPath, { silent: true });
    }
  };

  if (!rootPath || !detectState.isIosProject) return null;

  return (
    <div
      className={cn(
        'flex items-center border-b border-border bg-muted px-2 py-1.5 dark:bg-background',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border border-border/70 bg-background/70">
          {isInitialLoading ? (
            <div className="flex h-7 flex-1 items-center px-3 text-xs text-muted-foreground">
              <Spinner size="sm" className="mr-1.5 h-3.5 w-3.5" />
              <span>Loading</span>
              <span className="ml-1.5 rounded-sm border border-border/70 bg-muted/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                {actionChipLabel}
              </span>
            </div>
          ) : emptyState ? (
            <div className="flex h-7 flex-1 items-center gap-2 px-3 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{emptyState.title}</div>
                {emptyState.message ? (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {emptyState.message}
                  </div>
                ) : null}
              </div>
              {hasCopyableError ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    void handleCopy();
                  }}
                  title={copied ? 'Copied' : 'Copy details'}
                  aria-label={copied ? 'Copied' : 'Copy details'}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              ) : null}

              {emptyState.linkUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={() => window.electronAPI?.openExternal?.(emptyState.linkUrl ?? '')}
                  title={emptyState.linkLabel}
                  aria-label={emptyState.linkLabel}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                className="h-7 rounded-none rounded-l-md px-3 text-xs"
                title={actionTitle}
                onMouseEnter={() => setIsActionHovered(true)}
                onMouseLeave={() => setIsActionHovered(false)}
                onClick={handleRun}
                disabled={isBusy ? false : !canRun}
              >
                {showActionSpinner && !isCancelMode ? (
                  <Spinner size="sm" className="mr-1.5 h-3.5 w-3.5" />
                ) : null}
                {!showActionSpinner || isCancelMode ? (
                  <ActionVisualIcon className="mr-1.5 h-3.5 w-3.5" />
                ) : null}
                <span>{actionText}</span>
                <span className="ml-1.5 rounded-sm border border-border/70 bg-muted/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {actionChipLabel}
                </span>
              </Button>
              <div className="h-6 w-px bg-border/70" />
              {showSchemeSelect ? (
                <>
                  <Select
                    value={resolvedScheme ?? undefined}
                    onValueChange={(value) => {
                      storeScheme(value);
                    }}
                    disabled={isBusy || snapshot.status === 'loading'}
                  >
                    <SelectTrigger
                      aria-label="Xcode scheme"
                      className="h-7 w-[150px] shrink-0 rounded-none border-none bg-transparent px-2 text-xs shadow-none"
                    >
                      <SelectValue placeholder={schemePlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                          Scheme
                        </div>
                        {snapshot.schemes.map((scheme: string) => (
                          <SelectItem key={scheme} value={scheme} className="text-xs">
                            {scheme}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="h-6 w-px bg-border/70" />
                </>
              ) : null}
              <Select
                value={targetId ?? undefined}
                onValueChange={(value) => {
                  setTargetId(value);
                  setHasUserSelected(true);
                }}
                disabled={isBusy || snapshot.status === 'loading' || snapshot.devices.length === 0}
              >
                <SelectTrigger
                  aria-label="Simulator"
                  className="h-7 min-w-[180px] max-w-[260px] flex-1 rounded-none border-none bg-transparent px-2 text-xs shadow-none"
                >
                  <SelectValue placeholder={devicePlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                      Running
                    </div>
                    {runningSimulators.length === 0 ? (
                      <SelectItem value="running:none" disabled className="text-xs">
                        No running simulators
                      </SelectItem>
                    ) : null}
                    {runningSimulators.map((device) => (
                      <SelectItem key={`running:${device.udid}`} value={`running::${device.udid}`}>
                        {device.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                      New
                    </div>
                    {newSimulators.map((device) => (
                      <SelectItem key={`new:${device.udid}`} value={`new::${device.udid}`}>
                        {device.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default IosSimulatorBar;
