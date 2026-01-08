import { log } from '../lib/logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Service for handling worktree-specific configuration setup
 * including Claude Code settings and git ignore patterns
 */
export class WorktreeConfigService {
  /**
   * Ensure codex logs are ignored in this worktree by adding to .git/info/exclude
   */
  ensureCodexLogIgnored(worktreePath: string): void {
    try {
      const gitMeta = path.join(worktreePath, '.git');
      let gitDir = gitMeta;
      if (fs.existsSync(gitMeta) && fs.statSync(gitMeta).isFile()) {
        try {
          const content = fs.readFileSync(gitMeta, 'utf8');
          const m = content.match(/gitdir:\s*(.*)\s*$/i);
          if (m && m[1]) {
            gitDir = path.resolve(worktreePath, m[1].trim());
          }
        } catch (err) {
          log.debug('Failed to read .git file for gitdir resolution', err);
        }
      }
      const excludePath = path.join(gitDir, 'info', 'exclude');
      try {
        const dir = path.dirname(excludePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let current = '';
        try {
          current = fs.readFileSync(excludePath, 'utf8');
        } catch (err) {
          log.debug('Failed to read .git/info/exclude', err);
        }
        if (!current.includes('codex-stream.log')) {
          fs.appendFileSync(
            excludePath,
            (current.endsWith('\n') || current === '' ? '' : '\n') + 'codex-stream.log\n'
          );
        }
      } catch (err) {
        log.debug('Failed to update .git/info/exclude', err);
      }
    } catch (err) {
      log.debug('Failed to set up codex log ignore', err);
    }
  }

  /**
   * Set up Claude Code auto-approve settings in the worktree
   */
  ensureClaudeAutoApprove(worktreePath: string): void {
    try {
      const claudeDir = path.join(worktreePath, '.claude');
      const settingsPath = path.join(claudeDir, 'settings.json');

      // Create .claude directory if it doesn't exist
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      // Read existing settings or create new
      let settings: any = {};
      if (fs.existsSync(settingsPath)) {
        try {
          const content = fs.readFileSync(settingsPath, 'utf8');
          settings = JSON.parse(content);
        } catch (err) {
          log.warn('Failed to parse existing .claude/settings.json, will overwrite', err);
        }
      }

      // Set defaultMode to bypassPermissions (preserve other settings)
      settings = { ...settings, defaultMode: 'bypassPermissions' };

      // Write settings file
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      log.info(`Created .claude/settings.json with auto-approve enabled in ${worktreePath}`);
    } catch (err) {
      log.error('Failed to create .claude/settings.json', err);
    }
  }
}

export const worktreeConfigService = new WorktreeConfigService();
