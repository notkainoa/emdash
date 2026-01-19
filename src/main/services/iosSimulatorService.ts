import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import os from 'os';
import crypto from 'crypto';

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  cancelled?: boolean;
};

type SimRuntime = {
  identifier: string;
  name: string;
  platform?: string;
  version?: string;
  isAvailable?: boolean;
};

type SimDevice = {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  runtime: SimRuntime;
  isIphone: boolean;
  modelNumber: number;
};

type SimListResult = {
  ok: boolean;
  devices?: SimDevice[];
  bestUdid?: string | null;
  error?: string;
  stage?: string;
};

type SimLaunchResult = {
  ok: boolean;
  positioned?: boolean;
  error?: string;
  stage?: string;
};

type SnapshotResult = {
  ok: boolean;
  isIosProject?: boolean;
  container?: XcodeContainer;
  devices?: SimDevice[];
  booted?: SimDevice[];
  bestUdid?: string | null;
  schemes?: string[];
  defaultScheme?: string | null;
  error?: string;
  stage?: string;
  details?: { stdout?: string; stderr?: string; logPath?: string };
};

type SimulatorCache = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  devices: SimDevice[];
  booted: SimDevice[];
  bestUdid: string | null;
  error?: string;
  stage?: string;
  lastUpdated: number;
};

type BuildRunResult = {
  ok: boolean;
  stage?: string;
  error?: string;
  details?: { stdout?: string; stderr?: string; logPath?: string };
  scheme?: string;
  bundleId?: string;
  appPath?: string;
  derivedDataPath?: string;
};

type XcodeCheckResult = {
  ok: boolean;
  error?: string;
};

type XcodeContainer = {
  type: 'workspace' | 'project';
  path: string;
};

type IosDetectResult = {
  ok: boolean;
  isIosProject?: boolean;
  container?: XcodeContainer;
  error?: string;
  stage?: string;
};

const OUTPUT_LIMIT = 1024 * 1024;
const MAX_PBXPROJ_READ = 512 * 1024;
const MAX_PBXPROJ_FULL_READ = 5 * 1024 * 1024;
const BOOT_WAIT_MS = 10000;
const CANCELLED_MESSAGE = 'Cancelled';
const SCHEME_CACHE_TTL_MS = 10 * 60 * 1000;
const SIM_LIST_CACHE_TTL_MS = 800;
const CONTAINER_CACHE_TTL_MS = 10 * 60 * 1000;
const IOS_HINT_CACHE_TTL_MS = 10 * 60 * 1000;
const SIM_POLL_INTERVAL_MS = 15000;
const SIM_POLL_MIN_REFRESH_MS = 3000;

const IOS_PBXPROJ_HINTS = [
  'SDKROOT = iphoneos',
  'SDKROOT = iphonesimulator',
  'IPHONEOS_DEPLOYMENT_TARGET',
  'TARGETED_DEVICE_FAMILY',
];

type ActiveCommand = {
  child: ChildProcess;
  cancelled: boolean;
  taskId: number;
};

let activeCommand: ActiveCommand | null = null;
let activeTaskId: number | null = null;
let cancelRequested = false;
let lastSimList: { timestamp: number; result: SimListResult } | null = null;
let simListInFlight: Promise<SimListResult> | null = null;
let simPollInterval: NodeJS.Timeout | null = null;
let simPollRefCount = 0;
let simCache: SimulatorCache = {
  status: 'idle',
  devices: [],
  booted: [],
  bestUdid: null,
  lastUpdated: 0,
};
let snapshotInFlight = new Map<string, Promise<SnapshotResult>>();
let detectInFlight = new Map<string, Promise<IosDetectResult>>();
const containerCache = new Map<string, { timestamp: number; result: XcodeContainer | null }>();
const iosHintCache = new Map<string, { timestamp: number; result: boolean }>();
const schemeCache = new Map<
  string,
  {
    timestamp: number;
    result: {
      ok: boolean;
      schemes?: string[];
      listJson?: any;
      container?: XcodeContainer;
      error?: string;
    };
  }
>();

const startIosSimulatorTask = () => {
  cancelRequested = false;
  activeTaskId = Date.now() + Math.random();
  return activeTaskId;
};

