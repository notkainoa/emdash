import { execFile } from 'child_process';
import { log } from '../lib/logger';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { projectSettingsService } from './ProjectSettingsService';
import {
  extractErrorMessage,
  isMissingRemoteRefError,
  type BaseRefInfo,
} from '../lib/worktreeUtils';

const execFileAsync = promisify(execFile);

export type GitChange = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  isStaged: boolean;
};

// Re-export BaseRefInfo for external use
export type { BaseRefInfo };

export async function getStatus(taskPath: string): Promise<GitChange[]> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: taskPath,
    });
  } catch {
    return [];
  }

  const { stdout: statusOutput } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    {
      cwd: taskPath,
    }
  );

  if (!statusOutput.trim()) return [];

  const changes: GitChange[] = [];
  const statusLines = statusOutput
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);

  for (const line of statusLines) {
    const statusCode = line.substring(0, 2);
    let filePath = line.substring(3);
    if (statusCode.includes('R') && filePath.includes('->')) {
      const parts = filePath.split('->');
      filePath = parts[parts.length - 1].trim();
    }

    let status = 'modified';
    if (statusCode.includes('A') || statusCode.includes('?')) status = 'added';
    else if (statusCode.includes('D')) status = 'deleted';
    else if (statusCode.includes('R')) status = 'renamed';
    else if (statusCode.includes('M')) status = 'modified';

    // Check if file is staged (first character of status code indicates staged changes)
    const isStaged = statusCode[0] !== ' ' && statusCode[0] !== '?';

    if (filePath.endsWith('codex-stream.log')) continue;

    let additions = 0;
    let deletions = 0;

    const sumNumstat = (stdout: string) => {
      const lines = stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0);
      for (const l of lines) {
        const p = l.split('\t');
        if (p.length >= 2) {
          const addStr = p[0];
          const delStr = p[1];
          const a = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
          const d = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
          additions += a;
          deletions += d;
        }
      }
    };

    try {
      const staged = await execFileAsync('git', ['diff', '--numstat', '--cached', '--', filePath], {
        cwd: taskPath,
      });
      if (staged.stdout && staged.stdout.trim()) sumNumstat(staged.stdout);
    } catch {}

    try {
      const unstaged = await execFileAsync('git', ['diff', '--numstat', '--', filePath], {
        cwd: taskPath,
      });
      if (unstaged.stdout && unstaged.stdout.trim()) sumNumstat(unstaged.stdout);
    } catch {}

    if (additions === 0 && deletions === 0 && statusCode.includes('?')) {
      const absPath = path.join(taskPath, filePath);
      try {
        const stat = fs.existsSync(absPath) ? fs.statSync(absPath) : undefined;
        if (stat && stat.isFile()) {
          const buf = fs.readFileSync(absPath);
          let count = 0;
          for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
          additions = count;
        }
      } catch {}
    }

    changes.push({ path: filePath, status, additions, deletions, isStaged });
  }

  return changes;
}

export async function stageFile(taskPath: string, filePath: string): Promise<void> {
  await execFileAsync('git', ['add', '--', filePath], { cwd: taskPath });
}

