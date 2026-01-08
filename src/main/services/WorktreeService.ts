import { execFile } from 'child_process';
import { log } from '../lib/logger';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import {
  slugify,
  stableIdFromPath,
  renderBranchNameTemplate,
  extractTemplatePrefix,
  type BaseRefInfo,
  type PreserveResult,
} from '../lib/worktreeUtils';
import { worktreeFileService } from './WorktreeFileService';
import { worktreeConfigService } from './WorktreeConfigService';
import * as GitService from './GitService';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  id: string;
  name: string;
  branch: string;
  path: string;
  projectId: string;
  status: 'active' | 'paused' | 'completed' | 'error';
  createdAt: string;
  lastActivity?: string;
}

// Re-export PreserveResult for backward compatibility
export type { PreserveResult } from '../lib/worktreeUtils';

export class WorktreeService {
  private worktrees = new Map<string, WorktreeInfo>();

  /**
   * Create a new Git worktree for an agent task
   */
  async createWorktree(
    projectPath: string,
    taskName: string,
    projectId: string,
    autoApprove?: boolean
  ): Promise<WorktreeInfo> {
    try {
      const sluggedName = slugify(taskName);
      const timestamp = Date.now();
      const { getAppSettings } = await import('../settings');
      const settings = getAppSettings();
      const template = settings?.repository?.branchTemplate || 'agent/{slug}-{timestamp}';
      const branchName = renderBranchNameTemplate(template, {
        slug: sluggedName,
        timestamp: String(timestamp),
      });
      const worktreePath = path.join(projectPath, '..', `worktrees/${sluggedName}-${timestamp}`);
      const worktreeId = stableIdFromPath(worktreePath);

      log.info(`Creating worktree: ${branchName} -> ${worktreePath}`);

      // Check if worktree path already exists
      if (fs.existsSync(worktreePath)) {
        throw new Error(`Worktree directory already exists: ${worktreePath}`);
      }

      // Ensure worktrees directory exists
      const worktreesDir = path.dirname(worktreePath);
      if (!fs.existsSync(worktreesDir)) {
        fs.mkdirSync(worktreesDir, { recursive: true });
      }

      const baseRefInfo = await GitService.resolveProjectBaseRef(projectPath, projectId);
      const fetchedBaseRef = await GitService.fetchBaseRefWithFallback(
        projectPath,
        projectId,
        baseRefInfo
      );

      // Create the worktree
      await GitService.createGitWorktree(
        projectPath,
        branchName,
        worktreePath,
        fetchedBaseRef.fullRef
      );

      // Verify the worktree was actually created
      if (!fs.existsSync(worktreePath)) {
        throw new Error(`Worktree directory was not created: ${worktreePath}`);
      }

      // Ensure codex logs are ignored in this worktree
      worktreeConfigService.ensureCodexLogIgnored(worktreePath);

      // Preserve .env and other gitignored config files from source to worktree
      try {
        const patterns = worktreeFileService.getPreservePatterns(projectPath);
        await worktreeFileService.preserveFilesToWorktree(projectPath, worktreePath, patterns);
      } catch (preserveErr) {
        log.warn('Failed to preserve files to worktree (continuing):', preserveErr);
      }

      // Setup Claude Code settings if auto-approve is enabled
      if (autoApprove) {
        worktreeConfigService.ensureClaudeAutoApprove(worktreePath);
      }

      await logWorktreeSyncStatus(projectPath, worktreePath, fetchedBaseRef);

      const worktreeInfo: WorktreeInfo = {
        id: worktreeId,
        name: taskName,
        branch: branchName,
        path: worktreePath,
        projectId,
        status: 'active',
        createdAt: new Date().toISOString(),
      };

      this.worktrees.set(worktreeInfo.id, worktreeInfo);

      log.info(`Created worktree: ${taskName} -> ${branchName}`);

      // Push the new branch to origin and set upstream so PRs work out of the box
      // Only if a remote exists
      if (settings?.repository?.pushOnCreate !== false && fetchedBaseRef.remote) {
        try {
          await GitService.pushBranch(projectPath, fetchedBaseRef.remote, branchName);
          log.info(
            `Pushed branch ${branchName} to ${fetchedBaseRef.remote} with upstream tracking`
          );
        } catch (pushErr) {
          log.warn('Initial push of worktree branch failed:', pushErr as any);
          // Don't fail worktree creation if push fails - user can push manually later
        }
      } else if (!fetchedBaseRef.remote) {
        log.info(
          `Skipping push for worktree branch ${branchName} - no remote configured (local-only repo)`
        );
      }

      return worktreeInfo;
    } catch (error) {
      log.error('Failed to create worktree:', error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message || 'Failed to create worktree');
    }
  }

  async fetchLatestBaseRef(projectPath: string, projectId: string): Promise<BaseRefInfo> {
    return GitService.fetchLatestBaseRef(projectPath, projectId);
  }