const finishIosSimulatorTask = (taskId: number) => {
  if (activeTaskId !== taskId) return;
  activeTaskId = null;
  cancelRequested = false;
};

const runCommand = (
  command: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; taskId?: number }
): Promise<CommandResult> =>
  new Promise((resolve) => {
    try {
      const taskId = opts?.taskId;
      const shouldTrack = Boolean(taskId && taskId === activeTaskId);
      if (shouldTrack && cancelRequested) {
        resolve({
          ok: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          error: CANCELLED_MESSAGE,
          cancelled: true,
        });
        return;
      }
      const child = spawn(command, args, { cwd: opts?.cwd });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const record: ActiveCommand = { child, cancelled: false, taskId: taskId ?? -1 };
      if (shouldTrack) activeCommand = record;
      const timeout = opts?.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            record.cancelled = true;
            child.kill();
          }, opts.timeoutMs)
        : null;

      const append = (current: string, chunk: Buffer) => {
        if (current.length >= OUTPUT_LIMIT) return current;
        const next = current + chunk.toString();
        return next.length > OUTPUT_LIMIT ? next.slice(0, OUTPUT_LIMIT) : next;
      };

      child.stdout?.on('data', (data) => {
        stdout = append(stdout, data);
      });
      child.stderr?.on('data', (data) => {
        stderr = append(stderr, data);
      });

      child.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        if (activeCommand === record) activeCommand = null;
        resolve({
          ok: false,
          stdout,
          stderr,
          exitCode: null,
          error: error instanceof Error ? error.message : String(error),
          cancelled: record.cancelled,
        });
      });

      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        if (activeCommand === record) activeCommand = null;
        if (shouldTrack && cancelRequested) {
          record.cancelled = true;
        }
        resolve({
          ok: !timedOut && !record.cancelled && code === 0,
          stdout,
          stderr,
          exitCode: code ?? null,
          error: timedOut ? 'Command timeout' : record.cancelled ? CANCELLED_MESSAGE : undefined,
          cancelled: record.cancelled,
        });
      });
    } catch (error) {
      if (activeCommand?.child) activeCommand = null;
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const cancelIosSimulatorTask = () => {
  cancelRequested = true;
  if (activeCommand?.child) {
    activeCommand.cancelled = true;
    try {
      activeCommand.child.kill();
    } catch {}
    return true;
  }
  return activeTaskId !== null;
};

const checkXcodeAvailability = async (): Promise<XcodeCheckResult> => {
  const res = await runCommand('xcodebuild', ['-version']);
  if (res.ok) return { ok: true };
  const stderr = res.stderr || res.error || '';
  if (stderr.includes('xcode-select')) {
    return {
      ok: false,
      error: 'Xcode is not installed. Install Xcode to use iOS simulators.',
    };
  }
  return {
    ok: false,
    error: stderr || 'Xcode is not installed. Install Xcode to use iOS simulators.',
  };
};

const isIosRuntime = (runtime: SimRuntime) => {
  const platform = runtime.platform || '';
  const name = runtime.name || '';
  const id = runtime.identifier || '';
  return (
    platform.toLowerCase() === 'ios' ||
    name.toLowerCase().startsWith('ios') ||
    id.toLowerCase().includes('ios')
  );
};

const parseModelNumber = (name: string) => {
  const match = name.match(/\b(\d{1,2})\b/);
  if (!match) return 0;
  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? 0 : value;
};

const parseSimctlList = (payload: string | any): SimDevice[] => {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const runtimes: SimRuntime[] = Array.isArray(data?.runtimes) ? data.runtimes : [];
  const devices = data?.devices && typeof data.devices === 'object' ? data.devices : {};
  const runtimeMap = new Map<string, SimRuntime>();

  for (const runtime of runtimes) {
    if (!runtime?.identifier) continue;
    runtimeMap.set(runtime.identifier, runtime);
  }

  const output: SimDevice[] = [];
  for (const [runtimeId, runtimeDevices] of Object.entries(devices)) {
    const runtime = runtimeMap.get(runtimeId);
    if (!runtime || !isIosRuntime(runtime)) continue;
    if (runtime.isAvailable === false) continue;
    const list = Array.isArray(runtimeDevices) ? runtimeDevices : [];
    for (const device of list) {
      if (!device?.udid || !device?.name) continue;
      const availabilityError = String(device.availabilityError ?? '').toLowerCase();
      const available =
        device.isAvailable !== false &&
        availabilityError !== 'unavailable' &&
        availabilityError !== 'not available';
      if (!available) continue;
      const name = String(device.name);
      output.push({
        name,
        udid: String(device.udid),
        state: String(device.state || 'Unknown'),
        isAvailable: available,
        runtime,
        isIphone: name.toLowerCase().startsWith('iphone'),
        modelNumber: parseModelNumber(name),
      });
    }
  }
  return output;
};

const extractJson = (stdout: string, stderr: string) => {
  const candidates = [stdout, stderr, [stdout, stderr].filter(Boolean).join('\n')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) continue;
    const json = candidate.slice(start, end + 1);
    try {
      return JSON.parse(json);
    } catch {
      continue;
    }
  }
  return null;
};

