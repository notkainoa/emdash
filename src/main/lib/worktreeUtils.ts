import { execFile } from 'child_process';
import { log } from './logger';
import { promisify } from 'util';
import path from 'path';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

export type BaseRefInfo = { remote: string; branch: string; fullRef: string };

/** Default patterns for files to preserve when creating worktrees */
export const DEFAULT_PRESERVE_PATTERNS = [
  '.env',
  '.env.keys',
  '.env.local',
  '.env.*.local',
  '.envrc',
  'docker-compose.override.yml',
];

/** Default path segments to exclude from preservation */
export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'vendor',
  '.cache',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
];

/** Project-level config stored in .emdash.json */
export interface EmdashConfig {
  preservePatterns?: string[];
}

export interface PreserveResult {
  copied: string[];
  skipped: string[];
}

/**
 * Slugify task name to make it shell-safe
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Best-effort sanitization to ensure the branch name is a valid ref.
 */
export function sanitizeBranchName(name: string): string {
  // Disallow illegal characters for Git refs, keep common allowed set including '/','-','_','.'
  let n = name
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._\/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/');
  // No leading or trailing separators or dots
  n = n.replace(/^[./-]+/, '').replace(/[./-]+$/, '');
  // Avoid reserved ref names
  if (!n || n === 'HEAD') {
    n = `agent/${slugify('task')}-${Date.now()}`;
  }
  return n;
}

/**
 * Render a branch name from a user-configurable template.
 * Supported placeholders: {slug}, {timestamp}
 */
export function renderBranchNameTemplate(
  template: string,
  ctx: { slug: string; timestamp: string }
): string {
  const replaced = template
    .replace(/\{slug\}/g, ctx.slug)
    .replace(/\{timestamp\}/g, ctx.timestamp);
  return sanitizeBranchName(replaced);
}

/**
 * Extract a stable prefix from the user template, if any, prior to the first placeholder.
 * E.g. 'agent/{slug}-{timestamp}' -> 'agent'
 */
export function extractTemplatePrefix(template?: string): string | null {
  if (!template || typeof template !== 'string') return null;
  const idx = template.indexOf('{');
  const head = (idx >= 0 ? template.slice(0, idx) : template).trim();
  const cleaned = head.replace(/\s+/g, '');
  if (!cleaned) return null;
  // If there's a slash in the head, take the segment before the first slash
  const seg = cleaned
    .split('/')[0]
    ?.replace(/^[./-]+/, '')
    .replace(/[./-]+$/, '');
  return seg || null;
}

/**
 * Extract error message from git error object
 */
export function extractErrorMessage(error: any): string {
  if (!error) return '';
  const parts: Array<string | undefined> = [];
  if (typeof error.message === 'string') parts.push(error.message);
  if (typeof error.stderr === 'string') parts.push(error.stderr);
  if (typeof error.stdout === 'string') parts.push(error.stdout);
  return parts.filter(Boolean).join(' ').trim();
}

/**
 * Check if error indicates a missing remote ref
 */
export function isMissingRemoteRefError(error: any): boolean {
  const msg = extractErrorMessage(error).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("couldn't find remote ref") ||
    msg.includes('could not find remote ref') ||
    msg.includes('remote ref does not exist') ||
    msg.includes('fatal: the remote end hung up unexpectedly') ||
    msg.includes('no such ref was fetched')
  );
}

/**
 * Generate a stable ID from the absolute worktree path.
 */
export function stableIdFromPath(worktreePath: string): string {
  const abs = path.resolve(worktreePath);
  const h = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);
  return `wt-${h}`;
}

/**
 * Verify worktree sync status after creation by comparing SHAs
 */
export async function logWorktreeSyncStatus(
  projectPath: string,
  worktreePath: string,
  baseRef: BaseRefInfo
): Promise<void> {
  try {
    const [{ stdout: remoteOut }, { stdout: worktreeOut }] = await Promise.all([
      execFileAsync('git', ['rev-parse', baseRef.fullRef], { cwd: projectPath }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath }),
    ]);
    const remoteSha = (remoteOut || '').trim();
    const worktreeSha = (worktreeOut || '').trim();
    if (!remoteSha || !worktreeSha) return;
    if (remoteSha === worktreeSha) {
      log.debug(`Worktree ${worktreePath} matches ${baseRef.fullRef} @ ${remoteSha}`);
    } else {
      log.warn(
        `Worktree ${worktreePath} diverged from ${baseRef.fullRef} immediately after creation`,
        { remoteSha, worktreeSha, baseRef: baseRef.fullRef }
      );
    }
  } catch (error) {
    log.debug('Unable to verify worktree head against remote', error);
  }
}
