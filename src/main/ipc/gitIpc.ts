import { ipcMain } from 'electron';
import { log } from '../lib/logger';
import { exec, execFile } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'util';
import {
  getStatus as gitGetStatus,
  getFileDiff as gitGetFileDiff,
  stageFile as gitStageFile,
  revertFile as gitRevertFile,
} from '../services/GitService';
import { prGenerationService } from '../services/PrGenerationService';
import { databaseService } from '../services/DatabaseService';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Enhanced Git operation configuration
const GIT_CONFIG = {
  timeout: 60000, // 60 seconds for git operations
  maxBuffer: 10 * 1024 * 1024, // 10MB buffer
  maxRetries: 3,
  baseDelay: 1000, // 1 second base delay
  maxDelay: 10000, // 10 seconds max delay
};

/**
 * Detect if an error is an EPIPE error (broken pipe)
 * These are typically transient network/connection issues
 */
function isEpipeError(error: any): boolean {
  const message = error?.message || error || '';
  const code = error?.code;
  const stderr = error?.stderr || '';

  return (
    code === 'EPIPE' ||
    message.includes('EPIPE') ||
    message.includes('write EPIPE') ||
    message.includes('broken pipe') ||
    stderr.includes('write EPIPE') ||
    stderr.includes('broken pipe') ||
    message.includes('remote hung up unexpectedly') ||
    stderr.includes('remote hung up unexpectedly') ||
    message.includes('connection reset by peer') ||
    stderr.includes('connection reset by peer')
  );
}

/**
 * Calculate exponential backoff delay for retries
 */
function getRetryDelay(attempt: number): number {
  const delay = Math.min(GIT_CONFIG.baseDelay * Math.pow(2, attempt), GIT_CONFIG.maxDelay);
  // Add jitter to prevent thundering herd
  return delay + Math.random() * 1000;
}

/**
 * Enhanced execAsync with EPIPE detection and retry logic
 */