const isTestScheme = (name: string) => {
  const lowered = name.toLowerCase();
  return /\bui\s*tests?\b/.test(lowered) || /\btests?\b/.test(lowered);
};

const readTextChunk = async (filePath: string, maxBytes: number) => {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.slice(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

const fileHasIosHints = async (filePath: string) => {
  const cached = iosHintCache.get(filePath);
  if (cached && Date.now() - cached.timestamp < IOS_HINT_CACHE_TTL_MS) {
    return cached.result;
  }
  try {
    const content = await readTextChunk(filePath, MAX_PBXPROJ_READ);
    let hasHints = IOS_PBXPROJ_HINTS.some((hint) => content.includes(hint));
    if (!hasHints) {
      const fullContent = await readTextChunk(filePath, MAX_PBXPROJ_FULL_READ);
      hasHints = IOS_PBXPROJ_HINTS.some((hint) => fullContent.includes(hint));
    }
    iosHintCache.set(filePath, { timestamp: Date.now(), result: hasHints });
    return hasHints;
  } catch {
    iosHintCache.set(filePath, { timestamp: Date.now(), result: false });
    return false;
  }
};

const findDirectXcodeContainer = async (rootPath: string): Promise<XcodeContainer | null> => {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const workspaces = entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcworkspace'))
      .map((entry) => entry.name);
    if (workspaces[0]) {
      return { type: 'workspace', path: join(rootPath, workspaces[0]) };
    }
    const projects = entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
      .map((entry) => entry.name);
    if (projects[0]) {
      return { type: 'project', path: join(rootPath, projects[0]) };
    }
  } catch {}
  return null;
};

const findXcodeContainer = async (projectPath: string): Promise<XcodeContainer | null> => {
  const cached = containerCache.get(projectPath);
  if (cached && Date.now() - cached.timestamp < CONTAINER_CACHE_TTL_MS) {
    return cached.result;
  }

  const candidates: string[] = [projectPath, join(projectPath, 'ios')];
  const buckets = [join(projectPath, 'apps'), join(projectPath, 'packages')];
  for (const bucket of buckets) {
    try {
      const entries = await fs.readdir(bucket, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        candidates.push(join(bucket, entry.name, 'ios'));
      }
    } catch {}
  }

  let result: XcodeContainer | null = null;
  for (const candidate of candidates) {
    result = await findDirectXcodeContainer(candidate);
    if (result) break;
  }

  containerCache.set(projectPath, { timestamp: Date.now(), result });
  return result;
};

const parseWorkspaceProjects = async (workspacePath: string): Promise<string[]> => {
  const dataPath = join(workspacePath, 'contents.xcworkspacedata');
  let content = '';
  try {
    content = await fs.readFile(dataPath, 'utf8');
  } catch {
    return [];
  }
  const projects = new Set<string>();
  const matches = content.matchAll(/location="([^"]+)"/g);
  for (const match of matches) {
    const raw = match[1];
    const [prefix, rest] = raw.split(':', 2);
    if (!rest) continue;
    let resolved: string | null = null;
    if (prefix === 'group' || prefix === 'self') {
      resolved = join(workspacePath, rest);
    } else if (prefix === 'absolute') {
      resolved = rest;
    }
    if (!resolved || !resolved.endsWith('.xcodeproj')) continue;
    projects.add(resolved);
  }
  return Array.from(projects);
};

