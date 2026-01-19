import { ipcMain } from 'electron';
import {
  buildAndRunIosApp,
  cancelIosSimulatorTask,
  launchSimulator,
  getIosSimulatorSnapshot,
  startIosSimulatorPolling,
  stopIosSimulatorPolling,
  detectIosProject,
} from '../services/iosSimulatorService';

export function registerIosSimulatorIpc() {
  ipcMain.handle('ios:simulator:snapshot', async (_event, args: { projectPath: string }) => {
    const projectPath = String(args?.projectPath || '').trim();
    if (!projectPath) {
      return { ok: false, error: 'Project path is required.', stage: 'validation' };
    }
    return getIosSimulatorSnapshot(projectPath);
  });

  ipcMain.handle('ios:simulator:poller:start', async () => {
    startIosSimulatorPolling();
    return { ok: true };
  });

  ipcMain.handle('ios:simulator:poller:stop', async () => {
    stopIosSimulatorPolling();
    return { ok: true };
  });

  ipcMain.handle('ios:simulator:detect', async (_event, args: { projectPath: string }) => {
    const projectPath = String(args?.projectPath || '').trim();
    if (!projectPath) {
      return { ok: false, error: 'Project path is required.', stage: 'validation' };
    }
    return detectIosProject(projectPath);
  });

  ipcMain.handle('ios:simulator:launch', async (_event, args: { udid: string }) => {
    const udid = String(args?.udid || '').trim();
    if (!udid) return { ok: false, error: 'Simulator UDID is required.', stage: 'validation' };
    return launchSimulator(udid);
  });

  ipcMain.handle(
    'ios:simulator:build-run',
    async (_event, args: { projectPath: string; udid: string; scheme?: string }) => {
      const projectPath = String(args?.projectPath || '').trim();
      const udid = String(args?.udid || '').trim();
      if (!projectPath || !udid) {
        return {
          ok: false,
          error: 'Project path and simulator UDID are required.',
          stage: 'validation',
        };
      }
      const scheme = typeof args?.scheme === 'string' ? args.scheme.trim() : undefined;
      return buildAndRunIosApp(projectPath, udid, scheme);
    }
  );

  ipcMain.handle('ios:simulator:cancel', async () => {
    const cancelled = cancelIosSimulatorTask();
    return { ok: true, cancelled };
  });
}
