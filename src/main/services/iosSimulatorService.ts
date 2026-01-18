import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import os from 'os';

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

type SimBootedResult = {
  ok: boolean;
  devices?: SimDevice[];
  error?: string;
  stage?: string;
};

type SimLaunchResult = {
  ok: boolean;
  positioned?: boolean;
  error?: string;
  stage?: string;
};

type BuildRunResult = {
  ok: boolean;
  stage?: string;
  error?: string;
  details?: { stdout?: string; stderr?: string };
  scheme?: string;
  bundleId?: string;
  appPath?: string;
  derivedDataPath?: string;
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

type SchemeListResult = {
  ok: boolean;
  schemes?: string[];
  defaultScheme?: string | null;
  container?: XcodeContainer;
  error?: string;
  stage?: string;
};

type XcodeCandidate = XcodeContainer & { depth: number };

const OUTPUT_LIMIT = 1024 * 1024;
const MAX_PBXPROJ_READ = 512 * 1024;
const MAX_XCODE_SCAN_DEPTH = 3;
const MAX_FAILURE_RUNS = 3;
const BOOT_WAIT_MS = 10000;
const BOOT_POLL_INTERVAL_MS = 500;
const CANCELLED_MESSAGE = 'Cancelled';
const SCHEME_CACHE_TTL_MS = 10 * 60 * 1000;
const SIM_LIST_CACHE_TTL_MS = 800;
const CONTAINER_CACHE_TTL_MS = 10 * 60 * 1000;

const IOS_PBXPROJ_HINTS = [
  'SDKROOT = iphoneos',
  'SDKROOT = iphonesimulator',
  'IPHONEOS_DEPLOYMENT_TARGET',
  'TARGETED_DEVICE_FAMILY',
];

const XCODE_SCAN_IGNORES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'Pods',
  'DerivedData',
  '.swiftpm',
  '.build',
  'Carthage',
]);

type ActiveCommand = {
  child: ChildProcess;
  cancelled: boolean;
  taskId: number;
};

let activeCommand: ActiveCommand | null = null;
let activeTaskId: number | null = null;
let cancelRequested = false;
let lastSimList: { timestamp: number; result: SimListResult } | null = null;
const containerCache = new Map<string, { timestamp: number; result: XcodeContainer | null }>();
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

const formatDuration = (durationMs: number) => {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};

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