const workspaceHasIosHints = async (workspacePath: string): Promise<boolean | null> => {
  const projects = await parseWorkspaceProjects(workspacePath);
  if (projects.length === 0) return null;
  for (const projectPath of projects) {
    const pbxprojPath = join(projectPath, 'project.pbxproj');
    if (await fileHasIosHints(pbxprojPath)) return true;
  }
  return false;
};

const resolveSchemes = (payload: any): string[] => {
  const workspaceSchemes = payload?.workspace?.schemes;
  if (Array.isArray(workspaceSchemes) && workspaceSchemes.length > 0) return workspaceSchemes;
  const projectSchemes = payload?.project?.schemes;
  if (Array.isArray(projectSchemes) && projectSchemes.length > 0) return projectSchemes;
  return [];
};

const pickDefaultScheme = (schemes: string[]) => {
  if (schemes.length === 0) return null;
  const nonTestSchemes = schemes.filter((scheme) => !isTestScheme(scheme));
  return nonTestSchemes[0] ?? schemes[0] ?? null;
};

const readXcodeSchemesFromFilesystem = async (container: XcodeContainer) => {
  const basePath = container.path;
  const sharedPath = join(basePath, 'xcshareddata', 'xcschemes');
  const userRoot = join(basePath, 'xcuserdata');
  const schemes = new Set<string>();

  try {
    const sharedEntries = await fs.readdir(sharedPath, { withFileTypes: true });
    for (const entry of sharedEntries) {
      if (!entry.isDirectory() && entry.name.endsWith('.xcscheme')) {
        schemes.add(entry.name.replace(/\.xcscheme$/i, ''));
      }
    }
  } catch {}

  try {
    const userEntries = await fs.readdir(userRoot, { withFileTypes: true });
    for (const entry of userEntries) {
      if (!entry.isDirectory()) continue;
      const userSchemesPath = join(userRoot, entry.name, 'xcschemes');
      try {
        const userSchemes = await fs.readdir(userSchemesPath, { withFileTypes: true });
        for (const schemeEntry of userSchemes) {
          if (!schemeEntry.isDirectory() && schemeEntry.name.endsWith('.xcscheme')) {
            schemes.add(schemeEntry.name.replace(/\.xcscheme$/i, ''));
          }
        }
      } catch {}
    }
  } catch {}

  return Array.from(schemes).sort((a, b) => a.localeCompare(b));
};

const readBuildSettings = async (
  projectPath: string,
  container: XcodeContainer,
  scheme: string
): Promise<{
  ok: boolean;
  settings?: string;
  error?: string;
  details?: { stdout?: string; stderr?: string };
}> => {
  const args = [
    '-showBuildSettings',
    container.type === 'workspace' ? '-workspace' : '-project',
    container.path,
    '-scheme',
    scheme,
  ];
  const res = await runCommand('xcodebuild', args, { cwd: projectPath, timeoutMs: 10000 });
  if (!res.ok) {
    return {
      ok: false,
      error: res.stderr || res.error || 'Failed to read build settings.',
      details: { stdout: res.stdout, stderr: res.stderr },
    };
  }
  return { ok: true, settings: [res.stdout, res.stderr].filter(Boolean).join('\n') };
};

const buildSettingsHasIosPlatform = (settings?: string | null) => {
  if (!settings) return false;
  const lowered = settings.toLowerCase();
  return (
    lowered.includes('sdkroot = iphone') ||
    lowered.includes('supported_platforms = iphone') ||
    lowered.includes('supported_platforms = iphonesimulator')
  );
};