export async function revertFile(
  taskPath: string,
  filePath: string
): Promise<{ action: 'unstaged' | 'reverted' }> {
  // Check if file is staged
  try {
    const { stdout: stagedStatus } = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only', '--', filePath],
      {
        cwd: taskPath,
      }
    );

    if (stagedStatus.trim()) {
      // File is staged, unstage it (but keep working directory changes)
      await execFileAsync('git', ['reset', 'HEAD', '--', filePath], { cwd: taskPath });
      return { action: 'unstaged' };
    }
  } catch {}

  // Check if file is tracked in git (exists in HEAD)
  let fileExistsInHead = false;
  try {
    await execFileAsync('git', ['cat-file', '-e', `HEAD:${filePath}`], { cwd: taskPath });
    fileExistsInHead = true;
  } catch {
    // File doesn't exist in HEAD (it's a new/untracked file), delete it
    const absPath = path.join(taskPath, filePath);
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
    return { action: 'reverted' };
  }

  // File exists in HEAD, revert it
  if (fileExistsInHead) {
    try {
      await execFileAsync('git', ['checkout', 'HEAD', '--', filePath], { cwd: taskPath });
    } catch (error) {
      // If checkout fails, don't delete the file - throw the error instead
      throw new Error(
        `Failed to revert file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { action: 'reverted' };
}

export async function getFileDiff(
  taskPath: string,
  filePath: string
): Promise<{ lines: Array<{ left?: string; right?: string; type: 'context' | 'add' | 'del' }> }> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--no-color', '--unified=2000', 'HEAD', '--', filePath],
      { cwd: taskPath }
    );

    const linesRaw = stdout.split('\n');
    const result: Array<{ left?: string; right?: string; type: 'context' | 'add' | 'del' }> = [];
    for (const line of linesRaw) {
      if (!line) continue;
      if (
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('@@')
      )
        continue;
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === ' ') result.push({ left: content, right: content, type: 'context' });
      else if (prefix === '-') result.push({ left: content, type: 'del' });
      else if (prefix === '+') result.push({ right: content, type: 'add' });
      else result.push({ left: line, right: line, type: 'context' });
    }

    if (result.length === 0) {
      try {
        const abs = path.join(taskPath, filePath);
        if (fs.existsSync(abs)) {
          const content = fs.readFileSync(abs, 'utf8');
          return { lines: content.split('\n').map((l) => ({ right: l, type: 'add' as const })) };
        } else {
          const { stdout: prev } = await execFileAsync('git', ['show', `HEAD:${filePath}`], {
            cwd: taskPath,
          });
          return { lines: prev.split('\n').map((l) => ({ left: l, type: 'del' as const })) };
        }
      } catch {
        return { lines: [] };
      }
    }

    return { lines: result };
  } catch {
    try {
      const abs = path.join(taskPath, filePath);
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      return { lines: lines.map((l) => ({ right: l, type: 'add' as const })) };
    } catch {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', '--no-color', '--unified=2000', 'HEAD', '--', filePath],
          { cwd: taskPath }
        );
        const linesRaw = stdout.split('\n');
        const result: Array<{ left?: string; right?: string; type: 'context' | 'add' | 'del' }> =
          [];
        for (const line of linesRaw) {
          if (!line) continue;
          if (
            line.startsWith('diff ') ||
            line.startsWith('index ') ||
            line.startsWith('--- ') ||
            line.startsWith('+++ ') ||
            line.startsWith('@@')
          )
            continue;
          const prefix = line[0];
          const content = line.slice(1);
          if (prefix === ' ') result.push({ left: content, right: content, type: 'context' });
          else if (prefix === '-') result.push({ left: content, type: 'del' });
          else if (prefix === '+') result.push({ right: content, type: 'add' });
          else result.push({ left: line, right: line, type: 'context' });
        }
        if (result.length === 0) {
          try {
            const { stdout: prev } = await execFileAsync('git', ['show', `HEAD:${filePath}`], {
              cwd: taskPath,
            });
            return { lines: prev.split('\n').map((l) => ({ left: l, type: 'del' as const })) };
          } catch {
            return { lines: [] };
          }
        }
        return { lines: result };
      } catch {
        return { lines: [] };
      }
    }
  }
}

// ============================================================================
// Worktree-related Git Operations
// ============================================================================

/**
 * Get the default branch of a repository
 */
export async function getDefaultBranch(projectPath: string): Promise<string> {
  // Check if origin remote exists first
  const hasOrigin = await hasRemote(projectPath, 'origin');
  if (!hasOrigin) {
    // No remote - try to get current branch
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: projectPath,
      });
      const current = stdout.trim();
      if (current) return current;
    } catch {
      // Fallback to 'main'
    }
    return 'main';
  }

  // Has remote - try to get its default branch
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'show', 'origin'], {
      cwd: projectPath,
    });
    const match = stdout.match(/HEAD branch:\s*(\S+)/);
    return match ? match[1] : 'main';
  } catch {
    return 'main';
  }
}

/**
 * Get the current branch of a repository
 */
export async function getCurrentBranch(projectPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: projectPath,
    });
    const current = stdout.trim();
    if (current) return current;
  } catch {
    // Fall through to fallback
  }
  return 'main';
}

/**
 * Check if a git remote exists in the repository
 */
export async function hasRemote(projectPath: string, remoteName: string): Promise<boolean> {
  if (!remoteName) return false;
  try {
    await execFileAsync('git', ['remote', 'get-url', remoteName], {
      cwd: projectPath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git worktree
 */
export async function createGitWorktree(
  projectPath: string,
  branchName: string,
  worktreePath: string,
  baseRef: string
): Promise<void> {
  const { stdout, stderr } = await execFileAsync(
    'git',
    ['worktree', 'add', '-b', branchName, worktreePath, baseRef],
    { cwd: projectPath }
  );

  log.debug('Git worktree stdout:', stdout);
  log.debug('Git worktree stderr:', stderr);
}

/**
 * Create a git worktree from an existing branch (without creating new branch)
 */
export async function createGitWorktreeFromBranch(
  projectPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
    cwd: projectPath,
  });
}

/**
 * Remove a git worktree
 */
export async function removeGitWorktree(projectPath: string, worktreePath: string): Promise<void> {
  // Use --force to remove even when there are untracked/modified files
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: projectPath,
  });
}

/**
 * Prune stale git worktree metadata
 */
export async function pruneGitWorktrees(projectPath: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'prune', '--verbose'], { cwd: projectPath });
}

/**
 * Delete a local branch
 */
export async function deleteBranch(projectPath: string, branch: string): Promise<void> {
  await execFileAsync('git', ['branch', '-D', branch], { cwd: projectPath });
}

/**
 * Delete a remote branch
 */
export async function deleteRemoteBranch(
  projectPath: string,
  remote: string,
  branch: string
): Promise<void> {
  await execFileAsync('git', ['push', remote, '--delete', branch], {
    cwd: projectPath,
  });
}

/**
 * Push a branch to remote with upstream tracking
 */
export async function pushBranch(
  projectPath: string,
  remote: string,
  branch: string
): Promise<void> {
  await execFileAsync('git', ['push', '--set-upstream', remote, branch], {
    cwd: projectPath,
  });
}

/**
 * Fetch a remote branch
 */
export async function fetchBranch(
  projectPath: string,
  remote: string,
  branch: string
): Promise<void> {
  await execFileAsync('git', ['fetch', remote, branch], { cwd: projectPath });
}

/**
 * Parse a base ref string into remote, branch, and fullRef
 */
export async function parseBaseRef(
  ref?: string | null,
  projectPath?: string
): Promise<BaseRefInfo | null> {
  if (!ref) return null;
  const cleaned = ref
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '');
  if (!cleaned) return null;
  const [remote, ...rest] = cleaned.split('/');
  if (!remote || rest.length === 0) return null;
  const branch = rest.join('/');
  if (!branch) return null;

  // If projectPath is provided, verify that 'remote' is actually a valid git remote
  // If not, treat the entire string as a local branch name
  if (projectPath) {
    try {
      const { stdout } = await execFileAsync('git', ['remote'], { cwd: projectPath });
      const remotes = (stdout || '').trim().split('\n').filter(Boolean);
      if (!remotes.includes(remote)) {
        // 'remote' is not a valid git remote, treat entire string as local branch
        return null;
      }
    } catch {
      // If we can't check remotes, fall back to original behavior
    }
  }

  return { remote, branch, fullRef: `${remote}/${branch}` };
}

/**
 * Build default base ref for a project
 */
export async function buildDefaultBaseRef(projectPath: string): Promise<BaseRefInfo> {
  const hasOrigin = await hasRemote(projectPath, 'origin');
  const branch = await getDefaultBranch(projectPath);
  const cleanBranch = branch?.trim() || 'main';

  if (hasOrigin) {
    return { remote: 'origin', branch: cleanBranch, fullRef: `origin/${cleanBranch}` };
  } else {
    // Local-only repo
    return { remote: '', branch: cleanBranch, fullRef: cleanBranch };
  }
}

/**
 * Resolve project base ref from settings with fallback
 */
export async function resolveProjectBaseRef(
  projectPath: string,
  projectId: string
): Promise<BaseRefInfo> {
  const settings = await projectSettingsService.getProjectSettings(projectId);
  if (!settings) {
    throw new Error(
      'Project settings not found. Please re-open the project in Emdash and try again.'
    );
  }

  const parsed = await parseBaseRef(settings.baseRef, projectPath);
  if (parsed) {
    return parsed;
  }

  // If parseBaseRef returned null, it might be a local branch name
  // Check if the baseRef exists as a local branch
  if (settings.baseRef) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--verify', `refs/heads/${settings.baseRef}`],
        { cwd: projectPath }
      );
      if (stdout?.trim()) {
        // It's a valid local branch - check if we have a remote
        const hasOrigin = await hasRemote(projectPath, 'origin');
        if (hasOrigin) {
          return {
            remote: 'origin',
            branch: settings.baseRef,
            fullRef: `origin/${settings.baseRef}`,
          };
        } else {
          // Local-only repo
          return {
            remote: '',
            branch: settings.baseRef,
            fullRef: settings.baseRef,
          };
        }
      }
    } catch {
      // Not a local branch, continue to fallback
    }
  }

  // Check if we have a remote
  const hasOrigin = await hasRemote(projectPath, 'origin');
  const fallbackBranch =
    settings.gitBranch?.trim() && !settings.gitBranch.includes(' ')
      ? settings.gitBranch.trim()
      : await getDefaultBranch(projectPath);
  const branch = fallbackBranch || 'main';

  if (hasOrigin) {
    return {
      remote: 'origin',
      branch,
      fullRef: `origin/${branch}`,
    };
  } else {
    // Local-only repo
    return {
      remote: '',
      branch,
      fullRef: branch,
    };
  }
}

/**
 * Fetch base ref with fallback to default branch
 */
export async function fetchBaseRefWithFallback(
  projectPath: string,
  projectId: string,
  target: BaseRefInfo
): Promise<BaseRefInfo> {
  // Check if remote exists - if not, this is a local-only repo
  const hasRemote = await hasRemote(projectPath, target.remote);

  if (!hasRemote) {
    log.info(`No remote '${target.remote}' found, using local branch ${target.branch}`);
    // Verify the local branch exists
    try {
      await execFileAsync('git', ['rev-parse', '--verify', target.branch], {
        cwd: projectPath,
      });
      // Return target with just the branch name (no remote prefix)
      return {
        remote: '',
        branch: target.branch,
        fullRef: target.branch,
      };
    } catch (error) {
      throw new Error(`Local branch '${target.branch}' does not exist. Please create it first.`);
    }
  }

  // Remote exists, proceed with fetch
  try {
    await fetchBranch(projectPath, target.remote, target.branch);
    log.info(`Fetched latest ${target.fullRef} for worktree creation`);
    return target;
  } catch (error) {
    log.warn(`Failed to fetch ${target.fullRef}`, error);
    if (!isMissingRemoteRefError(error)) {
      const message = extractErrorMessage(error) || 'Unknown git fetch error';
      throw new Error(`Failed to fetch ${target.fullRef}: ${message}`);
    }

    // Attempt fallback to default branch
    const fallback = await buildDefaultBaseRef(projectPath);
    if (fallback.fullRef === target.fullRef) {
      const message = extractErrorMessage(error) || 'Unknown git fetch error';
      throw new Error(`Failed to fetch ${target.fullRef}: ${message}`);
    }

    // Check if fallback remote exists before fetching
    const hasFallbackRemote = await hasRemote(projectPath, fallback.remote);
    if (!hasFallbackRemote) {
      throw new Error(
        `Failed to fetch ${target.fullRef} and fallback remote '${fallback.remote}' does not exist`
      );
    }

    try {
      await fetchBranch(projectPath, fallback.remote, fallback.branch);
      log.info(`Fetched fallback ${fallback.fullRef} after missing base ref`);

      try {
        await projectSettingsService.updateProjectSettings(projectId, {
          baseRef: fallback.fullRef,
        });
        log.info(`Updated project ${projectId} baseRef to fallback ${fallback.fullRef}`);
      } catch (persistError) {
        log.warn('Failed to persist fallback baseRef', persistError);
      }

      return fallback;
    } catch (fallbackError) {
      const msg = extractErrorMessage(fallbackError) || 'Unknown git fetch error';
      throw new Error(
        `Failed to fetch base branch. Tried ${target.fullRef} and ${fallback.fullRef}. ${msg} Please verify the branch exists on the remote.`
      );
    }
  }
}

/**
 * Fetch the latest base ref for a project (convenience wrapper)
 */
export async function fetchLatestBaseRef(
  projectPath: string,
  projectId: string
): Promise<BaseRefInfo> {
  const baseRefInfo = await resolveProjectBaseRef(projectPath, projectId);
  const fetched = await fetchBaseRefWithFallback(projectPath, projectId, baseRefInfo);
  return fetched;
}

/**
 * Get worktree status and changes
 */
export async function getWorktreeStatus(worktreePath: string): Promise<{
  hasChanges: boolean;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
}> {
  try {
    const { stdout: status } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      {
        cwd: worktreePath,
      }
    );

    const stagedFiles: string[] = [];
    const unstagedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    const lines = status
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);

    for (const line of lines) {
      const statusCode = line.substring(0, 2);
      const file = line.substring(3);

      if (statusCode.includes('A') || statusCode.includes('M') || statusCode.includes('D')) {
        stagedFiles.push(file);
      }
      if (statusCode.includes('M') || statusCode.includes('D')) {
        unstagedFiles.push(file);
      }
      if (statusCode.includes('??')) {
        untrackedFiles.push(file);
      }
    }

    return {
      hasChanges: stagedFiles.length > 0 || unstagedFiles.length > 0 || untrackedFiles.length > 0,
      stagedFiles,
      unstagedFiles,
      untrackedFiles,
    };
  } catch (error) {
    log.error('Failed to get worktree status:', error);
    return {
      hasChanges: false,
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: [],
    };
  }
}

/**
 * Checkout a branch in the repository
 */
export async function checkoutBranch(projectPath: string, branch: string): Promise<void> {
  await execFileAsync('git', ['checkout', branch], { cwd: projectPath });
}

/**
 * Merge a branch into the current branch
 */
export async function mergeBranch(projectPath: string, branch: string): Promise<void> {
  await execFileAsync('git', ['merge', branch], { cwd: projectPath });
}

/**
 * List all git worktrees for a repository
 */
export async function listGitWorktrees(projectPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list'], {
    cwd: projectPath,
  });
  return stdout;
}
