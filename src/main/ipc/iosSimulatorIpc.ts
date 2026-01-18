import { ipcMain } from 'electron';
import {
  buildAndRunIosApp,
  detectIosProject,
  getBootedSimulators,
  launchSimulator,
  listIosSimulators,
  listXcodeSchemes,
} from '../services/iosSimulatorService';

export function registerIosSimulatorIpc() {
  ipcMain.handle('ios:simulator:list', async () => listIosSimulators());

  ipcMain.handle('ios:simulator:booted', async () => getBootedSimulators());

  ipcMain.handle('ios:simulator:detect', async (_event, args: { projectPath: string }) => {
    const projectPath = String(args?.projectPath || '').trim();
    if (!projectPath) {
      return { ok: false, error: 'Project path is required.', stage: 'validation' };
    }
    return detectIosProject(projectPath);
  });

  ipcMain.handle('ios:simulator:schemes', async (_event, args: { projectPath: string }) => {
    const projectPath = String(args?.projectPath || '').trim();
    if (!projectPath) {
      return { ok: false, error: 'Project path is required.', stage: 'validation' };
    }
    return listXcodeSchemes(projectPath);
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
}