const getXcodeSchemeList = async (
  projectPath: string,
  container?: XcodeContainer
): Promise<{
  ok: boolean;
  schemes?: string[];
  listJson?: any;
  container?: XcodeContainer;
  error?: string;
  stage?: string;
  details?: { stdout?: string; stderr?: string };
}> => {
  const resolved = container ?? (await findXcodeContainer(projectPath));
  if (!resolved) {
    return { ok: false, error: 'No Xcode workspace or project found.', stage: 'container' };
  }

  const cacheKey = `${resolved.type}:${resolved.path}`;
  const cached = schemeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SCHEME_CACHE_TTL_MS) {
    return cached.result;
  }

  const cachedContainer = containerCache.get(projectPath);
  if (!cachedContainer || cachedContainer.result?.path !== resolved.path) {
    containerCache.set(projectPath, { timestamp: Date.now(), result: resolved });
  }

  const fsSchemes = await readXcodeSchemesFromFilesystem(resolved);
  if (fsSchemes.length > 0) {
    const result = {
      ok: true,
      schemes: fsSchemes,
      listJson: null,
      container: resolved,
    };
    schemeCache.set(cacheKey, { timestamp: Date.now(), result });
    return result;
  }

  const listArgs = [
    '-list',
    '-json',
    resolved.type === 'workspace' ? '-workspace' : '-project',
    resolved.path,
  ];
  const listRes = await runCommand('xcodebuild', listArgs, {
    cwd: projectPath,
    timeoutMs: 10000,
  });
  if (!listRes.ok) {
    const result = {
      ok: false,
      error: listRes.stderr || listRes.error || 'Failed to list Xcode schemes.',
      stage: 'schemes',
      details: { stdout: listRes.stdout, stderr: listRes.stderr },
    };
    return result;
  }

  const listJson = extractJson(listRes.stdout, listRes.stderr);
  if (!listJson) {
    const result = { ok: false, error: 'Unable to parse Xcode schemes.', stage: 'schemes' };
    return result;
  }
  const schemes = resolveSchemes(listJson).sort((a, b) => a.localeCompare(b));
  if (schemes.length === 0) {
    const result = { ok: false, error: 'No schemes found for this project.', stage: 'schemes' };
    return result;
  }

  const result = { ok: true, schemes, listJson, container: resolved };
  schemeCache.set(cacheKey, { timestamp: Date.now(), result });
  return result;
};

export async function detectIosProject(projectPath: string): Promise<IosDetectResult> {
  const cached = detectInFlight.get(projectPath);
  if (cached) return cached;
  const task = (async (): Promise<IosDetectResult> => {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'iOS Simulator is only available on macOS.', stage: 'platform' };
    }
    if (!projectPath) {
      return { ok: false, error: 'Project path is required.', stage: 'validation' };
    }

    try {
      const stats = await fs.stat(projectPath);
      if (!stats.isDirectory()) {
        return { ok: false, error: 'Project path is not a directory.', stage: 'validation' };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Invalid project path.',
        stage: 'validation',
      };
    }

    const container = await findXcodeContainer(projectPath);
    if (!container) {
      return { ok: false, error: 'No Xcode workspace or project found.', stage: 'container' };
    }

    let hasIosHints = false;
    if (container.type === 'workspace') {
      const workspaceHints = await workspaceHasIosHints(container.path);
      hasIosHints = workspaceHints ?? false;
    } else {
      const pbxprojPath = join(container.path, 'project.pbxproj');
      hasIosHints = await fileHasIosHints(pbxprojPath);
    }

    if (!hasIosHints) {
      const schemeList = await getXcodeSchemeList(projectPath, container);
      const candidateScheme = schemeList.schemes?.find((scheme) => !isTestScheme(scheme));
      if (candidateScheme && schemeList.container) {
        const settingsRes = await readBuildSettings(
          projectPath,
          schemeList.container,
          candidateScheme
        );
        if (settingsRes.ok && buildSettingsHasIosPlatform(settingsRes.settings)) {
          return { ok: true, isIosProject: true, container: schemeList.container };
        }
        return {
          ok: false,
          error: settingsRes.error || 'No iOS targets detected.',
          stage: 'build',
        };
      }
      return {
        ok: false,
        error: schemeList.error || 'No iOS targets detected.',
        stage: schemeList.stage ?? 'schemes',
      };
    }

    return { ok: true, isIosProject: true, container };
  })();
  detectInFlight.set(projectPath, task);
  try {
    return await task;
  } finally {
    detectInFlight.delete(projectPath);
  }
}

