import React from 'react';
import { Cable, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
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

const detectIosProject = async (rootPath: string): Promise<boolean> => {
  try {
    const api = window.electronAPI;
    if (!api?.iosSimulatorDetect) return false;
    const res = await api.iosSimulatorDetect({ projectPath: rootPath });
    return Boolean(res.ok && res.isIosProject);
  } catch {
    return false;
  }
};

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
  const [isIosProject, setIsIosProject] = React.useState(false);
  const [isDetecting, setIsDetecting] = React.useState(false);
  const detectCacheRef = React.useRef<{ path: string; value: boolean } | null>(null);
  const [availableDevices, setAvailableDevices] = React.useState<SimulatorDevice[]>([]);
  const [bootedDevices, setBootedDevices] = React.useState<SimulatorDevice[]>([]);
  const [bestUdid, setBestUdid] = React.useState<string | null>(null);
  const [devicesStatus, setDevicesStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [bootedStatus, setBootedStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [schemes, setSchemes] = React.useState<string[]>([]);
  const schemeCacheRef = React.useRef<{
    path: string;
    schemes: string[];
    defaultScheme: string | null;
    timestamp: number;
  } | null>(null);
  const [defaultScheme, setDefaultScheme] = React.useState<string | null>(null);
  const [selectedScheme, setSelectedScheme] = React.useState<string | null>(null);
  const [hasUserSelectedScheme, setHasUserSelectedScheme] = React.useState(false);
  const [schemeStatus, setSchemeStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [schemeError, setSchemeError] = React.useState<string | null>(null);
  const [targetId, setTargetId] = React.useState<string | null>(null);
  const [hasUserSelected, setHasUserSelected] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [actionStage, setActionStage] = React.useState<string | null>(null);
  const [actionStartedAt, setActionStartedAt] = React.useState<number | null>(null);
  const [actionNow, setActionNow] = React.useState<number | null>(null);
  const [isActionHovered, setIsActionHovered] = React.useState(false);
  const { toast } = useToast();

  const schemeStorageKey = React.useMemo(
    () => (rootPath ? `emdash:ios-scheme:${rootPath}` : null),
    [rootPath]
  );
  const selectedSchemeRef = React.useRef<string | null>(null);
  const hasUserSelectedSchemeRef = React.useRef(false);
  const lastSchemeErrorRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    selectedSchemeRef.current = selectedScheme;
  }, [selectedScheme]);

  React.useEffect(() => {
    hasUserSelectedSchemeRef.current = hasUserSelectedScheme;
  }, [hasUserSelectedScheme]);

  React.useEffect(() => {
    let cancelled = false;
    setIsDetecting(Boolean(rootPath));
    setIsIosProject(false);
    setDevicesStatus('idle');
    setBootedStatus('idle');
    setSchemes([]);
    setDefaultScheme(null);
    setSelectedScheme(null);
    setHasUserSelectedScheme(false);
    setSchemeStatus('idle');
    setSchemeError(null);
    if (!rootPath) {
      setIsDetecting(false);
      setIsIosProject(false);
      return () => undefined;
    }
    void (async () => {
      const cached = detectCacheRef.current;
      if (cached && cached.path === rootPath) {
        if (!cancelled) {
          setIsIosProject(cached.value);
          setIsDetecting(false);
        }
        return;
      }
      const detected = await detectIosProject(rootPath);
      if (!cancelled) {
        detectCacheRef.current = { path: rootPath, value: detected };
        setIsIosProject(detected);
        setIsDetecting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const stageLabel = (stage?: string) => {
    switch (stage) {
      case 'validation':
        return 'Validation';
      case 'platform':
        return 'Platform';
      case 'simctl':
      case 'boot':
      case 'bootstatus':
        return 'Simulator';
      case 'open':
      case 'position':
        return 'Window';
      case 'container':
        return 'Project';
      case 'schemes':
        return 'Schemes';
      case 'build':
        return 'Build';
      case 'app':
      case 'bundle-id':
        return 'App';
      case 'install':
        return 'Install';
      case 'launch':
        return 'Launch';
      case 'cancelled':
        return 'Cancelled';
      default:
        return stage ? stage : 'Error';
    }
  };

  const parseTargetId = (value: string): { mode: 'running' | 'new'; id: string } | null => {
    const [mode, id] = value.split('::');
    if (!id || (mode !== 'running' && mode !== 'new')) return null;
    return { mode, id };
  };

  const runningSimulators = bootedDevices;
  const runningIds = React.useMemo(
    () => new Set(runningSimulators.map((device) => device.udid)),
    [runningSimulators]
  );
  const newSimulators = React.useMemo(
    () => availableDevices.filter((device) => !runningIds.has(device.udid)),
    [availableDevices, runningIds]
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
    if (bestUdid) {
      return `new::${bestUdid}`;
    }
    if (newSimulators[0]?.udid) {
      return `new::${newSimulators[0].udid}`;
    }
    return null;
  }, [bestUdid, newSimulators, runningSimulators]);

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
    if (selectedScheme) return selectedScheme;
    if (defaultScheme && schemes.includes(defaultScheme)) return defaultScheme;
    if (schemes.length === 1) return schemes[0];
    return null;
  }, [defaultScheme, schemes, selectedScheme]);
  const isInitialLoading = isDetecting || devicesStatus === 'loading' || bootedStatus === 'loading';
  const needsSchemeSelection = schemes.length > 1 && !resolvedScheme;
  const hasSchemeError = schemeStatus === 'error';
  const hasDeviceError = devicesStatus === 'error' || bootedStatus === 'error';
  const showSchemeSelect = schemes.length > 1;
  const canRun =
    Boolean(selectedDevice) &&
    !isBusy &&
    !isInitialLoading &&
    Boolean(resolvedScheme) &&
    !hasSchemeError;
  const displayMode: 'running' | 'new' =
    selectedTarget?.mode ?? (runningSimulators.length > 0 ? 'running' : 'new');
  const actionLabel = displayMode === 'running' ? 'Attach' : 'Run';
  const actionHint = displayMode === 'running' ? 'Running' : 'New';
  const ActionIcon = displayMode === 'running' ? Cable : Play;
  const actionChipLabel =
    isBusy && actionStage
      ? actionStage
      : isDetecting
        ? 'Detecting'
        : schemeStatus === 'loading'
          ? 'Schemes'
          : devicesStatus === 'loading' || bootedStatus === 'loading'
            ? 'Devices'
            : schemeError || hasDeviceError
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
    : isDetecting
      ? 'Checking for an iOS project'
      : schemeError
        ? `Unable to load schemes: ${schemeError}`
        : displayMode === 'running'
          ? 'Attach to a running simulator'
          : 'Build and run in a new simulator';
  const actionText = isCancelMode
    ? 'Cancel'
    : isBusy
      ? `Working${actionElapsed > 0 ? ` ${actionElapsed}s` : ''}`
      : isInitialLoading
        ? 'Loading'
        : actionLabel;

  React.useEffect(() => {
    if (!isBusy || !actionStartedAt) return;
    setActionNow(Date.now());
    const interval = window.setInterval(() => setActionNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [actionStartedAt, isBusy]);

  const showActionSpinner = isBusy || isInitialLoading;
  const schemePlaceholder =
    schemeStatus === 'loading'
      ? 'Loading schemes...'
      : schemeError
        ? 'Schemes unavailable'
        : 'Select scheme';
  const devicePlaceholder = isDetecting
    ? 'Detecting iOS project...'
    : devicesStatus === 'loading' || bootedStatus === 'loading'
      ? 'Loading simulators...'
      : 'Select simulator';

  const formatDeviceLabel = (device: SimulatorDevice) => {
    const runtime = device.runtime?.name ? ` (${device.runtime.name})` : '';
    return `${device.name}${runtime}`;
  };

  const readStoredScheme = React.useCallback(() => {
    if (!schemeStorageKey) return null;
    try {
      return window.localStorage.getItem(schemeStorageKey);
    } catch {
      return null;
    }
  }, [schemeStorageKey]);

  const storeScheme = React.useCallback(
    (value: string) => {
      if (!schemeStorageKey) return;
      try {
        window.localStorage.setItem(schemeStorageKey, value);
      } catch {}
    },
    [schemeStorageKey]
  );

  const refreshSchemes = React.useCallback(async () => {
    if (!rootPath) return;
    const api = window.electronAPI;
    if (!api?.iosSimulatorSchemes) return;

    const cached = schemeCacheRef.current;
    if (cached && cached.path === rootPath && Date.now() - cached.timestamp < 10 * 60 * 1000) {
      setSchemes(cached.schemes);
      setDefaultScheme(cached.defaultScheme);
      setSchemeStatus('ready');
      setSchemeError(null);
      const previousSelection = selectedSchemeRef.current;
      let nextSelected: string | null = null;
      let nextHasUserSelected = hasUserSelectedSchemeRef.current;

      if (nextHasUserSelected && previousSelection && cached.schemes.includes(previousSelection)) {
        nextSelected = previousSelection;
      } else {
        const stored = readStoredScheme();
        if (stored && cached.schemes.includes(stored)) {
          nextSelected = stored;
          nextHasUserSelected = true;
        } else if (cached.defaultScheme && cached.schemes.includes(cached.defaultScheme)) {
          nextSelected = cached.defaultScheme;
          nextHasUserSelected = false;
        } else if (cached.schemes.length === 1) {
          nextSelected = cached.schemes[0];
          nextHasUserSelected = false;
        } else {
          nextSelected = null;
          nextHasUserSelected = false;
        }
      }

      setSelectedScheme(nextSelected);
      setHasUserSelectedScheme(nextHasUserSelected);
      return;
    }

    setSchemeStatus('loading');
    const res = await api.iosSimulatorSchemes({ projectPath: rootPath });
    if (!res.ok) {
      const message = res.error || 'Unable to load Xcode schemes.';
      setSchemeStatus('error');
      setSchemeError(message);
      setSchemes([]);
      setDefaultScheme(null);
      setSelectedScheme(null);
      setHasUserSelectedScheme(false);
      if (lastSchemeErrorRef.current !== message) {
        lastSchemeErrorRef.current = message;
        toast({
          title: 'Unable to load schemes',
          description: message,
          variant: 'destructive',
        });
      }
      return;
    }

    lastSchemeErrorRef.current = null;
    const nextSchemes = Array.isArray(res.schemes) ? res.schemes : [];
    const nextDefault = res.defaultScheme ?? null;
    schemeCacheRef.current = {
      path: rootPath,
      schemes: nextSchemes,
      defaultScheme: nextDefault,
      timestamp: Date.now(),
    };
    setSchemes(nextSchemes);
    setDefaultScheme(nextDefault);
    setSchemeStatus('ready');
    setSchemeError(null);

    const previousSelection = selectedSchemeRef.current;
    let nextSelected: string | null = null;
    let nextHasUserSelected = hasUserSelectedSchemeRef.current;

    if (nextHasUserSelected && previousSelection && nextSchemes.includes(previousSelection)) {
      nextSelected = previousSelection;
    } else {
      const stored = readStoredScheme();
      if (stored && nextSchemes.includes(stored)) {
        nextSelected = stored;
        nextHasUserSelected = true;
      } else if (nextDefault && nextSchemes.includes(nextDefault)) {
        nextSelected = nextDefault;
        nextHasUserSelected = false;
      } else if (nextSchemes.length === 1) {
        nextSelected = nextSchemes[0];
        nextHasUserSelected = false;
      } else {
        nextSelected = null;
        nextHasUserSelected = false;
      }
    }

    setSelectedScheme(nextSelected);
    setHasUserSelectedScheme(nextHasUserSelected);
  }, [readStoredScheme, rootPath, toast]);

  const refreshDeviceState = React.useCallback(async (opts?: { silent?: boolean }) => {
    const api = window.electronAPI;
    if (!api?.iosSimulatorList) return;
    if (!opts?.silent) {
      setDevicesStatus('loading');
      setBootedStatus('loading');
    }
    const res = await api.iosSimulatorList();
    if (res.ok && Array.isArray(res.devices)) {
      setAvailableDevices(res.devices);
      setBestUdid(res.bestUdid ?? null);
      setDevicesStatus('ready');
      setBootedDevices(res.devices.filter((device) => device.state === 'Booted'));
      setBootedStatus('ready');
    } else if (!opts?.silent) {
      setDevicesStatus('error');
      setBootedStatus('error');
    }
  }, []);

  const refreshDeviceStateWithFallback = React.useCallback(async () => {
    if (devicesStatus === 'loading' || bootedStatus === 'loading') return;
    setDevicesStatus('loading');
    setBootedStatus('loading');
    window.setTimeout(() => {
      setDevicesStatus((current) => (current === 'loading' ? 'ready' : current));
      setBootedStatus((current) => (current === 'loading' ? 'ready' : current));
    }, 700);
    await refreshDeviceState({ silent: true });
  }, [bootedStatus, devicesStatus, refreshDeviceState]);

  const refreshDeviceStateSoon = React.useCallback(() => {
    window.setTimeout(() => {
      void refreshDeviceState({ silent: true });
    }, 350);
  }, [refreshDeviceState]);

  React.useEffect(() => {
    if (!rootPath || !isIosProject) return;
    void refreshDeviceState();
    void refreshDeviceStateWithFallback();
    const interval = setInterval(() => {
      void refreshDeviceState({ silent: true });
    }, 8000);
    return () => clearInterval(interval);
  }, [isIosProject, refreshDeviceState, refreshDeviceStateWithFallback, rootPath]);

  const resetActionState = () => {
    setIsBusy(false);
    setActionStage(null);
    setActionStartedAt(null);
    setActionNow(null);
  };

  const handleCancel = async () => {
    resetActionState();
    setBootedDevices([]);
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
      refreshDeviceStateSoon();
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
            title: `Simulator ${stageLabel(launchRes.stage)} failed`,
            description: launchRes.error || 'Unable to launch simulator.',
            variant: 'destructive',
          });
          refreshDeviceStateSoon();
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
          title: `Run ${stageLabel(buildRes.stage)} failed`,
          description: buildRes.error || 'Unable to run the app.',
          variant: 'destructive',
        });
        return;
      }

      void refreshDeviceState();
      if (buildRes.details?.stdout || buildRes.details?.stderr) {
        console.info('[iOS Simulator] build output', buildRes.details);
      }
    } catch (error) {
      toast({
        title: 'Simulator command failed',
        description: error instanceof Error ? error.message : 'Unexpected simulator error.',
        variant: 'destructive',
      });
    } finally {
      resetActionState();
      refreshDeviceStateSoon();
    }
  };

  if (!rootPath || (!isIosProject && !isDetecting)) return null;

  return (
    <div
      className={cn(
        'flex items-center border-b border-border bg-muted px-2 py-1.5 dark:bg-background',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border border-border/70 bg-background/70">
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
                  setSelectedScheme(value);
                  setHasUserSelectedScheme(true);
                  storeScheme(value);
                }}
                disabled={
                  isBusy || isDetecting || schemeStatus === 'loading' || schemes.length === 0
                }
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
                    {schemes.map((scheme) => (
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
            disabled={
              isBusy || isDetecting || devicesStatus === 'loading' || bootedStatus === 'loading'
            }
          >
            <SelectTrigger
              aria-label="Simulator device"
              className="h-7 min-w-0 flex-1 rounded-none rounded-r-md border-none bg-transparent px-2 text-xs shadow-none"
            >
              <SelectValue placeholder={devicePlaceholder} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  Running
                </div>
                {bootedStatus === 'loading' ? (
                  <SelectItem value="running::loading" disabled className="text-xs">
                    Loading running simulators...
                  </SelectItem>
                ) : bootedStatus === 'error' ? (
                  <SelectItem value="running::error" disabled className="text-xs">
                    Unable to load running simulators
                  </SelectItem>
                ) : runningSimulators.length > 0 ? (
                  runningSimulators.map((device) => (
                    <SelectItem
                      key={device.udid}
                      value={`running::${device.udid}`}
                      className="text-xs"
                    >
                      {formatDeviceLabel(device)}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="running::none" disabled className="text-xs">
                    No running simulators
                  </SelectItem>
                )}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  New
                </div>
                {devicesStatus === 'loading' ? (
                  <SelectItem value="new::loading" disabled className="text-xs">
                    Loading devices...
                  </SelectItem>
                ) : devicesStatus === 'error' ? (
                  <SelectItem value="new::error" disabled className="text-xs">
                    Unable to load devices
                  </SelectItem>
                ) : newSimulators.length > 0 ? (
                  newSimulators.map((device) => (
                    <SelectItem key={device.udid} value={`new::${device.udid}`} className="text-xs">
                      {formatDeviceLabel(device)}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="new::none" disabled className="text-xs">
                    No available devices
                  </SelectItem>
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
};

export default IosSimulatorBar;
