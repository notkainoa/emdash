/**
 * Custom slash command support for ACP agents
 *
 * This module provides functionality to scan for user-created slash commands
 * in agent-specific directories, allowing Emdash to show only custom commands
 * rather than built-in ones.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProviderId } from './registry';

/**
 * A custom slash command discovered from the filesystem
 */
export interface CustomSlashCommand {
  /** Command name (filename without extension) */
  name: string;
  /** Human-readable description (extracted from file content) */
  description?: string;
  /** Whether this is a project-level or global command */
  source: 'project' | 'global';
  /** The provider this command belongs to */
  provider: ProviderId;
  /** Full file path for debugging/reference */
  filePath: string;
}

/**
 * Configuration for where to find custom commands for each provider
 */
export interface CommandDirectoryConfig {
  /** The provider ID */
  provider: ProviderId;
  /** Project-relative directories where commands are stored (scans all) */
  projectDirs: string[];
  /** Global directories (relative to home dir) where commands are stored (scans all) */
  globalDirs: string[];
  /** File extension for command files */
  extension: string;
}

/**
 * Known command directories for each ACP provider
 */
export const COMMAND_DIRECTORIES: Partial<Record<ProviderId, CommandDirectoryConfig>> = {
  codex: {
    provider: 'codex',
    projectDirs: ['.codex/prompts', '.codex/commands'],
    globalDirs: ['~/.codex/prompts', '~/.codex/commands'],
    extension: '.md',
  },
  claude: {
    provider: 'claude',
    projectDirs: ['.claude/commands'],
    globalDirs: ['~/.claude/commands'],
    extension: '.md',
  },
  gemini: {
    provider: 'gemini',
    projectDirs: ['.gemini/commands'],
    globalDirs: ['~/.gemini/commands'],
    extension: '.toml',
  },
  // Note: Other providers (cursor, etc.) can be added here when their
  // custom command directories are known
};

/**
 * Expand ~ to home directory
 */
function expandHome(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Read directory and return files matching the extension
 */
async function readDirectory(dirPath: string, extension: string): Promise<string[]> {
  console.log(
    '[custom-commands readDirectory] Reading directory:',
    dirPath,
    'extension:',
    extension
  );
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name);
    console.log('[custom-commands readDirectory] Found files:', files.length, files);
    return files;
  } catch (error: unknown) {
    // Directory doesn't exist or isn't readable - not an error
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'EACCES')
    ) {
      console.log(
        '[custom-commands readDirectory] Directory does not exist or is not accessible:',
        dirPath
      );
      return [];
    }
    console.error('[custom-commands readDirectory] Error reading directory:', dirPath, error);
    throw error;
  }
}

/**
 * Read file content and extract description
 *
 * For .md files, tries to find:
 * 1. First heading (# Title)
 * 2. First line (if short)
 */
function extractDescription(content: string): string | undefined {
  const lines = content.split('\n').map((l) => l.trim());

  for (const line of lines) {
    if (!line) continue;

    // Check for # heading
    if (line.startsWith('#')) {
      return line.substring(1).trim();
    }

    // Use first non-empty line as description (if short enough)
    if (line.length < 100 && line.length > 0) {
      return line;
    }

    break;
  }

  return undefined;
}

/**
 * Scan for custom slash commands in a directory
 */
async function scanCommandsDirectory(
  dirPath: string,
  source: 'project' | 'global',
  provider: ProviderId,
  extension: string
): Promise<CustomSlashCommand[]> {
  const commands: CustomSlashCommand[] = [];
  const files = await readDirectory(dirPath, extension);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const name = file.endsWith(extension) ? file.slice(0, -extension.length) : file;
      const description = extractDescription(content);

      commands.push({
        name,
        description,
        source,
        provider,
        filePath,
      });
    } catch (error) {
      // Skip files we can't read
      console.warn(`Failed to read command file ${filePath}:`, error);
    }
  }

  return commands;
}

/**
 * Scan for custom slash commands for a specific provider
 *
 * @param projectPath - The project root directory
 * @param providerId - The provider to scan commands for
 * @returns Array of custom commands (both project and global)
 */
export async function scanCustomCommands(
  projectPath: string,
  providerId: ProviderId
): Promise<CustomSlashCommand[]> {
  console.log('[custom-commands scan] Starting scan', { projectPath, providerId });
  const config = COMMAND_DIRECTORIES[providerId];
  if (!config) {
    console.log('[custom-commands scan] No config found for provider:', providerId);
    return [];
  }

  const commands: CustomSlashCommand[] = [];

  // Scan all project directories
  for (const projectDir of config.projectDirs) {
    const projectDirPath = path.join(projectPath, projectDir);
    console.log('[custom-commands scan] Scanning project directory:', projectDirPath);
    const projectCommands = await scanCommandsDirectory(
      projectDirPath,
      'project',
      providerId,
      config.extension
    );
    console.log('[custom-commands scan] Found project commands:', projectCommands.length);
    commands.push(...projectCommands);
  }

  // Scan all global directories
  for (const globalDir of config.globalDirs) {
    const globalDirPath = expandHome(globalDir);
    console.log('[custom-commands scan] Scanning global directory:', globalDirPath);
    const globalCommands = await scanCommandsDirectory(
      globalDirPath,
      'global',
      providerId,
      config.extension
    );
    console.log('[custom-commands scan] Found global commands:', globalCommands.length);

    // Filter out global commands that are overridden by project commands
    for (const globalCmd of globalCommands) {
      if (!commands.some((c) => c.name === globalCmd.name)) {
        commands.push(globalCmd);
      }
    }
  }

  console.log('[custom-commands scan] Total unique commands:', commands.length);
  return commands;
}

/**
 * Get all providers that support custom commands
 */
export function getProvidersWithCustomCommands(): ProviderId[] {
  return Object.keys(COMMAND_DIRECTORIES) as ProviderId[];
}