export async function getIosSimulatorSnapshot(projectPath: string): Promise<SnapshotResult> {
  const cached = snapshotInFlight.get(projectPath);
  if (cached) return cached;
  const task = (async (): Promise<SnapshotResult> => {
    const [simState, schemes] = await Promise.all([
      refreshSimulators(),
      getXcodeSchemeList(projectPath),
    ]);

    if (!simState.devices.length && simState.status === 'error') {
      return {
        ok: false,
        isIosProject: true,
        error: simState.error || 'Unable to load simulators.',
        stage: simState.stage,
      };
    }

    if (!schemes.ok || !schemes.schemes || !schemes.container) {
      return {
        ok: false,
        isIosProject: true,
        devices: simState.devices,
        booted: simState.booted,
        bestUdid: simState.bestUdid,
        error: schemes.error || 'Unable to load schemes.',
        stage: schemes.stage,
        details: schemes.details,
      };
    }

    return {
      ok: true,
      isIosProject: true,
      container: schemes.container,
      devices: simState.devices,
      booted: simState.booted,
      bestUdid: simState.bestUdid,
      schemes: schemes.schemes,
      defaultScheme: pickDefaultScheme(schemes.schemes),
    };
  })();
  snapshotInFlight.set(projectPath, task);
  try {
    return await task;
  } finally {
    snapshotInFlight.delete(projectPath);
  }
}

export async function listIosSimulators(force = false): Promise<SimListResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'iOS Simulator is only available on macOS.', stage: 'platform' };
  }

  const now = Date.now();
  if (!force && lastSimList && now - lastSimList.timestamp < SIM_LIST_CACHE_TTL_MS) {
    return lastSimList.result;
  }

  if (!force && simListInFlight) {
    return simListInFlight;
  }

  const task = (async () => {
    const xcodeCheck = await checkXcodeAvailability();
    if (!xcodeCheck.ok) {
      const result = {
        ok: false,
        error: xcodeCheck.error,
        stage: 'xcode',
      };
      lastSimList = { timestamp: Date.now(), result };
      return result;
    }

    const res = await runCommand('xcrun', ['simctl', 'list', '-j', 'devices', 'runtimes']);
    if (!res.ok) {
      const result = {
        ok: false,
        error: res.stderr || res.error || 'Failed to list simulators.',
        stage: res.cancelled ? 'cancelled' : 'simctl',
      };
      lastSimList = { timestamp: Date.now(), result };
      return result;
    }
    try {
      const parsed = extractJson(res.stdout, res.stderr);
      const devices = parseSimctlList(parsed ?? res.stdout);
      const bestUdid = devices[0]?.udid || null;
      const result = { ok: true, devices, bestUdid };
      lastSimList = { timestamp: Date.now(), result };
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to parse simulator list.',
        stage: 'parse',
      };
      lastSimList = { timestamp: Date.now(), result };
      return result;
    }
  })();

  simListInFlight = task;
  try {
    return await task;
  } finally {
    simListInFlight = null;
  }
}

const refreshSimulators = async (force = false): Promise<SimulatorCache> => {
  const now = Date.now();
  if (!force && now - simCache.lastUpdated < SIM_POLL_MIN_REFRESH_MS) {
    return simCache;
  }
  simCache = { ...simCache, status: 'loading' };
  const list = await listIosSimulators(force);
  if (!list.ok || !list.devices) {
    simCache = {
      ...simCache,
      status: 'error',
      error: list.error || 'Failed to load simulators.',
      stage: list.stage,
      lastUpdated: Date.now(),
    };
    return simCache;
  }
  if (list.devices.length === 0) {
    simCache = {
      status: 'error',
      devices: [],
      booted: [],
      bestUdid: null,
      error: 'No iOS simulators are available.',
      stage: 'simctl',
      lastUpdated: Date.now(),
    };
    return simCache;
  }
  const booted = list.devices.filter((device) => device.state === 'Booted');
  simCache = {
    status: 'ready',
    devices: list.devices,
    booted,
    bestUdid: list.bestUdid ?? null,
    lastUpdated: Date.now(),
  };
  return simCache;
};

export const startIosSimulatorPolling = () => {
  simPollRefCount += 1;
  if (simPollInterval) return;
  void refreshSimulators(true);
  simPollInterval = setInterval(() => {
    void refreshSimulators();
  }, SIM_POLL_INTERVAL_MS);
};