const logTimings = (label: string, timings: Record<string, number>) => {
  const parts = Object.entries(timings)
    .filter(([, duration]) => duration > 0)
    .map(([step, duration]) => `${step}=${formatDuration(duration)}`)
    .join(' ');
  if (!parts) return;
  console.info(`[iOS Simulator] ${label}: ${parts}`);
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

const scoreDevice = (device: SimDevice) => {
  let score = device.modelNumber;
  if (device.isIphone) score += 1000;
  if (device.state === 'Booted') score += 500;
  return score;
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
      const available =
        device.isAvailable !== false &&
        device.availabilityError !== 'unavailable' &&
        device.availabilityError !== 'not available';
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

const sleep = (durationMs: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const getSimulatorDevice = async (udid: string): Promise<SimDevice | null> => {
  const res = await runCommand('xcrun', ['simctl', 'list', '-j']);
  if (!res.ok) return null;
  const parsed = extractJson(res.stdout, res.stderr);
  const devices = parseSimctlList(parsed ?? res.stdout);
  return devices.find((device) => device.udid === udid) ?? null;
};

const isSimulatorBooted = async (udid: string) => {
  const device = await getSimulatorDevice(udid);
  return device?.state === 'Booted';
};

const waitForSimulatorBoot = async (udid: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BOOT_WAIT_MS) {
    if (cancelRequested) return false;
    const device = await getSimulatorDevice(udid);
    if (device?.state === 'Booted') return true;
    await sleep(BOOT_POLL_INTERVAL_MS);
  }
  return false;
};

const startSimulatorBoot = async (udid: string, taskId?: number) => {
  const bootRes = await runCommand('xcrun', ['simctl', 'boot', udid], { taskId });
  if (bootRes.ok) return { ok: true };
  if (bootRes.cancelled) {
    return { ok: false, cancelled: true, error: CANCELLED_MESSAGE };
  }
  const bootMessage = `${bootRes.stdout}\n${bootRes.stderr}`;
  const bootedError =
    bootMessage.includes('Unable to boot device in current state') &&
    bootMessage.includes('Booted');
  if (bootedError) {
    return { ok: true };
  }
  return { ok: false, error: bootRes.stderr || bootRes.error || 'Failed to boot simulator.' };
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

const normalizeToken = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '');

const isTestScheme = (name: string) => {
  const lowered = name.toLowerCase();
  return /\bui\s*tests?\b/.test(lowered) || /\btests?\b/.test(lowered);
};

const scoreScheme = (scheme: string, hints: string[]) => {
  let score = 0;
  const normalizedScheme = normalizeToken(scheme);
  for (const hint of hints) {
    const normalizedHint = normalizeToken(hint);
    if (!normalizedHint) continue;
    if (normalizedScheme === normalizedHint) {
      score += 120;
    } else if (normalizedScheme.startsWith(normalizedHint)) {
      score += 40;
    } else if (normalizedHint.startsWith(normalizedScheme)) {
      score += 20;
    }
  }
  if (/\bapp\b/i.test(scheme)) score += 10;
  if (/sample|demo|example/i.test(scheme)) score -= 25;
  if (isTestScheme(scheme)) score -= 200;
  return score;
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
  try {
    const content = await readTextChunk(filePath, MAX_PBXPROJ_READ);
    return IOS_PBXPROJ_HINTS.some((hint) => content.includes(hint));
  } catch {
    return false;
  }
};

const scanForXcodeContainers = async (
  rootPath: string,
  maxDepth: number
): Promise<XcodeCandidate[]> => {
  const rootBase = basename(rootPath);
  if (rootBase.endsWith('.xcworkspace')) {
    return [{ type: 'workspace', path: rootPath, depth: 0 }];
  }
  if (rootBase.endsWith('.xcodeproj')) {
    return [{ type: 'project', path: rootPath, depth: 0 }];
  }

  const results: XcodeCandidate[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { path: currentPath, depth } = current;
    if (depth >= maxDepth) continue;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (XCODE_SCAN_IGNORES.has(name)) continue;
      const fullPath = join(currentPath, name);
      if (name.endsWith('.xcworkspace')) {
        results.push({ type: 'workspace', path: fullPath, depth: depth + 1 });
        continue;
      }
      if (name.endsWith('.xcodeproj')) {
        results.push({ type: 'project', path: fullPath, depth: depth + 1 });
        continue;
      }
      stack.push({ path: fullPath, depth: depth + 1 });
    }
  }

  return results;
};

const scoreContainer = (candidate: XcodeCandidate, rootPath: string) => {
  let score = 0;
  if (candidate.type === 'workspace') score += 1000;
  const rootName = normalizeToken(basename(rootPath));
  const candidateName = normalizeToken(
    basename(candidate.path).replace(/\.xc(workspace|proj)$/i, '')
  );
  if (candidateName && rootName && candidateName === rootName) score += 200;

  const segments = candidate.path.split(/[\\/]/).map((segment) => segment.toLowerCase());
  if (segments.includes('ios')) score += 100;

  score += Math.max(0, (MAX_XCODE_SCAN_DEPTH - candidate.depth) * 10);
  return score;
};

const pickBestContainer = (
  candidates: XcodeCandidate[],
  rootPath: string
): XcodeContainer | null => {
  if (candidates.length === 0) return null;
  const scored = candidates.map((candidate) => ({
    candidate,
    score: scoreContainer(candidate, rootPath),
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.candidate.depth !== b.candidate.depth) return a.candidate.depth - b.candidate.depth;
    return a.candidate.path.localeCompare(b.candidate.path);
  });
  return scored[0]?.candidate ?? null;
};

const findXcodeContainer = async (projectPath: string): Promise<XcodeContainer | null> => {
  const cached = containerCache.get(projectPath);
  if (cached && Date.now() - cached.timestamp < CONTAINER_CACHE_TTL_MS) {
    return cached.result;
  }
  const candidates = await scanForXcodeContainers(projectPath, MAX_XCODE_SCAN_DEPTH);
  const result = pickBestContainer(candidates, projectPath);
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

const pickDefaultScheme = (
  schemes: string[],
  listPayload: any,
  container: XcodeContainer,
  projectPath: string
) => {
  if (schemes.length === 1) return schemes[0];

  const nonTestSchemes = schemes.filter((scheme) => !isTestScheme(scheme));
  if (nonTestSchemes.length === 1) return nonTestSchemes[0];

  const hints = [
    listPayload?.workspace?.name,
    listPayload?.project?.name,
    basename(container.path).replace(/\.xc(workspace|proj)$/i, ''),
    basename(projectPath),
  ].filter(Boolean) as string[];

  const scored = schemes.map((scheme) => ({
    scheme,
    score: scoreScheme(scheme, hints),
  }));

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.scheme.localeCompare(b.scheme);
  });

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best) return null;
  if (isTestScheme(best.scheme)) return null;

  const minScore = 80;
  const minGap = 15;
  if (best.score >= minScore && (!runnerUp || best.score - runnerUp.score >= minGap)) {
    return best.scheme;
  }

  return null;
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

  return Array.from(schemes);
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
      schemes: fsSchemes.sort((a, b) => a.localeCompare(b)),
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
  const schemes = resolveSchemes(listJson);
  if (schemes.length === 0) {
    const result = { ok: false, error: 'No schemes found for this project.', stage: 'schemes' };
    return result;
  }

  const result = { ok: true, schemes, listJson, container: resolved };
  schemeCache.set(cacheKey, { timestamp: Date.now(), result });
  return result;
};