  /**
   * List all worktrees for a project
   */
  async listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await GitService.listGitWorktrees(projectPath);

      const worktrees: WorktreeInfo[] = [];
      const lines = stdout.trim().split('\n');
      // Compute managed prefixes based on configured template
      let managedPrefixes: string[] = ['agent', 'pr', 'orch'];
      try {
        const { getAppSettings } = await import('../settings');
        const settings = getAppSettings();
        const p = extractTemplatePrefix(settings?.repository?.branchTemplate);
        if (p) managedPrefixes = Array.from(new Set([p, ...managedPrefixes]));
      } catch {}

      for (const line of lines) {
        if (line.includes('[') && line.includes(']')) {
          const parts = line.split(/\s+/);
          const worktreePath = parts[0];
          const branchMatch = line.match(/\[([^\]]+)\]/);
          const branch = branchMatch ? branchMatch[1] : 'unknown';

          const managedBranch = managedPrefixes.some((pf) => {
            return (
              branch.startsWith(pf + '/') ||
              branch.startsWith(pf + '-') ||
              branch.startsWith(pf + '_') ||
              branch.startsWith(pf + '.') ||
              branch === pf
            );
          });

          if (!managedBranch) {
            const tracked = Array.from(this.worktrees.values()).find(
              (wt) => wt.path === worktreePath
            );
            if (!tracked) continue;
          }

          const existing = Array.from(this.worktrees.values()).find(
            (wt) => wt.path === worktreePath
          );

          worktrees.push(
            existing ?? {
              id: stableIdFromPath(worktreePath),
              name: path.basename(worktreePath),
              branch,
              path: worktreePath,
              projectId: path.basename(projectPath),
              status: 'active',
              createdAt: new Date().toISOString(),
            }
          );
        }
      }

      return worktrees;
    } catch (error) {
      log.error('Failed to list worktrees:', error);
      return [];
    }
  }

  /**
   * Remove a worktree
   */
  async removeWorktree(
    projectPath: string,
    worktreeId: string,
    worktreePath?: string,
    branch?: string
  ): Promise<void> {
    try {
      const worktree = this.worktrees.get(worktreeId);

      const pathToRemove = worktree?.path ?? worktreePath;
      const branchToDelete = worktree?.branch ?? branch;

      if (!pathToRemove) {
        throw new Error('Worktree path not provided');
      }

      // Remove the worktree directory via git first
      try {
        await GitService.removeGitWorktree(projectPath, pathToRemove);
      } catch (gitError) {
        console.warn('git worktree remove failed, attempting filesystem cleanup', gitError);
      }

      // Best-effort prune to clear any stale worktree metadata that can keep a branch "checked out"
      try {
        await GitService.pruneGitWorktrees(projectPath);
      } catch (pruneErr) {
        console.warn('git worktree prune failed (continuing):', pruneErr);
      }

      // Ensure directory is removed even if git command failed
      if (fs.existsSync(pathToRemove)) {
        try {
          await fs.promises.rm(pathToRemove, { recursive: true, force: true });
        } catch (rmErr: any) {
          // Handle permission issues by making files writable, then retry
          if (rmErr && (rmErr.code === 'EACCES' || rmErr.code === 'EPERM')) {
            try {
              if (process.platform === 'win32') {
                // Remove read-only attribute recursively on Windows
                await execFileAsync('cmd', [
                  '/c',
                  'attrib',
                  '-R',
                  '/S',
                  '/D',
                  pathToRemove + '\\*',
                ]);
              } else {
                // Make everything writable on POSIX
                await execFileAsync('chmod', ['-R', 'u+w', pathToRemove]);
              }
            } catch (permErr) {
              console.warn('Failed to adjust permissions for worktree cleanup:', permErr);
            }
            // Retry removal once after permissions adjusted
            await fs.promises.rm(pathToRemove, { recursive: true, force: true });
          } else {
            throw rmErr;
          }
        }
      }

      if (branchToDelete) {
        const tryDeleteBranch = async () => await GitService.deleteBranch(projectPath, branchToDelete!);
        try {
          await tryDeleteBranch();
        } catch (branchError: any) {
          const msg = String(branchError?.stderr || branchError?.message || branchError);
          // If git thinks the branch is still checked out in a (now removed) worktree,
          // prune and retry once more.
          if (/checked out at /.test(msg)) {
            try {
              await GitService.pruneGitWorktrees(projectPath);
              await tryDeleteBranch();
            } catch (retryErr) {
              console.warn(`Failed to delete branch ${branchToDelete} after prune:`, retryErr);
            }
          } else {
            console.warn(`Failed to delete branch ${branchToDelete}:`, branchError);
          }
        }

        // Only try to delete remote branch if a remote exists
        const remoteAlias = 'origin';
        const hasRemote = await GitService.hasRemote(projectPath, remoteAlias);
        if (hasRemote) {
          let remoteBranchName = branchToDelete;
          if (branchToDelete.startsWith('origin/')) {
            remoteBranchName = branchToDelete.replace(/^origin\//, '');
          }
          try {
            await GitService.deleteRemoteBranch(projectPath, remoteAlias, remoteBranchName);
            log.info(`Deleted remote branch ${remoteAlias}/${remoteBranchName}`);
          } catch (remoteError: any) {
            const msg = String(remoteError?.stderr || remoteError?.message || remoteError);
            if (
              /remote ref does not exist/i.test(msg) ||
              /unknown revision/i.test(msg) ||
              /not found/i.test(msg)
            ) {
              log.info(`Remote branch ${remoteAlias}/${remoteBranchName} already absent`);
            } else {
              log.warn(
                `Failed to delete remote branch ${remoteAlias}/${remoteBranchName}:`,
                remoteError
              );
            }
          }
        } else {
          log.info(`Skipping remote branch deletion - no remote configured (local-only repo)`);
        }
      }

      if (worktree) {
        this.worktrees.delete(worktreeId);
        log.info(`Removed worktree: ${worktree.name}`);
      } else {
        log.info(`Removed worktree ${worktreeId}`);
      }
    } catch (error) {
      log.error('Failed to remove worktree:', error);
      throw new Error(`Failed to remove worktree: ${error}`);
    }
  }

  /**
   * Get worktree status and changes
   */
  async getWorktreeStatus(worktreePath: string): Promise<{
    hasChanges: boolean;
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
  }> {
    return GitService.getWorktreeStatus(worktreePath);
  }

  /**
   * Merge worktree changes back to main branch
   */
  async mergeWorktreeChanges(projectPath: string, worktreeId: string): Promise<void> {
    try {
      const worktree = this.worktrees.get(worktreeId);
      if (!worktree) {
        throw new Error('Worktree not found');
      }

      const defaultBranch = await GitService.getDefaultBranch(projectPath);

      // Switch to default branch
      await GitService.checkoutBranch(projectPath, defaultBranch);

      // Merge the worktree branch
      await GitService.mergeBranch(projectPath, worktree.branch);

      // Remove the worktree
      await this.removeWorktree(projectPath, worktreeId);

      log.info(`Merged worktree changes: ${worktree.name}`);
    } catch (error) {
      log.error('Failed to merge worktree changes:', error);
      throw new Error(`Failed to merge worktree changes: ${error}`);
    }
  }

  /**
   * Get worktree by ID
   */
  getWorktree(worktreeId: string): WorktreeInfo | undefined {
    return this.worktrees.get(worktreeId);
  }

  /**
   * Get all worktrees
   */
  getAllWorktrees(): WorktreeInfo[] {
    return Array.from(this.worktrees.values());
  }

  /**
   * Preserve gitignored files (like .env) from source to destination worktree.
   * Only copies files that match the preserve patterns and don't exist in destination.
   * Public method for backward compatibility - delegates to WorktreeFileService.
   */
  async preserveFilesToWorktree(
    sourceDir: string,
    destDir: string,
    patterns?: string[],
    excludePatterns?: string[]
  ): Promise<PreserveResult> {
    return worktreeFileService.preserveFilesToWorktree(sourceDir, destDir, patterns, excludePatterns);
  }

  async createWorktreeFromBranch(
    projectPath: string,
    taskName: string,
    branchName: string,
    projectId: string,
    options?: { worktreePath?: string }
  ): Promise<WorktreeInfo> {
    const normalizedName = taskName || branchName.replace(/\//g, '-');
    const sluggedName = slugify(normalizedName) || 'task';
    const targetPath =
      options?.worktreePath ||
      path.join(projectPath, '..', `worktrees/${sluggedName}-${Date.now()}`);
    const worktreePath = path.resolve(targetPath);

    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree directory already exists: ${worktreePath}`);
    }

    const worktreesDir = path.dirname(worktreePath);
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    try {
      await GitService.createGitWorktreeFromBranch(projectPath, worktreePath, branchName);
    } catch (error) {
      throw new Error(
        `Failed to create worktree for branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Worktree directory was not created: ${worktreePath}`);
    }

    worktreeConfigService.ensureCodexLogIgnored(worktreePath);

    // Preserve .env and other gitignored config files from source to worktree
    try {
      const patterns = worktreeFileService.getPreservePatterns(projectPath);
      await worktreeFileService.preserveFilesToWorktree(projectPath, worktreePath, patterns);
    } catch (preserveErr) {
      log.warn('Failed to preserve files to worktree (continuing):', preserveErr);
    }

    const worktreeInfo: WorktreeInfo = {
      id: stableIdFromPath(worktreePath),
      name: normalizedName,
      branch: branchName,
      path: worktreePath,
      projectId,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    this.worktrees.set(worktreeInfo.id, worktreeInfo);

    return worktreeInfo;
  }
}

export const worktreeService = new WorktreeService();
