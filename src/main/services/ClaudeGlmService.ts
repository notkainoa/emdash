import { log } from '../lib/logger';

export class ClaudeGlmService {
  private readonly SERVICE_NAME = 'emdash-claude-glm';
  private readonly ACCOUNT_NAME = 'api-key';

  async saveApiKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
    const clean = String(apiKey || '').trim();
    if (!clean) {
      return { success: false, error: 'A Z.AI API key is required.' };
    }

    try {
      const keytar = await import('keytar');
      await keytar.setPassword(this.SERVICE_NAME, this.ACCOUNT_NAME, clean);
      return { success: true };
    } catch (error) {
      log.error('Failed to store Z.AI API key:', error);
      return { success: false, error: 'Unable to store the API key securely.' };
    }
  }

  async clearApiKey(): Promise<{ success: boolean; error?: string }> {
    try {
      const keytar = await import('keytar');
      await keytar.deletePassword(this.SERVICE_NAME, this.ACCOUNT_NAME);
      return { success: true };
    } catch (error) {
      log.error('Failed to clear Z.AI API key:', error);
      return { success: false, error: 'Unable to remove the API key from keychain.' };
    }
  }

  async getApiKey(): Promise<string | null> {
    try {
      const keytar = await import('keytar');
      const value = await keytar.getPassword(this.SERVICE_NAME, this.ACCOUNT_NAME);
      return value || null;
    } catch (error) {
      log.error('Failed to read Z.AI API key:', error);
      return null;
    }
  }

  async checkConnection(): Promise<{ connected: boolean }> {
    const key = await this.getApiKey();
    return { connected: !!(key && key.trim()) };
  }
}

export const claudeGlmService = new ClaudeGlmService();