export async function detectIosProject(projectPath: string): Promise<IosDetectResult> {
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

  return { ok: true, isIosProject: true, container };
}

export async function listXcodeSchemes(projectPath: string): Promise<SchemeListResult> {
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

  const listRes = await getXcodeSchemeList(projectPath);
  if (!listRes.ok || !listRes.schemes || !listRes.container) {
    return { ok: false, error: listRes.error, stage: listRes.stage };
  }

  const defaultScheme = listRes.listJson
    ? pickDefaultScheme(listRes.schemes, listRes.listJson, listRes.container, projectPath)
    : listRes.schemes.length === 1
      ? listRes.schemes[0]
      : null;

  return {
    ok: true,
    schemes: listRes.schemes,
    defaultScheme,
    container: listRes.container,
  };
}

export async function listIosSimulators(): Promise<SimListResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'iOS Simulator is only available on macOS.', stage: 'platform' };
  }

  if (lastSimList && Date.now() - lastSimList.timestamp < SIM_LIST_CACHE_TTL_MS) {
    return lastSimList.result;
  }

  const res = await runCommand('xcrun', ['simctl', 'list', '-j']);
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
    const sorted = devices.sort((a, b) => scoreDevice(b) - scoreDevice(a));
    const bestUdid = sorted[0]?.udid || null;
    const result = { ok: true, devices: sorted, bestUdid };
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
}

export async function getBootedSimulators(): Promise<SimBootedResult> {
  const list = await listIosSimulators();
  if (!list.ok || !list.devices) {
    return { ok: false, error: list.error, stage: list.stage };
  }
  return {
    ok: true,
    devices: list.devices.filter((device) => device.state === 'Booted'),
  };
}

export async function launchSimulator(udid: string): Promise<SimLaunchResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'iOS Simulator is only available on macOS.', stage: 'platform' };
  }
  if (!udid) return { ok: false, error: 'Simulator UDID is required.', stage: 'validation' };

  const taskId = startIosSimulatorTask();
  const timings: Record<string, number> = {};
  try {
    const alreadyBooted = await isSimulatorBooted(udid);

    if (!alreadyBooted) {
      const bootStart = Date.now();
      const bootRes = await runCommand('xcrun', ['simctl', 'boot', udid], { taskId });
      timings.boot = Date.now() - bootStart;
      if (!bootRes.ok) {
        if (bootRes.cancelled) {
          logTimings('launch', timings);
          return { ok: false, error: CANCELLED_MESSAGE, stage: 'cancelled' };
        }
        const bootMessage = `${bootRes.stdout}\n${bootRes.stderr}`;
        const bootedError =
          bootMessage.includes('Unable to boot device in current state') &&
          bootMessage.includes('Booted');
        if (!bootedError) {
          logTimings('launch', timings);
          return { ok: false, error: bootRes.stderr || bootRes.error, stage: 'boot' };
        }
      }

      const waitStart = Date.now();
      const ready = await waitForSimulatorBoot(udid);
      timings.bootstatus = Date.now() - waitStart;
      if (!ready) {
        logTimings('launch', timings);
        return {
          ok: false,
          error: cancelRequested ? CANCELLED_MESSAGE : 'Simulator boot timed out.',
          stage: cancelRequested ? 'cancelled' : 'bootstatus',
        };
      }
    }

    if (!alreadyBooted) {
      const openStart = Date.now();
      const openRes = await runCommand(
        'open',
        ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid],
        { taskId }
      );
      timings.open = Date.now() - openStart;
      if (!openRes.ok) {
        logTimings('launch', timings);
        return {
          ok: false,
          error: openRes.cancelled ? CANCELLED_MESSAGE : openRes.stderr || openRes.error,
          stage: openRes.cancelled ? 'cancelled' : 'open',
        };
      }
    }

    logTimings('launch', timings);
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