async function execGitWithRetry(
  command: string,
  options?: { cwd?: string; timeout?: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  let lastError: any = null;

  for (let attempt = 0; attempt <= GIT_CONFIG.maxRetries; attempt++) {
    try {
      const opts = {
        cwd: options?.cwd,
        timeout: options?.timeout || GIT_CONFIG.timeout,
        maxBuffer: options?.maxBuffer || GIT_CONFIG.maxBuffer,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
        },
      };

      const result = await execAsync(command, opts);

      // Log successful retry if it wasn't the first attempt
      if (attempt > 0) {
        log.info('Git operation succeeded after retry', {
          command: command.split(' ')[0],
          attempt: attempt + 1,
          cwd: options?.cwd,
        });
      }

      return result;
    } catch (error: any) {
      lastError = error;

      // Only retry on EPIPE errors
      if (!isEpipeError(error)) {
        // Not a transient error, don't retry
        throw error;
      }

      // If this is the last attempt, throw the error
      if (attempt === GIT_CONFIG.maxRetries) {
        log.error('Git operation failed after all retries', {
          command: command.split(' ')[0],
          attempts: attempt + 1,
          cwd: options?.cwd,
          error: error.message || error,
        });
        throw error;
      }

      // Log the retry attempt
      const delay = getRetryDelay(attempt);
      log.warn('Git operation failed with EPIPE, retrying...', {
        command: command.split(' ')[0],
        attempt: attempt + 1,
        maxRetries: GIT_CONFIG.maxRetries + 1,
        delay: Math.round(delay),
        cwd: options?.cwd,
        error: error.message || error,
      });

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/**
 * Enhanced execFileAsync with similar retry logic for execFile operations
 */
async function execGitFileWithRetry(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  let lastError: any = null;

  for (let attempt = 0; attempt <= GIT_CONFIG.maxRetries; attempt++) {
    try {
      const opts = {
        cwd: options?.cwd,
        timeout: options?.timeout || GIT_CONFIG.timeout,
        maxBuffer: options?.maxBuffer || GIT_CONFIG.maxBuffer,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
        },
      };

      const result = await execFileAsync(command, args, opts);

      // Log successful retry if it wasn't the first attempt
      if (attempt > 0) {
        log.info('Git file operation succeeded after retry', {
          command: `${command} ${args[0] || ''}`,
          attempt: attempt + 1,
          cwd: options?.cwd,
        });
      }

      return result;
    } catch (error: any) {
      lastError = error;

      // Only retry on EPIPE errors
      if (!isEpipeError(error)) {
        // Not a transient error, don't retry
        throw error;
      }

      // If this is the last attempt, throw the error
      if (attempt === GIT_CONFIG.maxRetries) {
        log.error('Git file operation failed after all retries', {
          command: `${command} ${args[0] || ''}`,
          attempts: attempt + 1,
          cwd: options?.cwd,
          error: error.message || error,
        });
        throw error;
      }

      // Log the retry attempt
      const delay = getRetryDelay(attempt);
      log.warn('Git file operation failed with EPIPE, retrying...', {
        command: `${command} ${args[0] || ''}`,
        attempt: attempt + 1,
        maxRetries: GIT_CONFIG.maxRetries + 1,
        delay: Math.round(delay),
        cwd: options?.cwd,
        error: error.message || error,
      });

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

export function registerGitIpc() {
  function resolveGitBin(): string {
    // Allow override via env
    const fromEnv = (process.env.GIT_PATH || '').trim();
    const candidates = [
      fromEnv,
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/usr/bin/git',
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch {}
    }
    // Last resort: try /usr/bin/env git
    return 'git';
  }
  const GIT = resolveGitBin();
  const GH_ENV = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
  const ghExecAsync = (
    command: string,
    opts?: { cwd?: string }
  ): Promise<{ stdout: string; stderr: string }> => {
    const execOpts = {
      cwd: opts?.cwd,
      timeout: GIT_CONFIG.timeout,
      maxBuffer: GIT_CONFIG.maxBuffer,
      env: GH_ENV,
    };
    return execAsync(command, execOpts);
  };

  /**
   * Enhanced git operations with proper timeout and buffer configuration
   */
  const gitExec = (
    command: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }> => {
    const execOpts = {
      cwd: opts?.cwd,
      timeout: opts?.timeout || GIT_CONFIG.timeout,
      maxBuffer: opts?.maxBuffer || GIT_CONFIG.maxBuffer,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
    };
    return execAsync(command, execOpts);
  };

  /**
   * Enhanced git file operations with proper timeout and buffer configuration
   */
  const gitExecFile = (
    command: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }> => {
    const execOpts = {
      cwd: opts?.cwd,
      timeout: opts?.timeout || GIT_CONFIG.timeout,
      maxBuffer: opts?.maxBuffer || GIT_CONFIG.maxBuffer,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
    };
    return execFileAsync(command, args, execOpts);
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Validates GitHub repository name format (owner/repo)
   * Allows only: alphanumerics, dashes, underscores, dots
   */
  function validateRepoName(repoName: string): { valid: boolean; error?: string } {
    if (!repoName || typeof repoName !== 'string') {
      return { valid: false, error: 'Repository name is required and must be a string' };
    }

    // Pattern: owner/repo where both parts contain only allowed chars
    const pattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
    if (!pattern.test(repoName)) {
      return {
        valid: false,
        error:
          'Invalid repository name format. Expected: owner/repo with only alphanumeric characters, dots, dashes, and underscores',
      };
    }

    // Additional length checks (GitHub limits)
    const parts = repoName.split('/');
    if (parts[0].length > 39 || parts[1].length > 100) {
      return {
        valid: false,
        error: 'Repository name exceeds GitHub length limits',
      };
    }

    return { valid: true };
  }

  /**
   * Execute gh CLI with arguments array to avoid shell interpolation
   */
  async function ghExecFile(
    args: string[],
    opts?: { cwd?: string }
  ): Promise<{ stdout: string; stderr: string }> {
    const execOpts = {
      cwd: opts?.cwd,
      timeout: GIT_CONFIG.timeout,
      maxBuffer: GIT_CONFIG.maxBuffer,
      env: { ...GH_ENV },
    };
    return execFileAsync('gh', args, execOpts);
  }
  // Git: Status (moved from Codex IPC)
  ipcMain.handle('git:get-status', async (_, taskPath: string) => {
    try {
      const changes = await gitGetStatus(taskPath);
      return { success: true, changes };
    } catch (error) {
      return { success: false, error: error as string };
    }
  });

  // Git: Per-file diff (moved from Codex IPC)
  ipcMain.handle('git:get-file-diff', async (_, args: { taskPath: string; filePath: string }) => {
    try {
      const diff = await gitGetFileDiff(args.taskPath, args.filePath);
      return { success: true, diff };
    } catch (error) {
      return { success: false, error: error as string };
    }
  });

  // Git: Stage file
  ipcMain.handle('git:stage-file', async (_, args: { taskPath: string; filePath: string }) => {
    try {
      log.info('Staging file:', { taskPath: args.taskPath, filePath: args.filePath });
      await gitStageFile(args.taskPath, args.filePath);
      log.info('File staged successfully:', args.filePath);
      return { success: true };
    } catch (error) {
      log.error('Failed to stage file:', { filePath: args.filePath, error });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Git: Revert file
  ipcMain.handle('git:revert-file', async (_, args: { taskPath: string; filePath: string }) => {
    try {
      log.info('Reverting file:', { taskPath: args.taskPath, filePath: args.filePath });
      const result = await gitRevertFile(args.taskPath, args.filePath);
      log.info('File operation completed:', { filePath: args.filePath, action: result.action });
      return { success: true, action: result.action };
    } catch (error) {
      log.error('Failed to revert file:', { filePath: args.filePath, error });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Git: Generate PR title and description
  ipcMain.handle(
    'git:generate-pr-content',
    async (
      _,
      args: {
        taskPath: string;
        base?: string;
      }
    ) => {
      const { taskPath, base = 'main' } = args || ({} as { taskPath: string; base?: string });
      try {
        // Try to get the task to find which provider was used
        let providerId: string | null = null;
        try {
          const task = await databaseService.getTaskByPath(taskPath);
          if (task?.agentId) {
            providerId = task.agentId;
            log.debug('Found task provider for PR generation', { taskPath, providerId });
          }
        } catch (error) {
          log.debug('Could not lookup task provider', { error });
          // Non-fatal - continue without provider
        }

        const result = await prGenerationService.generatePrContent(taskPath, base, providerId);
        return { success: true, ...result };
      } catch (error) {
        log.error('Failed to generate PR content:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle('git:get-pr-capabilities', async (_, args: { taskPath: string }) => {
    const { taskPath } = args || ({} as { taskPath: string });
    if (!taskPath) return { success: false, error: 'taskPath is required' };

    try {
      await gitExec('git rev-parse --is-inside-work-tree', { cwd: taskPath });
    } catch (error) {
      return { success: false, error: 'Not a git repository' };
    }

    try {
      const { stdout } = await ghExecAsync(
        'gh repo view --json nameWithOwner,viewerPermission,isFork,parent,defaultBranchRef',
        { cwd: taskPath }
      );
      const repo = JSON.parse(stdout || '{}');
      const nameWithOwner = repo?.nameWithOwner || '';
      const viewerPermission = String(repo?.viewerPermission || '').toUpperCase();
      const isFork = !!repo?.isFork;
      const parentRepo =
        repo?.parent && typeof repo.parent.nameWithOwner === 'string'
          ? repo.parent.nameWithOwner
          : null;
      const baseRepo = parentRepo || nameWithOwner || '';
      const defaultBranch =
        repo?.defaultBranchRef?.name && typeof repo.defaultBranchRef.name === 'string'
          ? repo.defaultBranchRef.name
          : 'main';
      let viewerLogin = '';
      try {
        const { stdout: userOut } = await ghExecAsync('gh api user -q .login', { cwd: taskPath });
        viewerLogin = (userOut || '').trim();
      } catch {}

      let hasFork = false;
      if (viewerLogin && baseRepo) {
        const repoName = baseRepo.split('/').pop() || baseRepo;
        try {
          await ghExecAsync(`gh repo view ${JSON.stringify(`${viewerLogin}/${repoName}`)}`, {
            cwd: taskPath,
          });
          hasFork = true;
        } catch {
          hasFork = false;
        }
      }

      const canPushToBase = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(viewerPermission);

      return {
        success: true,
        canPushToBase,
        viewerPermission,
        nameWithOwner,
        baseRepo,
        parentRepo,
        isFork,
        viewerLogin,
        defaultBranch,
        hasFork,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Git: Create Pull Request via GitHub CLI
  ipcMain.handle(
    'git:create-pr',
    async (
      _,
      args: {
        taskPath: string;
        title?: string;
        body?: string;
        base?: string;
        head?: string;
        draft?: boolean;
        web?: boolean;
        fill?: boolean;
      }
    ) => {
      const { taskPath, title, body, base, head, draft, web, fill } =
        args ||
        ({} as {
          taskPath: string;
          title?: string;
          body?: string;
          base?: string;
          head?: string;
          draft?: boolean;
          web?: boolean;
          fill?: boolean;
        });
      try {
        const outputs: string[] = [];

        // Stage and commit any pending changes
        try {
          const { stdout: statusOut } = await execAsync(
            'git status --porcelain --untracked-files=all',
            {
              cwd: taskPath,
            }
          );
          if (statusOut && statusOut.trim().length > 0) {
            const { stdout: addOut, stderr: addErr } = await execAsync('git add -A', {
              cwd: taskPath,
            });
            if (addOut?.trim()) outputs.push(addOut.trim());
            if (addErr?.trim()) outputs.push(addErr.trim());

            const commitMsg = 'stagehand: prepare pull request';
            try {
              const { stdout: commitOut, stderr: commitErr } = await execAsync(
                `git commit -m ${JSON.stringify(commitMsg)}`,
                { cwd: taskPath }
              );
              if (commitOut?.trim()) outputs.push(commitOut.trim());
              if (commitErr?.trim()) outputs.push(commitErr.trim());
            } catch (commitErr) {
              const msg = commitErr as string;
              if (msg && /nothing to commit/i.test(msg)) {
                outputs.push('git commit: nothing to commit');
              } else {
                throw commitErr;
              }
            }
          }
        } catch (stageErr) {
          log.warn('Failed to stage/commit changes before PR:', stageErr as string);
          // Continue; PR may still be created for existing commits
        }

        // Ensure branch is pushed to origin so PR includes latest commit
        try {
          await execGitWithRetry('git push', { cwd: taskPath });
          outputs.push('git push: success');
        } catch (pushErr) {
          try {
            const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', {
              cwd: taskPath,
            });
            const branch = branchOut.trim();
            await execGitWithRetry(`git push --set-upstream origin ${JSON.stringify(branch)}`, {
              cwd: taskPath,
            });
            outputs.push(`git push --set-upstream origin ${branch}: success`);
          } catch (pushErr2) {
            const errorDetails = pushErr2 instanceof Error ? pushErr2.message : String(pushErr2);
            log.error('Failed to push branch before PR:', errorDetails);

            // Provide more user-friendly error message based on error type
            let userMessage =
              'Failed to push branch to origin. Please check your Git remotes and authentication.';
            if (isEpipeError(pushErr2)) {
              userMessage =
                'Network connection failed during push. Please check your internet connection and try again.';
            } else if (errorDetails.includes('authentication') || errorDetails.includes('auth')) {
              userMessage =
                'Authentication failed. Please check your Git credentials and try again.';
            } else if (errorDetails.includes('Permission denied') || errorDetails.includes('403')) {
              userMessage = 'Permission denied. You may not have push access to this repository.';
            }

            return {
              success: false,
              error: userMessage,
              technicalError: errorDetails,
            };
          }
        }

        // Resolve repo owner/name (prefer gh, fallback to parsing origin url)
        let repoNameWithOwner = '';
        try {
          const { stdout: repoOut } = await execAsync(
            'gh repo view --json nameWithOwner -q .nameWithOwner',
            { cwd: taskPath }
          );
          repoNameWithOwner = (repoOut || '').trim();
        } catch {
          try {
            const { stdout: urlOut } = await execAsync('git remote get-url origin', {
              cwd: taskPath,
            });
            const url = (urlOut || '').trim();
            // Handle both SSH and HTTPS forms
            const m =
              url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i) ||
              url.match(/([^/:]+)[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
            if (m) {
              const owner = m[1].includes('github.com') ? m[1].split('github.com').pop() : m[1];
              const repo = m[2] || m[3];
              repoNameWithOwner = `${owner}/${repo}`.replace(/^\/*/, '');
            }
          } catch {}
        }

        // Determine current branch and default base branch (fallback to main)
        let currentBranch = '';
        try {
          const { stdout } = await execAsync('git branch --show-current', { cwd: taskPath });
          currentBranch = (stdout || '').trim();
        } catch {}
        let defaultBranch = 'main';
        try {
          const { stdout } = await execAsync(
            'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
            { cwd: taskPath }
          );
          const db = (stdout || '').trim();
          if (db) defaultBranch = db;
        } catch {
          try {
            const { stdout } = await execAsync(
              'git remote show origin | sed -n "/HEAD branch/s/.*: //p"',
              { cwd: taskPath }
            );
            const db2 = (stdout || '').trim();
            if (db2) defaultBranch = db2;
          } catch {}
        }

        // Guard: ensure there is at least one commit ahead of base
        try {
          const baseRef = base || defaultBranch;
          const { stdout: aheadOut } = await execAsync(
            `git rev-list --count ${JSON.stringify(`origin/${baseRef}`)}..HEAD`,
            { cwd: taskPath }
          );
          const aheadCount = parseInt((aheadOut || '0').trim(), 10) || 0;
          if (aheadCount <= 0) {
            return {
              success: false,
              error: `No commits to create a PR. Make a commit on 
current branch '${currentBranch}' ahead of base '${baseRef}'.`,
            };
          }
        } catch {
          // Non-fatal; continue
        }

        // Build gh pr create command arguments to avoid shell injection
        const args = ['pr', 'create'];
        if (repoNameWithOwner) args.push('--repo', repoNameWithOwner);
        if (title) args.push('--title', title);

        // Use temp file for body to properly handle newlines and multiline content
        let bodyFile: string | null = null;
        if (body) {
          try {
            bodyFile = path.join(
              os.tmpdir(),
              `gh-pr-body-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
            );
            // Write body with actual newlines preserved
            fs.writeFileSync(bodyFile, body, 'utf8');
            args.push('--body-file', bodyFile);
          } catch (writeError) {
            log.warn('Failed to write body to temp file, falling back to --body flag', {
              writeError,
            });
            // Fallback to direct --body flag if temp file creation fails
            args.push('--body', body);
          }
        }

        if (base || defaultBranch) args.push('--base', base || defaultBranch);
        if (head) {
          args.push('--head', head);
        } else if (currentBranch) {
          // Prefer owner:branch form when repo is known; otherwise branch name
          const headRef = repoNameWithOwner
            ? `${repoNameWithOwner.split('/')[0]}:${currentBranch}`
            : currentBranch;
          args.push('--head', headRef);
        }
        // Boolean flags as single entries
        if (draft) args.push('--draft');
        if (web) args.push('--web');
        if (fill) args.push('--fill');

        let stdout: string;
        let stderr: string;
        try {
          const result = await execFileAsync('gh', args, { cwd: taskPath });
          stdout = result.stdout || '';
          stderr = result.stderr || '';
        } finally {
          // Clean up temp file if it was created
          if (bodyFile && fs.existsSync(bodyFile)) {
            try {
              fs.unlinkSync(bodyFile);
            } catch (unlinkError) {
              log.debug('Failed to delete temp body file', { bodyFile, unlinkError });
            }
          }
        }
        const out = [...outputs, (stdout || '').trim() || (stderr || '').trim()]
          .filter(Boolean)
          .join('\n');

        // Try to extract PR URL from output
        const urlMatch = out.match(/https?:\/\/\S+/);
        const url = urlMatch ? urlMatch[0] : null;

        return { success: true, url, output: out };
      } catch (error: any) {
        // Capture rich error info from gh/child_process
        const errMsg = typeof error?.message === 'string' ? error.message : String(error);
        const errStdout = typeof error?.stdout === 'string' ? error.stdout : '';
        const errStderr = typeof error?.stderr === 'string' ? error.stderr : '';
        const combined = [errMsg, errStdout, errStderr].filter(Boolean).join('\n').trim();
        const restrictionRe =
          /Auth App access restrictions|authorized OAuth apps|third-parties is limited/i;
        const code = restrictionRe.test(combined) ? 'ORG_AUTH_APP_RESTRICTED' : undefined;
        if (code === 'ORG_AUTH_APP_RESTRICTED') {
          log.warn('GitHub org restrictions detected during PR creation');
        } else {
          log.error('Failed to create PR:', combined || error);
        }
        return {
          success: false,
          error: combined || errMsg || 'Failed to create PR',
          output: combined,
          code,
        } as any;
      }
    }
  );

  ipcMain.handle(
    'git:create-pr-from-fork',
    async (
      _,
      args: {
        taskPath: string;
        commitMessage?: string;
        createBranchIfOnDefault?: boolean;
        branchPrefix?: string;
        title?: string;
        body?: string;
        base?: string;
        draft?: boolean;
        web?: boolean;
        fill?: boolean;
      }
    ) => {
      const {
        taskPath,
        commitMessage = 'chore: apply task changes',
        createBranchIfOnDefault = true,
        branchPrefix = 'orch',
        title,
        body,
        base,
        draft,
        web,
        fill,
      } = args ||
      ({} as {
        taskPath: string;
        commitMessage?: string;
        createBranchIfOnDefault?: boolean;
        branchPrefix?: string;
        title?: string;
        body?: string;
        base?: string;
        draft?: boolean;
        web?: boolean;
        fill?: boolean;
      });

      if (!taskPath) {
        return { success: false, error: 'taskPath is required' };
      }

      const outputs: string[] = [];

      try {
        await execAsync('git rev-parse --is-inside-work-tree', { cwd: taskPath });
      } catch {
        return { success: false, error: 'Not a git repository' };
      }

      try {
        // Repo metadata and viewer
        const { stdout: repoStdout } = await ghExecAsync(
          'gh repo view --json nameWithOwner,isFork,parent,defaultBranchRef',
          { cwd: taskPath }
        );
        const repoInfo = JSON.parse(repoStdout || '{}');
        const nameWithOwner = repoInfo?.nameWithOwner || '';
        const parentRepo =
          repoInfo?.parent && typeof repoInfo.parent.nameWithOwner === 'string'
            ? repoInfo.parent.nameWithOwner
            : null;
        const baseRepo = parentRepo || nameWithOwner;
        const defaultBranch =
          base ||
          (repoInfo?.defaultBranchRef?.name && typeof repoInfo.defaultBranchRef.name === 'string'
            ? repoInfo.defaultBranchRef.name
            : 'main');

        let viewerLogin = '';
        try {
          const { stdout: userOut } = await ghExecAsync('gh api user -q .login', { cwd: taskPath });
          viewerLogin = (userOut || '').trim();
        } catch {
          return {
            success: false,
            error: 'GitHub authentication required. Please run gh auth login.',
          };
        }

        if (!baseRepo || !viewerLogin) {
          return { success: false, error: 'Unable to resolve repository information' };
        }

        // Determine current branch
        let currentBranch = '';
        try {
          const { stdout: currentBranchOut } = await execAsync('git branch --show-current', {
            cwd: taskPath,
          });
          currentBranch = (currentBranchOut || '').trim();
        } catch {}

        // Create feature branch if on default
        if (createBranchIfOnDefault && (!currentBranch || currentBranch === defaultBranch)) {
          const short = Date.now().toString(36);
          const name = `${branchPrefix}/${short}`;
          await execAsync(`git checkout -b ${JSON.stringify(name)}`, { cwd: taskPath });
          currentBranch = name;
        }

        // Stage and commit any pending changes (respect manual staging)
        try {
          const { stdout: statusOut } = await execAsync(
            'git status --porcelain --untracked-files=all',
            { cwd: taskPath }
          );
          const hasWorkingChanges = Boolean(statusOut && statusOut.trim().length > 0);

          const readStagedFiles = async () => {
            try {
              const { stdout } = await execAsync('git diff --cached --name-only', {
                cwd: taskPath,
              });
              return (stdout || '')
                .split('\n')
                .map((f) => f.trim())
                .filter(Boolean);
            } catch {
              return [];
            }
          };

          let stagedFiles = await readStagedFiles();

          // Only auto-stage everything when nothing is staged yet
          if (hasWorkingChanges && stagedFiles.length === 0) {
            await execAsync('git add -A', { cwd: taskPath });
          }

          // Never commit plan mode artifacts
          try {
            await execAsync('git reset -q .emdash || true', { cwd: taskPath });
          } catch {}
          try {
            await execAsync('git reset -q PLANNING.md || true', { cwd: taskPath });
          } catch {}
          try {
            await execAsync('git reset -q planning.md || true', { cwd: taskPath });
          } catch {}

          stagedFiles = await readStagedFiles();

          if (stagedFiles.length > 0) {
            try {
              await execAsync(`git commit -m ${JSON.stringify(commitMessage)}`, {
                cwd: taskPath,
              });
            } catch (commitErr) {
              const msg = commitErr as string;
              if (!/nothing to commit/i.test(msg)) throw commitErr;
            }
          }
        } catch (stageErr) {
          log.warn('Stage/commit step issue:', stageErr as string);
        }

        // Guard: ensure there is at least one commit ahead of base
        try {
          const baseRef = defaultBranch;
          const { stdout: aheadOut } = await execAsync(
            `git rev-list --count ${JSON.stringify(`origin/${baseRef}`)}..HEAD`,
            { cwd: taskPath }
          );
          const aheadCount = parseInt((aheadOut || '0').trim(), 10) || 0;
          if (aheadCount <= 0) {
            return {
              success: false,
              error: `No commits to create a PR. Make a commit on current branch '${currentBranch}' ahead of base '${baseRef}'.`,
            };
          }
        } catch {
          // Non-fatal; continue
        }

        // Determine protocol preference from origin
        let preferSsh = true;
        try {
          const { stdout: originUrlOut } = await execAsync('git remote get-url origin', {
            cwd: taskPath,
          });
          const originUrl = (originUrlOut || '').trim();
          preferSsh = originUrl.startsWith('git@') || originUrl.startsWith('ssh://');
        } catch {}

        const repoParts = baseRepo.split('/');
        const repoName = repoParts[1] || repoParts[0];
        const forkFullName = `${viewerLogin}/${repoName}`;

        const fetchForkUrl = async (): Promise<string | null> => {
          // Validate forkFullName before use
          const validation = validateRepoName(forkFullName);
          if (!validation.valid) {
            throw new Error(`Invalid repository name: ${validation.error}`);
          }

          const queries = preferSsh ? ['.ssh_url', '.clone_url'] : ['.clone_url', '.ssh_url'];
          for (const q of queries) {
            try {
              const { stdout: urlOut } = await ghExecFile(
                ['api', `repos/${forkFullName}`, '-q', q],
                {
                  cwd: taskPath,
                }
              );
              const url = (urlOut || '').trim();
              if (url) return url;
            } catch {
              // keep trying
            }
          }
          return null;
        };

        // Ensure fork exists
        let forkRemoteUrl = await fetchForkUrl();
        if (!forkRemoteUrl) {
          // Validate baseRepo before use
          const validation = validateRepoName(baseRepo);
          if (!validation.valid) {
            return { success: false, error: `Invalid repository name: ${validation.error}` };
          }

          try {
            await ghExecFile(
              ['api', '-X', 'POST', `repos/${baseRepo}/forks`, '-f', 'default_branch_only=true'],
              {
                cwd: taskPath,
              }
            );
          } catch (forkErr) {
            const msg = forkErr instanceof Error ? forkErr.message : String(forkErr);
            return { success: false, error: `Failed to create fork: ${msg}` };
          }

          // Poll until fork is ready
          for (let i = 0; i < 5; i++) {
            await sleep(1000);
            forkRemoteUrl = await fetchForkUrl();
            if (forkRemoteUrl) break;
          }
        }

        if (!forkRemoteUrl) {
          return { success: false, error: 'Fork not available yet. Please try again.' };
        }

        // Ensure fork remote is set
        try {
          const { stdout: existingUrlOut } = await execAsync('git remote get-url fork', {
            cwd: taskPath,
          });
          const existingUrl = (existingUrlOut || '').trim();
          if (existingUrl !== forkRemoteUrl) {
            await execAsync(`git remote set-url fork ${JSON.stringify(forkRemoteUrl)}`, {
              cwd: taskPath,
            });
          }
        } catch {
          await execAsync(`git remote add fork ${JSON.stringify(forkRemoteUrl)}`, {
            cwd: taskPath,
          });
        }

        // Push branch to fork
        try {
          outputs.push('Pushing branch to fork...');
          await execGitWithRetry(`git push --set-upstream fork ${JSON.stringify(currentBranch)}`, {
            cwd: taskPath,
          });
          outputs.push(`git push --set-upstream fork ${currentBranch}: success`);
        } catch (pushErr) {
          const errorDetails = pushErr instanceof Error ? pushErr.message : String(pushErr);
          log.error('Failed to push branch to fork:', errorDetails);

          // Provide more user-friendly error message based on error type
          let userMessage = `Failed to push branch to fork. Please check your Git remotes and authentication.`;
          if (isEpipeError(pushErr)) {
            userMessage =
              'Network connection failed during push to fork. Please check your internet connection and try again.';
          } else if (errorDetails.includes('authentication') || errorDetails.includes('auth')) {
            userMessage = 'Authentication failed. Please check your Git credentials and try again.';
          } else if (errorDetails.includes('Permission denied') || errorDetails.includes('403')) {
            userMessage = 'Permission denied. You may not have push access to the fork.';
          } else if (
            errorDetails.includes('Repository not found') ||
            errorDetails.includes('404')
          ) {
            userMessage =
              'Fork repository not found or not accessible. The fork may still be being created.';
          }

          return {
            success: false,
            error: userMessage,
            output: errorDetails,
            technicalError: errorDetails,
          };
        }

        // Build gh pr create command arguments to avoid shell injection
        const args = ['pr', 'create'];
        if (baseRepo) args.push('--repo', baseRepo);
        if (title) args.push('--title', title);

        let bodyFile: string | null = null;
        if (body) {
          try {
            bodyFile = path.join(
              os.tmpdir(),
              `gh-pr-body-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
            );
            fs.writeFileSync(bodyFile, body, 'utf8');
            args.push('--body-file', bodyFile);
          } catch (writeError) {
            log.warn('Failed to write body to temp file, falling back to --body flag', {
              writeError,
            });
            args.push('--body', body);
          }
        }

        if (defaultBranch) args.push('--base', defaultBranch);

        const headRef = `${viewerLogin}:${currentBranch}`;
        args.push('--head', headRef);

        // Boolean flags as single entries
        if (draft) args.push('--draft');
        if (web) args.push('--web');
        if (fill) args.push('--fill');

        let stdout: string;
        let stderr: string;
        try {
          const result = await ghExecFile(args, { cwd: taskPath });
          stdout = result.stdout || '';
          stderr = result.stderr || '';
        } finally {
          if (bodyFile && fs.existsSync(bodyFile)) {
            try {
              fs.unlinkSync(bodyFile);
            } catch (unlinkError) {
              log.debug('Failed to delete temp body file', { bodyFile, unlinkError });
            }
          }
        }

        const out = [...outputs, (stdout || '').trim() || (stderr || '').trim()]
          .filter(Boolean)
          .join('\n');
        const urlMatch = out.match(/https?:\/\/\S+/);
        const url = urlMatch ? urlMatch[0] : null;

        return { success: true, url, output: out, fork: forkFullName, baseRepo };
      } catch (error: any) {
        const errMsg = typeof error?.message === 'string' ? error.message : String(error);
        const errStdout = typeof error?.stdout === 'string' ? error.stdout : '';
        const errStderr = typeof error?.stderr === 'string' ? error.stderr : '';
        const combined = [errMsg, errStdout, errStderr].filter(Boolean).join('\n').trim();
        log.error('Failed to create PR from fork:', combined || error);
        return {
          success: false,
          error: combined || errMsg || 'Failed to create PR from fork',
          output: combined,
        };
      }
    }
  );

  // Git: Get PR status for current branch via GitHub CLI
  ipcMain.handle('git:get-pr-status', async (_, args: { taskPath: string }) => {
    const { taskPath } = args || ({} as { taskPath: string });
    try {
      // Ensure we're in a git repo
      await execAsync('git rev-parse --is-inside-work-tree', { cwd: taskPath });

      const queryFields = [
        'number',
        'url',
        'state',
        'isDraft',
        'mergeStateStatus',
        'headRefName',
        'baseRefName',
        'title',
        'author',
        'additions',
        'deletions',
        'changedFiles',
      ];
      const cmd = `gh pr view --json ${queryFields.join(',')} -q .`;
      try {
        const { stdout } = await execAsync(cmd, { cwd: taskPath });
        const json = (stdout || '').trim();
        const data = json ? JSON.parse(json) : null;
        if (!data) return { success: false, error: 'No PR data returned' };

        // Fallback: if GH CLI didn't return diff stats, try to compute locally
        const asNumber = (v: any): number | null =>
          typeof v === 'number' && Number.isFinite(v)
            ? v
            : typeof v === 'string' && Number.isFinite(Number.parseInt(v, 10))
              ? Number.parseInt(v, 10)
              : null;

        const hasAdd = asNumber(data?.additions) !== null;
        const hasDel = asNumber(data?.deletions) !== null;
        const hasFiles = asNumber(data?.changedFiles) !== null;

        if (!hasAdd || !hasDel || !hasFiles) {
          const baseRef = typeof data?.baseRefName === 'string' ? data.baseRefName.trim() : '';
          const targetRef = baseRef ? `origin/${baseRef}` : '';
          const shortstatCmd = targetRef
            ? `git diff --shortstat ${JSON.stringify(targetRef)}...HEAD`
            : 'git diff --shortstat HEAD~1..HEAD';
          try {
            const { stdout: diffOut } = await execAsync(shortstatCmd, { cwd: taskPath });
            const statLine = (diffOut || '').trim();
            const m =
              statLine &&
              statLine.match(
                /(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/
              );
            if (m) {
              const [, filesStr, addStr, delStr] = m;
              if (!hasFiles && filesStr) data.changedFiles = Number.parseInt(filesStr, 10);
              if (!hasAdd && addStr) data.additions = Number.parseInt(addStr, 10);
              if (!hasDel && delStr) data.deletions = Number.parseInt(delStr, 10);
            }
          } catch {
            // best-effort only; ignore failures
          }
        }

        return { success: true, pr: data };
      } catch (err) {
        const msg = String(err as string);
        if (/no pull requests? found/i.test(msg) || /not found/i.test(msg)) {
          return { success: true, pr: null };
        }
        return { success: false, error: msg || 'Failed to query PR status' };
      }
    } catch (error) {
      return { success: false, error: error as string };
    }
  });

  // Git: Commit all changes and push current branch (create feature branch if on default)
  ipcMain.handle(
    'git:commit-and-push',
    async (
      _,
      args: {
        taskPath: string;
        commitMessage?: string;
        createBranchIfOnDefault?: boolean;
        branchPrefix?: string;
      }
    ) => {
      const {
        taskPath,
        commitMessage = 'chore: apply task changes',
        createBranchIfOnDefault = true,
        branchPrefix = 'orch',
      } = (args ||
        ({} as {
          taskPath: string;
          commitMessage?: string;
          createBranchIfOnDefault?: boolean;
          branchPrefix?: string;
        })) as {
        taskPath: string;
        commitMessage?: string;
        createBranchIfOnDefault?: boolean;
        branchPrefix?: string;
      };

      try {
        // Ensure we're in a git repo
        await gitExec('git rev-parse --is-inside-work-tree', { cwd: taskPath });

        // Determine current branch
        const { stdout: currentBranchOut } = await gitExec('git branch --show-current', {
          cwd: taskPath,
        });
        const currentBranch = (currentBranchOut || '').trim();

        // Determine default branch via gh, fallback to main/master
        let defaultBranch = 'main';
        try {
          const { stdout } = await execAsync(
            'gh repo view --json defaultBranchRef -q .defaultBranchRef.name',
            { cwd: taskPath }
          );
          const db = (stdout || '').trim();
          if (db) defaultBranch = db;
        } catch {
          try {
            const { stdout } = await execAsync(
              'git remote show origin | sed -n "/HEAD branch/s/.*: //p"',
              { cwd: taskPath }
            );
            const db2 = (stdout || '').trim();
            if (db2) defaultBranch = db2;
          } catch {}
        }

        // Optionally create a new branch if on default
        let activeBranch = currentBranch;
        if (createBranchIfOnDefault && (!currentBranch || currentBranch === defaultBranch)) {
          const short = Date.now().toString(36);
          const name = `${branchPrefix}/${short}`;
          await execAsync(`git checkout -b ${JSON.stringify(name)}`, { cwd: taskPath });
          activeBranch = name;
        }

        // Stage (only if needed) and commit
        try {
          const { stdout: st } = await execAsync('git status --porcelain --untracked-files=all', {
            cwd: taskPath,
          });
          const hasWorkingChanges = Boolean(st && st.trim().length > 0);

          const readStagedFiles = async () => {
            try {
              const { stdout } = await execAsync('git diff --cached --name-only', {
                cwd: taskPath,
              });
              return (stdout || '')
                .split('\n')
                .map((f) => f.trim())
                .filter(Boolean);
            } catch {
              return [];
            }
          };

          let stagedFiles = await readStagedFiles();

          // Only auto-stage everything when nothing is staged yet (preserves manual staging choices)
          if (hasWorkingChanges && stagedFiles.length === 0) {
            await execAsync('git add -A', { cwd: taskPath });
          }

          // Never commit plan mode artifacts
          try {
            await execAsync('git reset -q .emdash || true', { cwd: taskPath });
          } catch {}
          try {
            await execAsync('git reset -q PLANNING.md || true', { cwd: taskPath });
          } catch {}
          try {
            await execAsync('git reset -q planning.md || true', { cwd: taskPath });
          } catch {}

          stagedFiles = await readStagedFiles();

          if (stagedFiles.length > 0) {
            try {
              await execAsync(`git commit -m ${JSON.stringify(commitMessage)}`, {
                cwd: taskPath,
              });
            } catch (commitErr) {
              const msg = commitErr as string;
              if (!/nothing to commit/i.test(msg)) throw commitErr;
            }
          }
        } catch (e) {
          log.warn('Stage/commit step issue:', e as string);
        }

        // Push current branch (set upstream if needed)
        try {
          await execGitWithRetry('git push', { cwd: taskPath });
        } catch (pushErr) {
          try {
            await execGitWithRetry(
              `git push --set-upstream origin ${JSON.stringify(activeBranch)}`,
              {
                cwd: taskPath,
              }
            );
          } catch (pushErr2) {
            const errorDetails = pushErr2 instanceof Error ? pushErr2.message : String(pushErr2);
            log.error('Failed to push branch:', errorDetails);

            // Provide more user-friendly error message based on error type
            let userMessage =
              'Failed to push branch to origin. Please check your Git remotes and authentication.';
            if (isEpipeError(pushErr2)) {
              userMessage =
                'Network connection failed during push. Please check your internet connection and try again.';
            } else if (errorDetails.includes('authentication') || errorDetails.includes('auth')) {
              userMessage =
                'Authentication failed. Please check your Git credentials and try again.';
            } else if (errorDetails.includes('Permission denied') || errorDetails.includes('403')) {
              userMessage = 'Permission denied. You may not have push access to this repository.';
            }

            return {
              success: false,
              error: userMessage,
              technicalError: errorDetails,
            };
          }
        }

        const { stdout: out } = await execAsync('git status -sb', { cwd: taskPath });
        return { success: true, branch: activeBranch, output: (out || '').trim() };
      } catch (error) {
        log.error('Failed to commit and push:', error);
        return { success: false, error: error as string };
      }
    }
  );

  // Git: Get branch status (current branch, default branch, ahead/behind counts)
  ipcMain.handle('git:get-branch-status', async (_, args: { taskPath: string }) => {
    const { taskPath } = args || ({} as { taskPath: string });
    try {
      // Ensure repo (avoid /bin/sh by using execFile)
      await execFileAsync(GIT, ['rev-parse', '--is-inside-work-tree'], { cwd: taskPath });

      // Current branch
      const { stdout: currentBranchOut } = await execFileAsync(GIT, ['branch', '--show-current'], {
        cwd: taskPath,
      });
      const branch = (currentBranchOut || '').trim();

      // Determine default branch
      let defaultBranch = 'main';
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
          { cwd: taskPath }
        );
        const db = (stdout || '').trim();
        if (db) defaultBranch = db;
      } catch {
        try {
          // Use symbolic-ref to resolve origin/HEAD then take the last path part
          const { stdout } = await execFileAsync(
            GIT,
            ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
            { cwd: taskPath }
          );
          const line = (stdout || '').trim();
          const last = line.split('/').pop();
          if (last) defaultBranch = last;
        } catch {}
      }

      // Ahead/behind relative to upstream or origin/<default>
      let ahead = 0;
      let behind = 0;
      try {
        // Try explicit compare with origin/default...HEAD
        const { stdout } = await execFileAsync(
          GIT,
          ['rev-list', '--left-right', '--count', `origin/${defaultBranch}...HEAD`],
          { cwd: taskPath }
        );
        const parts = (stdout || '').trim().split(/\s+/);
        if (parts.length >= 2) {
          behind = parseInt(parts[0] || '0', 10) || 0; // commits on left (origin/default)
          ahead = parseInt(parts[1] || '0', 10) || 0; // commits on right (HEAD)
        }
      } catch {
        try {
          const { stdout } = await execFileAsync(GIT, ['status', '-sb'], { cwd: taskPath });
          const line = (stdout || '').split(/\n/)[0] || '';
          const m = line.match(/ahead\s+(\d+)/i);
          const n = line.match(/behind\s+(\d+)/i);
          if (m) ahead = parseInt(m[1] || '0', 10) || 0;
          if (n) behind = parseInt(n[1] || '0', 10) || 0;
        } catch {}
      }

      return { success: true, branch, defaultBranch, ahead, behind };
    } catch (error) {
      log.error('Failed to get branch status:', error);
      return { success: false, error: error as string };
    }
  });

  ipcMain.handle(
    'git:list-remote-branches',
    async (_, args: { projectPath: string; remote?: string }) => {
      const { projectPath, remote = 'origin' } = args || ({} as { projectPath: string });
      if (!projectPath) {
        return { success: false, error: 'projectPath is required' };
      }
      try {
        await execAsync('git rev-parse --is-inside-work-tree', { cwd: projectPath });
      } catch {
        return { success: false, error: 'Not a git repository' };
      }

      try {
        try {
          await execAsync(`git fetch --prune ${remote}`, { cwd: projectPath });
        } catch (fetchError) {
          log.warn('Failed to fetch remote before listing branches', fetchError);
        }

        const { stdout } = await execAsync(
          `git for-each-ref --format="%(refname:short)" refs/remotes/${remote}`,
          { cwd: projectPath }
        );

        const branches =
          stdout
            ?.split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .filter((line) => !line.endsWith('/HEAD'))
            .map((ref) => {
              const [remoteAlias, ...rest] = ref.split('/');
              const branch = rest.join('/') || ref;
              return {
                ref,
                remote: remoteAlias || remote,
                branch,
                label: `${remoteAlias || remote}/${branch}`,
              };
            }) ?? [];

        return { success: true, branches };
      } catch (error) {
        log.error('Failed to list remote branches:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
}