export const stopIosSimulatorPolling = () => {
  simPollRefCount = Math.max(0, simPollRefCount - 1);
  if (simPollRefCount > 0) return;
  if (simPollInterval) {
    clearInterval(simPollInterval);
    simPollInterval = null;
  }
};

export async function launchSimulator(udid: string): Promise<SimLaunchResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'iOS Simulator is only available on macOS.', stage: 'platform' };
  }
  if (!udid) return { ok: false, error: 'Simulator UDID is required.', stage: 'validation' };

  const xcodeCheck = await checkXcodeAvailability();
  if (!xcodeCheck.ok) {
    return { ok: false, error: xcodeCheck.error, stage: 'xcode' };
  }

  const taskId = startIosSimulatorTask();
  try {
    const bootRes = await runCommand('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
      taskId,
      timeoutMs: BOOT_WAIT_MS,
    });
    if (!bootRes.ok && !bootRes.cancelled) {
      return {
        ok: false,
        error: bootRes.error || bootRes.stderr || 'Failed to boot simulator.',
        stage: 'boot',
      };
    }

    const openRes = await runCommand(
      'open',
      ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid],
      { taskId }
    );
    if (!openRes.ok && !openRes.cancelled) {
      return {
        ok: false,
        error: openRes.error || openRes.stderr || 'Failed to open Simulator.',
        stage: 'open',
      };
    }

    return { ok: true };
  } finally {
    finishIosSimulatorTask(taskId);
  }
}

const findBuiltApp = async (derivedDataPath: string, scheme: string): Promise<string | null> => {
  const productsDir = join(derivedDataPath, 'Build', 'Products');
  const candidates = ['Debug-iphonesimulator', 'Release-iphonesimulator'];
  for (const candidate of candidates) {
    const dirPath = join(productsDir, candidate);
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const apps = entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
        .map((entry) => entry.name)
        .sort();
      if (apps.length === 0) continue;
      const exact = apps.find((app) => app === `${scheme}.app`);
      const selected = exact || apps[0];
      return join(dirPath, selected);
    } catch {
      continue;
    }
  }
  return null;
};

const buildDerivedDataPaths = (projectPath: string) => {
  const projectSlug = basename(projectPath).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const hash = crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 8);
  const baseDir = join(os.tmpdir(), 'emdash-ios', `${projectSlug}-${hash}`);
  const derivedDataDir = join(baseDir, 'derived-data');
  return { baseDir, derivedDataDir };
};

const ensureDirectory = async (dirPath: string) => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
};

