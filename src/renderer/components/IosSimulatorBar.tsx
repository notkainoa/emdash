import React from 'react';
import { Cable, Play } from 'lucide-react';
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

const IOS_DEVICE_OPTIONS = [
  { id: 'iphone-17', label: 'iPhone 17' },
  { id: 'iphone-17-pro', label: 'iPhone 17 Pro' },
  { id: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max' },
  { id: 'iphone-16', label: 'iPhone 16' },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro' },
  { id: 'ipad-pro-13', label: 'iPad Pro (13-inch)' },
] as const;

const IOS_PBXPROJ_HINTS = [
  'SDKROOT = iphoneos',
  'SDKROOT = iphonesimulator',
  'IPHONEOS_DEPLOYMENT_TARGET',
  'TARGETED_DEVICE_FAMILY',
];

const detectIosProject = async (rootPath: string): Promise<boolean> => {
  try {
    const api = (window as any).electronAPI;
    if (!api?.fsList) return false;
    const res = await api.fsList(rootPath, { includeDirs: true, maxEntries: 2000 });
    const items = Array.isArray(res?.items) ? res.items : [];
    const xcodeProjects = items.filter(
      (item: { path: string; type: 'file' | 'dir' }) =>
        item.type === 'dir' && item.path.endsWith('.xcodeproj')
    );
    const hasWorkspace = items.some(
      (item: { path: string; type: 'file' | 'dir' }) =>
        item.type === 'dir' && item.path.endsWith('.xcworkspace')
    );
    if (xcodeProjects.length === 0 && !hasWorkspace) return false;

    if (api?.fsRead) {
      for (const project of xcodeProjects) {
        const pbxprojPath = `${project.path}/project.pbxproj`;
        const pbxprojRes = await api.fsRead(rootPath, pbxprojPath, 512 * 1024);
        const content = pbxprojRes?.content;
        if (
          typeof content === 'string' &&
          IOS_PBXPROJ_HINTS.some((hint) => content.includes(hint))
        ) {
          return true;
        }
      }
    }

    return hasWorkspace;
  } catch {
    return false;
  }
};

interface IosSimulatorBarProps {
  projectPath?: string | null;
  taskPath?: string | null;
  className?: string;
}

const IosSimulatorBar: React.FC<IosSimulatorBarProps> = ({
  projectPath,
  taskPath,
  className,
}) => {
  const rootPath = React.useMemo(() => (projectPath || taskPath || '').trim(), [
    projectPath,
    taskPath,
  ]);
  const [isIosProject, setIsIosProject] = React.useState(false);
  const [targetId, setTargetId] = React.useState(`new::${IOS_DEVICE_OPTIONS[0].id}`);
  const runningSimulators: Array<{ id: string; label: string }> = [];

  React.useEffect(() => {
    let cancelled = false;
    if (!rootPath) {
      setIsIosProject(false);
      return () => undefined;
    }
    void (async () => {
      const detected = await detectIosProject(rootPath);
      if (!cancelled) setIsIosProject(detected);
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  if (!rootPath || !isIosProject) return null;

  const parseTargetId = (value: string): { mode: 'running' | 'new'; id: string } | null => {
    const [mode, id] = value.split('::');
    if (!id || (mode !== 'running' && mode !== 'new')) return null;
    return { mode, id };
  };

  const selectedTarget = parseTargetId(targetId) || { mode: 'new', id: IOS_DEVICE_OPTIONS[0].id };
  const actionLabel = selectedTarget.mode === 'running' ? 'Attach' : 'Run';
  const actionHint = selectedTarget.mode === 'running' ? 'Running' : 'New';
  const ActionIcon = selectedTarget.mode === 'running' ? Cable : Play;
  const actionTitle =
    selectedTarget.mode === 'running'
      ? 'Attach to a running simulator'
      : 'Build and run in a new simulator';

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
          >
            <ActionIcon className="mr-1.5 h-3.5 w-3.5" />
            <span>{actionLabel}</span>
            <span className="ml-1.5 rounded-sm border border-border/70 bg-muted/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {actionHint}
            </span>
          </Button>
          <div className="h-6 w-px bg-border/70" />
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger
              aria-label="Simulator device"
              className="h-7 min-w-0 flex-1 rounded-none rounded-r-md border-none bg-transparent px-2 text-xs shadow-none"
            >
              <SelectValue placeholder="Select simulator" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                  Running
                </div>
                {runningSimulators.length > 0 ? (
                  runningSimulators.map((sim) => (
                    <SelectItem key={sim.id} value={`running::${sim.id}`} className="text-xs">
                      {sim.label}
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
                {IOS_DEVICE_OPTIONS.map((device) => (
                  <SelectItem key={device.id} value={`new::${device.id}`} className="text-xs">
                    {device.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
};

export default IosSimulatorBar;
