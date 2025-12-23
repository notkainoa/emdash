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
      try {
        log.debug('acp:custom-commands:ipc:scan:request', { projectPath, providerId });
        const commands = await scanCustomCommands(projectPath, providerId as ProviderId);
        log.debug('acp:custom-commands:ipc:scan:complete', { count: commands.length, providerId });
        return { success: true, commands };
      } catch (error: unknown) {
        const errorMessage =
          error && typeof error === 'object' && 'message' in error
            ? String(error.message)
            : String(error);
        log.error('acp:custom-commands:ipc:scan:failed', {
          projectPath,
          providerId,
          error: errorMessage,
        });
        return { success: false, error: errorMessage || 'Failed to scan custom commands' };
      }
    }
  );
}