export async function buildAndRunIosApp(
  projectPath: string,
  udid: string,
  scheme?: string
): Promise<BuildRunResult> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'iOS Simulator is only available on macOS.',
      stage: 'platform',
    };
  }

  if (!projectPath || !udid) {
    return {
      ok: false,
      error: 'Project path and simulator UDID are required.',
      stage: 'validation',
    };
  }

  const xcodeCheck = await checkXcodeAvailability();
  if (!xcodeCheck.ok) {
    return { ok: false, error: xcodeCheck.error, stage: 'xcode' };
  }

  const taskId = startIosSimulatorTask();
  try {
    const stats = await fs.stat(projectPath);
    if (!stats.isDirectory()) {
      return { ok: false, error: 'Project path is not a directory.', stage: 'validation' };
    }
  } catch (error) {
    finishIosSimulatorTask(taskId);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid project path.',
      stage: 'validation',
    };
  }

  try {
    const requestedScheme = String(scheme ?? '').trim();
    let container: XcodeContainer | null = null;
    let selectedScheme: string | null = requestedScheme || null;

    if (requestedScheme) {
      container = await findXcodeContainer(projectPath);
      if (!container) {
        return { ok: false, error: 'No Xcode workspace or project found.', stage: 'container' };
      }
    } else {
      const listRes = await getXcodeSchemeList(projectPath);
      if (!listRes.ok || !listRes.schemes || !listRes.container) {
        return {
          ok: false,
          error: listRes.error || 'Failed to resolve Xcode schemes.',
          stage: listRes.stage,
          details: listRes.details,
        };
      }

      container = listRes.container;
      selectedScheme = pickDefaultScheme(listRes.schemes);

      if (!selectedScheme) {
        return { ok: false, error: 'Select a scheme to build and run.', stage: 'schemes' };
      }
    }

    if (!container || !selectedScheme) {
      return {
        ok: false,
        error: 'Unable to resolve build settings.',
        stage: 'build',
      };
    }

    if (cancelRequested) {
      return { ok: false, error: CANCELLED_MESSAGE, stage: 'cancelled' };
    }

    const { derivedDataDir } = buildDerivedDataPaths(projectPath);
    const derivedDataReady = await ensureDirectory(derivedDataDir);
    if (!derivedDataReady) {
      return {
        ok: false,
        error: 'Failed to prepare build directory.',
        stage: 'build',
      };
    }

    const fail = async (args: {
      stage: string;
      error: string;
      details?: { stdout?: string; stderr?: string };
    }): Promise<BuildRunResult> => {
      const logDir = join(os.tmpdir(), 'emdash-ios');
      const logPath = join(logDir, `simulator-failure-${Date.now()}.log`);
      try {
        await fs.mkdir(logDir, { recursive: true });
        await fs.writeFile(
          logPath,
          [args.details?.stdout, args.details?.stderr].filter(Boolean).join('\n')
        );
      } catch {}
      return {
        ok: false,
        stage: args.stage,
        error: args.error,
        details: { ...args.details, logPath },
        scheme: selectedScheme ?? undefined,
      };
    };

    const buildArgs = [
      container.type === 'workspace' ? '-workspace' : '-project',
      container.path,
      '-scheme',
      selectedScheme,
      '-configuration',
      'Debug',
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath',
      derivedDataDir,
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'COMPILER_INDEX_STORE_ENABLE=NO',
      'build',
    ];

    const bootRes = await runCommand('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
      taskId,
      timeoutMs: BOOT_WAIT_MS,
    });
    if (!bootRes.ok && !bootRes.cancelled) {
      return await fail({
        stage: 'boot',
        error: bootRes.error || bootRes.stderr || 'Failed to boot simulator.',
        details: { stdout: bootRes.stdout, stderr: bootRes.stderr },
      });
    }

    const buildRes = await runCommand('xcodebuild', buildArgs, { cwd: projectPath, taskId });
    if (!buildRes.ok) {
      return await fail({
        stage: buildRes.cancelled ? 'cancelled' : 'build',
        error: buildRes.cancelled
          ? CANCELLED_MESSAGE
          : buildRes.stderr || buildRes.error || 'Build failed.',
        details: { stdout: buildRes.stdout, stderr: buildRes.stderr },
      });
    }

    const appPath = await findBuiltApp(derivedDataDir, selectedScheme);
    if (!appPath) {
      return await fail({ stage: 'app', error: 'Unable to locate built app.' });
    }

    const bundleRes = await runCommand('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleIdentifier',
      join(appPath, 'Info.plist'),
    ]);
    const bundleId = bundleRes.ok ? bundleRes.stdout.trim().split('\n').pop()?.trim() : null;
    if (!bundleId) {
      return await fail({
        stage: 'bundle-id',
        error: bundleRes.error || bundleRes.stderr || 'Unable to read bundle identifier.',
        details: { stdout: bundleRes.stdout, stderr: bundleRes.stderr },
      });
    }

    const installRes = await runCommand('xcrun', ['simctl', 'install', udid, appPath], { taskId });
    if (!installRes.ok) {
      return await fail({
        stage: installRes.cancelled ? 'cancelled' : 'install',
        error: installRes.cancelled
          ? CANCELLED_MESSAGE
          : installRes.stderr || installRes.error || 'Failed to install app.',
        details: { stdout: installRes.stdout, stderr: installRes.stderr },
      });
    }

    const launchRes = await runCommand('xcrun', ['simctl', 'launch', udid, bundleId], { taskId });
    if (!launchRes.ok) {
      return await fail({
        stage: launchRes.cancelled ? 'cancelled' : 'launch',
        error: launchRes.cancelled
          ? CANCELLED_MESSAGE
          : launchRes.stderr || launchRes.error || 'Failed to launch app.',
        details: { stdout: launchRes.stdout, stderr: launchRes.stderr },
      });
    }

    return {
      ok: true,
      scheme: selectedScheme ?? undefined,
      bundleId,
      appPath,
    };
  } finally {
    finishIosSimulatorTask(taskId);
  }
}
