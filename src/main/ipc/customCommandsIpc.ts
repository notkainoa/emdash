/**
 * IPC handlers for custom slash commands
 */

import { ipcMain } from 'electron';
import { log } from '../lib/logger';
import { scanCustomCommands } from '../../shared/providers/customCommands';
import type { ProviderId } from '../../shared/providers/registry';

export function registerCustomCommandsHandlers(): void {
  ipcMain.handle(
    'custom-commands:scan',
    async (_event, args: { projectPath: string; providerId: string }) => {
      const { projectPath, providerId } = args;
      console.log('[custom-commands IPC] Received scan request', { projectPath, providerId });
      try {
        log.debug('Scanning custom commands', { projectPath, providerId });
        const commands = await scanCustomCommands(projectPath, providerId as ProviderId);
        console.log('[custom-commands IPC] Scan complete', { count: commands.length, providerId });
        log.debug('Found custom commands', { count: commands.length, providerId });
        return { success: true, commands };
      } catch (error: unknown) {
        const errorMessage =
          error && typeof error === 'object' && 'message' in error
            ? String(error.message)
            : String(error);
        console.error('[custom-commands IPC] Scan failed', {
          projectPath,
          providerId,
          error: errorMessage,
        });
        log.error('Failed to scan custom commands', {
          projectPath,
          providerId,
          error: errorMessage,
        });
        return { success: false, error: errorMessage || 'Failed to scan custom commands' };
      }
    }
  );
}
