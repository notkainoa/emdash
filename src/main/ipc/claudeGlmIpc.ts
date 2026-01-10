import { ipcMain } from 'electron';
import { claudeGlmService } from '../services/ClaudeGlmService';
import { worktreeService } from '../services/WorktreeService';

export function registerClaudeGlmIpc() {
  ipcMain.handle('claude-glm:saveKey', async (_event, apiKey: string) => {
    if (!apiKey || typeof apiKey !== 'string') {
      return { success: false, error: 'A Z.AI API key is required.' };
    }

    const result = await claudeGlmService.saveApiKey(apiKey);
    if (result.success) {
      await worktreeService.applyClaudeGlmKeyToWorktrees(apiKey);
    }
    return result;
  });

  ipcMain.handle('claude-glm:clearKey', async () => {
    const result = await claudeGlmService.clearApiKey();
    if (result.success) {
      await worktreeService.clearClaudeGlmSettingsForWorktrees();
    }
    return result;
  });

  ipcMain.handle('claude-glm:check', async () => {
    return claudeGlmService.checkConnection();
  });
}
