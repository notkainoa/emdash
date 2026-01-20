/**
 * Shared iOS simulator types used across main process and renderer.
 */

export type IosSimRuntime = {
  identifier: string;
  name: string;
  platform?: string;
  version?: string;
};

export type IosSimDevice = {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  runtime: IosSimRuntime;
  isIphone: boolean;
  modelNumber: number;
};

export type IosXcodeContainer = {
  type: 'workspace' | 'project';
  path: string;
};

export type IosSimulatorDetectResult = {
  ok: boolean;
  isIosProject?: boolean;
  container?: IosXcodeContainer;
  error?: string;
  stage?: string;
};

export type IosSimulatorLaunchResult = {
  ok: boolean;
  positioned?: boolean;
  error?: string;
  stage?: string;
};

export type IosSimulatorBuildRunResult = {
  ok: boolean;
  stage?: string;
  error?: string;
  details?: { stdout?: string; stderr?: string; logPath?: string };
  scheme?: string;
  bundleId?: string;
  appPath?: string;
  derivedDataPath?: string;
};

export type IosSimulatorSnapshotResult = {
  ok: boolean;
  isIosProject?: boolean;
  container?: IosXcodeContainer;
  devices?: IosSimDevice[];
  booted?: IosSimDevice[];
  bestUdid?: string | null;
  schemes?: string[];
  defaultScheme?: string | null;
  error?: string;
  stage?: string;
  details?: { stdout?: string; stderr?: string; logPath?: string };
};
