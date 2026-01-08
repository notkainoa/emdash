import { execFile } from 'child_process';
import { log } from '../lib/logger';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import {
  DEFAULT_PRESERVE_PATTERNS,
  DEFAULT_EXCLUDE_PATTERNS,
  type EmdashConfig,
  type PreserveResult,
} from '../lib/worktreeUtils';

const execFileAsync = promisify(execFile);

/**
 * Service for handling worktree-specific file operations
 * including configuration reading and file preservation
 */
export class WorktreeFileService {
  /**
   * Read .emdash.json config from project root
   */
  readProjectConfig(projectPath: string): EmdashConfig | null {
    try {
      const configPath = path.join(projectPath, '.emdash.json');
      if (!fs.existsSync(configPath)) {
        return null;
      }
      const content = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(content) as EmdashConfig;
    } catch {
      return null;
    }
  }

  /**
   * Get preserve patterns for a project (config or defaults)
   */
  getPreservePatterns(projectPath: string): string[] {
    const config = this.readProjectConfig(projectPath);
    if (config?.preservePatterns && Array.isArray(config.preservePatterns)) {
      return config.preservePatterns;
    }
    return DEFAULT_PRESERVE_PATTERNS;
  }

  /**
   * Get list of gitignored files in a directory using git ls-files
   */
  async getIgnoredFiles(dir: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['ls-files', '--others', '--ignored', '--exclude-standard'],
        { cwd: dir }
      );

      if (!stdout || !stdout.trim()) {
        return [];
      }

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch (error) {
      log.debug('Failed to list ignored files:', error);
      return [];
    }
  }

  /**
   * Check if a file path matches any of the preserve patterns
   */
  matchesPreservePattern(filePath: string, patterns: string[]): boolean {
    const fileName = path.basename(filePath);

    for (const pattern of patterns) {
      // Match against filename
      if (minimatch(fileName, pattern, { dot: true })) {
        return true;
      }
      // Match against full path
      if (minimatch(filePath, pattern, { dot: true })) {
        return true;
      }
      // Match against full path with ** prefix for nested matches
      if (minimatch(filePath, `**/${pattern}`, { dot: true })) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a file path contains any excluded path segments
   */
  isExcludedPath(filePath: string, excludePatterns: string[]): boolean {
    if (excludePatterns.length === 0) {
      return false;
    }

    // git ls-files always returns paths with forward slashes regardless of OS
    const parts = filePath.split('/');
    for (const part of parts) {
      if (excludePatterns.includes(part)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Copy a file safely, skipping if destination already exists
   */
  async copyFileExclusive(
    sourcePath: string,
    destPath: string
  ): Promise<'copied' | 'skipped' | 'error'> {
    try {
      // Check if destination already exists
      if (fs.existsSync(destPath)) {
        return 'skipped';
      }

      // Ensure destination directory exists
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Copy file preserving mode
      const content = fs.readFileSync(sourcePath);
      const stat = fs.statSync(sourcePath);
      fs.writeFileSync(destPath, content, { mode: stat.mode });

      return 'copied';
    } catch (error) {
      log.debug(`Failed to copy ${sourcePath} to ${destPath}:`, error);
      return 'error';
    }
  }

  /**
   * Preserve gitignored files (like .env) from source to destination worktree.
   * Only copies files that match the preserve patterns and don't exist in destination.
   */
  async preserveFilesToWorktree(
    sourceDir: string,
    destDir: string,
    patterns: string[] = DEFAULT_PRESERVE_PATTERNS,
    excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS
  ): Promise<PreserveResult> {
    const result: PreserveResult = { copied: [], skipped: [] };

    if (patterns.length === 0) {
      return result;
    }

    // Get all gitignored files from source directory
    const ignoredFiles = await this.getIgnoredFiles(sourceDir);

    if (ignoredFiles.length === 0) {
      log.debug('No ignored files found in source directory');
      return result;
    }

    // Filter files that match patterns and aren't excluded
    const filesToCopy: string[] = [];
    for (const file of ignoredFiles) {
      if (this.isExcludedPath(file, excludePatterns)) {
        continue;
      }

      if (this.matchesPreservePattern(file, patterns)) {
        filesToCopy.push(file);
      }
    }

    if (filesToCopy.length === 0) {
      log.debug('No files matched preserve patterns');
      return result;
    }

    log.info(`Preserving ${filesToCopy.length} file(s) to worktree: ${filesToCopy.join(', ')}`);

    // Copy each file
    for (const file of filesToCopy) {
      const sourcePath = path.join(sourceDir, file);
      const destPath = path.join(destDir, file);

      // Verify source file exists
      if (!fs.existsSync(sourcePath)) {
        log.debug(`Source file does not exist, skipping: ${sourcePath}`);
        continue;
      }

      const copyResult = await this.copyFileExclusive(sourcePath, destPath);

      if (copyResult === 'copied') {
        result.copied.push(file);
        log.debug(`Copied: ${file}`);
      } else if (copyResult === 'skipped') {
        result.skipped.push(file);
        log.debug(`Skipped (already exists): ${file}`);
      }
    }

    if (result.copied.length > 0) {
      log.info(`Preserved ${result.copied.length} file(s) to worktree`);
    }

    return result;
  }
}

export const worktreeFileService = new WorktreeFileService();