const readBundleId = async (appPath: string): Promise<string | null> => {
  const plistPath = join(appPath, 'Info.plist');
  const res = await runCommand('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    plistPath,
  ]);
  if (!res.ok) return null;
  const value = res.stdout.trim().split('\n').pop();
  return value ? value.trim() : null;
};

const readBundleExecutable = async (appPath: string): Promise<string | null> => {
  const plistPath = join(appPath, 'Info.plist');
  const res = await runCommand('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleExecutable',
    plistPath,
  ]);
  if (!res.ok) return null;
  const value = res.stdout.trim().split('\n').pop();
  return value ? value.trim() : null;
};

const getInstalledAppPath = async (udid: string, bundleId: string): Promise<string | null> => {
  const res = await runCommand('xcrun', ['simctl', 'get_app_container', udid, bundleId]);
  if (!res.ok) return null;
  const value = res.stdout.trim().split('\n').pop();
  return value ? value.trim() : null;
};

const buildDerivedDataPaths = (projectPath: string) => {
  const projectSlug = basename(projectPath).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const baseDir = join(os.tmpdir(), 'emdash-ios', projectSlug);
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

const buildDerivedDataRunDir = (baseDir: string) => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = join(baseDir, 'runs', runId);
  return { runId, runDir };
};

const pruneFailureRuns = async (failuresDir: string) => {
  try {
    const entries = await fs.readdir(failuresDir, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(failuresDir, entry.name));
    const stats = await Promise.all(
      dirs.map(async (dir) => {
        try {
          const info = await fs.stat(dir);
          return { dir, mtime: info.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const sorted = stats.filter(Boolean) as Array<{ dir: string; mtime: number }>;
    sorted.sort((a, b) => b.mtime - a.mtime);
    const excess = sorted.slice(MAX_FAILURE_RUNS);
    for (const entry of excess) {
      try {
        await fs.rm(entry.dir, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
};

const moveRunToFailures = async (baseDir: string, runDir: string, runId: string) => {
  const failuresDir = join(baseDir, 'failures');
  try {
    await fs.mkdir(failuresDir, { recursive: true });
  } catch {}

  let finalPath = runDir;
  try {
    finalPath = join(failuresDir, runId);
    await fs.rename(runDir, finalPath);
  } catch {
    finalPath = runDir;
  }

  await pruneFailureRuns(failuresDir);
  return finalPath;
};

const cleanupRunDir = async (runDir: string) => {
  try {
    await fs.rm(runDir, { recursive: true, force: true });
  } catch {}
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
      const listSchemes = listRes.listJson ? listRes.schemes : undefined;
      const defaultScheme = listSchemes
        ? pickDefaultScheme(listSchemes, listRes.listJson, listRes.container, projectPath)
        : listRes.schemes?.length === 1
          ? listRes.schemes[0]
          : null;
      selectedScheme = defaultScheme || (listRes.schemes.length === 1 ? listRes.schemes[0] : null);

      if (!selectedScheme) {
        return { ok: false, error: 'Select a scheme to build and run.', stage: 'schemes' };
      }
    }

    const { baseDir, derivedDataDir } = buildDerivedDataPaths(projectPath);
    const { runDir, runId } = buildDerivedDataRunDir(baseDir);
    const derivedDataReady = await ensureDirectory(derivedDataDir);
    const runDirReady = await ensureDirectory(runDir);
    if (!derivedDataReady || !runDirReady) {
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
      appPath?: string;
    }): Promise<BuildRunResult> => {
      const failurePath = await moveRunToFailures(baseDir, runDir, runId);
      return {
        ok: false,
        stage: args.stage,
        error: args.error,
        details: args.details,
        scheme: selectedScheme ?? undefined,
        derivedDataPath: failurePath,
        appPath: args.appPath,
      };
    };

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

    const timings: Record<string, number> = {};

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

    const bootStart = Date.now();
    const bootPromise = startSimulatorBoot(udid, taskId);

    const buildStart = Date.now();
    const buildRes = await runCommand('xcodebuild', buildArgs, { cwd: projectPath, taskId });
    timings.build = Date.now() - buildStart;
    if (!buildRes.ok) {
      logTimings('build-run', timings);
      return await fail({
        stage: buildRes.cancelled ? 'cancelled' : 'build',
        error: buildRes.cancelled
          ? CANCELLED_MESSAGE
          : buildRes.stderr || buildRes.error || 'Build failed.',
        details: { stdout: buildRes.stdout, stderr: buildRes.stderr },
      });
    }

    if (buildRes.stdout || buildRes.stderr) {
      try {
        const buildLogPath = join(runDir, 'xcodebuild.log');
        await fs.writeFile(
          buildLogPath,
          [buildRes.stdout, buildRes.stderr].filter(Boolean).join('\n')
        );
      } catch {}
    }

    const appPath = await findBuiltApp(derivedDataDir, selectedScheme);
    if (appPath) {
      try {
        await fs.cp(appPath, join(runDir, basename(appPath)), { recursive: true });
      } catch {}
    }
    if (!appPath) {
      logTimings('build-run', timings);
      return await fail({ stage: 'app', error: 'Unable to locate built app.' });
    }

    const bootRes = await bootPromise;
    timings.boot = Date.now() - bootStart;
    if (!bootRes.ok) {
      logTimings('build-run', timings);
      return await fail({
        stage: bootRes.cancelled ? 'cancelled' : 'boot',
        error: bootRes.cancelled ? CANCELLED_MESSAGE : bootRes.error || 'Failed to boot simulator.',
      });
    }

    const waitStart = Date.now();
    const ready = await waitForSimulatorBoot(udid);
    timings.bootstatus = Date.now() - waitStart;
    if (!ready) {
      logTimings('build-run', timings);
      return await fail({
        stage: cancelRequested ? 'cancelled' : 'bootstatus',
        error: cancelRequested ? CANCELLED_MESSAGE : 'Simulator boot timed out.',
      });
    }

    if (cancelRequested) {
      logTimings('build-run', timings);
      return await fail({ stage: 'cancelled', error: CANCELLED_MESSAGE, appPath });
    }

    const bundleId = await readBundleId(appPath);
    if (!bundleId) {
      logTimings('build-run', timings);
      return await fail({
        stage: 'bundle-id',
        error: 'Unable to read bundle identifier.',
        appPath,
      });
    }

    const installStart = Date.now();
    let didInstall = false;
    let installedAppPath = await getInstalledAppPath(udid, bundleId);
    const executableName = await readBundleExecutable(appPath);
    if (!installedAppPath || !executableName) {
      const installRes = await runCommand('xcrun', ['simctl', 'install', udid, appPath], {
        taskId,
      });
      timings.install = Date.now() - installStart;
      if (!installRes.ok) {
        logTimings('build-run', timings);
        return await fail({
          stage: installRes.cancelled ? 'cancelled' : 'install',
          error: installRes.cancelled
            ? CANCELLED_MESSAGE
            : installRes.stderr || installRes.error || 'Failed to install app.',
        });
      }
      didInstall = true;
      installedAppPath = await getInstalledAppPath(udid, bundleId);
    }

    if (!installedAppPath || !executableName) {
      timings.install = Date.now() - installStart;
      logTimings('build-run', timings);
      return await fail({
        stage: 'install',
        error: 'Unable to resolve installed app path.',
        appPath,
      });
    }

    try {
      const sourceBinary = join(appPath, executableName);
      const targetBinary = join(installedAppPath, executableName);
      await fs.copyFile(sourceBinary, targetBinary);
    } catch {
      if (!didInstall) {
        const installRes = await runCommand('xcrun', ['simctl', 'install', udid, appPath], {
          taskId,
        });
        timings.install = Date.now() - installStart;
        if (!installRes.ok) {
          logTimings('build-run', timings);
          return await fail({
            stage: installRes.cancelled ? 'cancelled' : 'install',
            error: installRes.cancelled
              ? CANCELLED_MESSAGE
              : installRes.stderr || installRes.error || 'Failed to install app.',
          });
        }
      }
    }

    if (!timings.install) {
      timings.install = Date.now() - installStart;
    }

    const launchStart = Date.now();
    const launchRes = await runCommand('xcrun', ['simctl', 'launch', udid, bundleId], {
      taskId,
    });
    timings.launch = Date.now() - launchStart;
    if (!launchRes.ok) {
      logTimings('build-run', timings);
      return await fail({
        stage: launchRes.cancelled ? 'cancelled' : 'launch',
        error: launchRes.cancelled
          ? CANCELLED_MESSAGE
          : launchRes.stderr || launchRes.error || 'Failed to launch app.',
      });
    }

    logTimings('build-run', timings);
    await cleanupRunDir(runDir);

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
