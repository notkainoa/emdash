import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'util';
import fs from 'node:fs';

const execCalls: string[] = [];
const execAsyncResults = new Map<string, { stdout: string; stderr: string }>();

const { handlers, handleMock } = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>();
  const handleMock = vi.fn(
    (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler);
    }
  );
  return { handlers, handleMock };
});

vi.mock('child_process', () => {
  const execImpl = (command: string, options?: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    execCalls.push(command);

    const respond = (result: { stdout: string; stderr: string } | null, error?: any) => {
      setImmediate(() => {
        if (error) {
          cb?.(error, '', '');
        } else {
          cb?.(null, result?.stdout || '', result?.stderr || '');
        }
      });
    };

    // Check for predefined results
    const predefined = execAsyncResults.get(command);
    if (predefined) {
      respond(predefined);
      return { kill: vi.fn() };
    }

    // Default responses
    if (command.includes('git rev-parse --is-inside-work-tree')) {
      respond({ stdout: 'true\n', stderr: '' });
    } else if (command.includes('gh repo view --json nameWithOwner,viewerPermission')) {
      respond({
        stdout: JSON.stringify({
          nameWithOwner: 'owner/repo',
          viewerPermission: 'WRITE',
          isFork: false,
          parent: null,
          defaultBranchRef: { name: 'main' },
        }),
        stderr: '',
      });
    } else if (command.includes('gh api user -q .login')) {
      respond({ stdout: 'testuser\n', stderr: '' });
    } else if (command.includes('gh repo view "testuser/')) {
      respond({ stdout: 'Fork exists\n', stderr: '' });
    } else if (command.includes('git branch --show-current')) {
      respond({ stdout: 'feature-branch\n', stderr: '' });
    } else if (command.includes('git status --porcelain')) {
      respond({ stdout: '', stderr: '' });
    } else if (command.includes('git diff --cached --name-only')) {
      respond({ stdout: '', stderr: '' });
    } else if (command.includes('git rev-list --count')) {
      respond({ stdout: '3\n', stderr: '' });
    } else if (command.includes('git remote get-url origin')) {
      respond({ stdout: 'git@github.com:owner/repo.git\n', stderr: '' });
    } else if (command.includes('gh api repos/testuser/')) {
      respond({ stdout: 'git@github.com:testuser/repo.git\n', stderr: '' });
    } else if (command.includes('gh api -X POST repos/')) {
      respond({ stdout: 'Fork created\n', stderr: '' });
    } else if (command.includes('git remote get-url fork')) {
      respond(null, new Error('No such remote'));
    } else if (command.includes('git remote add fork')) {
      respond({ stdout: '', stderr: '' });
    } else if (command.includes('git push --set-upstream fork')) {
      respond({ stdout: 'Push successful\n', stderr: '' });
    } else if (command.includes('gh pr create')) {
      respond({ stdout: 'https://github.com/owner/repo/pull/123\n', stderr: '' });
    } else {
      respond({ stdout: '', stderr: '' });
    }

    return { kill: vi.fn() };
  };

  (execImpl as any)[promisify.custom] = (command: string, options?: any) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execImpl(command, options, (err: any, stdout: string, stderr: string) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  };

  return {
    exec: execImpl,
    execFile: vi.fn(),
  };
});

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
  },
}));

vi.mock('../../main/lib/logger', () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../main/services/GitService', () => ({
  getStatus: vi.fn(),
  getFileDiff: vi.fn(),
  stageFile: vi.fn(),
  revertFile: vi.fn(),
}));

vi.mock('../../main/services/PrGenerationService', () => ({
  prGenerationService: {
    generatePrContent: vi.fn(),
  },
}));

vi.mock('../../main/services/DatabaseService', () => ({
  databaseService: {
    query: vi.fn(),
  },
}));

// eslint-disable-next-line import/first
import { registerGitIpc } from '../../main/ipc/gitIpc';

function getHandler(channel: string) {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Handler for ${channel} not registered`);
  }
  return handler;
}

describe('GitIpc - git:get-pr-capabilities', () => {
  beforeEach(() => {
    handlers.clear();
    handleMock.mockClear();
    execCalls.length = 0;
    execAsyncResults.clear();
    vi.clearAllMocks();
  });

  it('returns error when taskPath is missing', async () => {
    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    const result = await handler({}, {});

    expect(result).toEqual({ success: false, error: 'taskPath is required' });
  });

  it('returns error when not in a git repository', async () => {
    execAsyncResults.set('git rev-parse --is-inside-work-tree', {
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    // Mock exec to throw for git check
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementationOnce(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;
        setImmediate(() => cb(new Error('not a git repository'), '', ''));
        return { kill: vi.fn() };
      }) as any
    );

    const result = await handler({}, { taskPath: '/not/a/repo' });

    expect(result).toEqual({ success: false, error: 'Not a git repository' });
  });

  it('returns PR capabilities when user has write access', async () => {
    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      success: true,
      canPushToBase: true,
      viewerPermission: 'WRITE',
      nameWithOwner: 'owner/repo',
      baseRepo: 'owner/repo',
      parentRepo: null,
      isFork: false,
      viewerLogin: 'testuser',
      defaultBranch: 'main',
      hasFork: true,
    });
  });

  it('detects read-only permission correctly', async () => {
    execAsyncResults.set(
      'gh repo view --json nameWithOwner,viewerPermission,isFork,parent,defaultBranchRef',
      {
        stdout: JSON.stringify({
          nameWithOwner: 'upstream/repo',
          viewerPermission: 'READ',
          isFork: false,
          parent: null,
          defaultBranchRef: { name: 'main' },
        }),
        stderr: '',
      }
    );

    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      success: true,
      canPushToBase: false,
      viewerPermission: 'READ',
    });
  });

  it('handles fork detection correctly', async () => {
    execAsyncResults.set(
      'gh repo view --json nameWithOwner,viewerPermission,isFork,parent,defaultBranchRef',
      {
        stdout: JSON.stringify({
          nameWithOwner: 'testuser/repo',
          viewerPermission: 'ADMIN',
          isFork: true,
          parent: { nameWithOwner: 'upstream/repo' },
          defaultBranchRef: { name: 'develop' },
        }),
        stderr: '',
      }
    );

    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    const result = await handler({}, { taskPath: '/tmp/fork' });

    expect(result).toMatchObject({
      success: true,
      canPushToBase: true,
      isFork: true,
      parentRepo: 'upstream/repo',
      baseRepo: 'upstream/repo',
      defaultBranch: 'develop',
    });
  });

  it('handles missing viewer login gracefully', async () => {
    execAsyncResults.set('gh api user -q .login', {
      stdout: '',
      stderr: 'Error',
    });

    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      success: true,
      viewerLogin: '',
      hasFork: false,
    });
  });

  it('detects when user does not have a fork', async () => {
    const originalExec = await import('child_process');
    let callCount = 0;
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;
        callCount++;

        if (command.includes('gh repo view "testuser/')) {
          // Simulate fork not found
          setImmediate(() => cb(new Error('not found'), '', 'repository not found'));
        } else {
          // Default success response
          setImmediate(() => cb(null, 'success', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      hasFork: false,
    });
  });

  it('handles gh command failures gracefully', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('gh repo view --json')) {
          setImmediate(() => cb(new Error('gh not authenticated'), '', 'Not logged in'));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:get-pr-capabilities');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('gh not authenticated'),
    });
  });
});

describe('GitIpc - git:create-pr-from-fork', () => {
  beforeEach(() => {
    handlers.clear();
    handleMock.mockClear();
    execCalls.length = 0;
    execAsyncResults.clear();
    vi.clearAllMocks();
  });

  it('returns error when taskPath is missing', async () => {
    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, {});

    expect(result).toEqual({ success: false, error: 'taskPath is required' });
  });

  it('returns error when not in a git repository', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementationOnce(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;
        setImmediate(() => cb(new Error('not a git repository'), '', ''));
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/not/a/repo' });

    expect(result).toEqual({ success: false, error: 'Not a git repository' });
  });

  it('creates PR from fork successfully with all default options', async () => {
    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, {
      taskPath: '/tmp/repo',
      title: 'Test PR',
      body: 'Test body',
    });

    expect(result).toMatchObject({
      success: true,
      url: 'https://github.com/owner/repo/pull/123',
      fork: 'testuser/repo',
      baseRepo: 'owner/repo',
    });

    // Verify key commands were called
    const commands = execCalls.join(' ');
    expect(commands).toContain('gh repo view');
    expect(commands).toContain('gh api user');
    expect(commands).toContain('git push --set-upstream fork');
    expect(commands).toContain('gh pr create');
  });

  it('requires GitHub authentication', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(new Error('not authenticated'), '', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toEqual({
      success: false,
      error: 'GitHub authentication required. Please run gh auth login.',
    });
  });

  it('creates a new branch when on default branch', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'main\n', ''));
        } else if (command.includes('git checkout -b')) {
          setImmediate(() => cb(null, 'Switched to new branch\n', ''));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(
              null,
              JSON.stringify({
                nameWithOwner: 'owner/repo',
                isFork: false,
                defaultBranchRef: { name: 'main' },
              }),
              ''
            )
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('gh api repos/testuser/repo')) {
          setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
        } else if (command.includes('gh pr create')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo/pull/123\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, {
      taskPath: '/tmp/repo',
      createBranchIfOnDefault: true,
      branchPrefix: 'test',
    });

    expect(result.success).toBe(true);
    const checkoutCmd = execCalls.find((cmd) => cmd.includes('git checkout -b'));
    expect(checkoutCmd).toBeDefined();
    expect(checkoutCmd).toContain('test/');
  });

  it('stages and commits changes when present', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git status --porcelain')) {
          setImmediate(() => cb(null, 'M  file.txt\n?? new.txt\n', ''));
        } else if (command.includes('git diff --cached --name-only')) {
          setImmediate(() => cb(null, '', ''));
        } else if (command.includes('git add -A')) {
          setImmediate(() => cb(null, '', ''));
        } else if (command.includes('git commit')) {
          setImmediate(() => cb(null, '[main abc123] commit message\n', ''));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh api repos/testuser/repo')) {
          setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
        } else if (command.includes('gh pr create')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo/pull/123\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, {
      taskPath: '/tmp/repo',
      commitMessage: 'test commit',
    });

    expect(result.success).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('git add -A'))).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('git commit'))).toBe(true);
  });

  it('respects manually staged files', async () => {
    const originalExec = await import('child_process');
    let diffCachedCallCount = 0;

    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git diff --cached --name-only')) {
          diffCachedCallCount++;
          if (diffCachedCallCount === 1) {
            // First call: files already staged
            setImmediate(() => cb(null, 'staged-file.txt\n', ''));
          } else {
            // Subsequent calls
            setImmediate(() => cb(null, 'staged-file.txt\n', ''));
          }
        } else if (command.includes('git status --porcelain')) {
          setImmediate(() => cb(null, 'M  staged-file.txt\n', ''));
        } else if (command.includes('git commit')) {
          setImmediate(() => cb(null, '[main abc123] commit\n', ''));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh api repos/testuser/repo')) {
          setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
        } else if (command.includes('gh pr create')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo/pull/123\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result.success).toBe(true);
    // Should not call git add -A since files are already staged
    expect(execCalls.some((cmd) => cmd.includes('git add -A'))).toBe(false);
  });

  it('filters out planning artifacts from commits', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git status --porcelain')) {
          setImmediate(() => cb(null, 'M  file.txt\nA  PLANNING.md\n', ''));
        } else if (command.includes('git diff --cached --name-only')) {
          setImmediate(() => cb(null, '', ''));
        } else if (command.includes('git reset -q')) {
          setImmediate(() => cb(null, '', ''));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh api repos/testuser/repo')) {
          setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
        } else if (command.includes('gh pr create')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo/pull/123\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result.success).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('git reset -q PLANNING.md'))).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('git reset -q planning.md'))).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('git reset -q .emdash'))).toBe(true);
  });

  it('creates fork if it does not exist', async () => {
    const originalExec = await import('child_process');
    let forkCheckCount = 0;

    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('gh api repos/testuser/repo') && command.includes('-q')) {
          forkCheckCount++;
          if (forkCheckCount === 1) {
            // Fork doesn't exist yet
            setImmediate(() => cb(new Error('Not Found'), '', 'HTTP 404'));
          } else {
            // Fork exists after creation
            setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
          }
        } else if (command.includes('gh api -X POST repos/')) {
          setImmediate(() => cb(null, 'Fork created\n', ''));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh pr create')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo/pull/123\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result.success).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('gh api -X POST repos/'))).toBe(true);
  });

  it('handles fork creation failure', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('gh api repos/testuser/repo') && command.includes('-q')) {
          setImmediate(() => cb(new Error('Not Found'), '', 'HTTP 404'));
        } else if (command.includes('gh api -X POST repos/')) {
          setImmediate(() => cb(new Error('Permission denied'), '', 'Cannot fork'));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Failed to create fork'),
    });
  });

  it('handles push failure gracefully', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git push --set-upstream fork')) {
          setImmediate(() => cb(new Error('Push rejected'), '', 'Permission denied'));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh api repos/testuser/repo')) {
          setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Failed to push branch to fork'),
    });
  });

  it('uses body file for PR body content', async () => {
    const longBody = 'A'.repeat(1000);
    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, {
      taskPath: '/tmp/repo',
      title: 'Test PR',
      body: longBody,
    });

    expect(result.success).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalled();

    const prCreateCmd = execCalls.find((cmd) => cmd.includes('gh pr create'));
    expect(prCreateCmd).toContain('--body-file');
  });

  it('supports draft PRs', async () => {
    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, {
      taskPath: '/tmp/repo',
      draft: true,
    });

    expect(result.success).toBe(true);
    const prCreateCmd = execCalls.find((cmd) => cmd.includes('gh pr create'));
    expect(prCreateCmd).toContain('--draft');
  });

  it('supports web flow', async () => {
    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, {
      taskPath: '/tmp/repo',
      web: true,
    });

    expect(result.success).toBe(true);
    const prCreateCmd = execCalls.find((cmd) => cmd.includes('gh pr create'));
    expect(prCreateCmd).toContain('--web');
  });

  it('detects PR URL from output', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('gh pr create')) {
          setImmediate(() =>
            cb(null, 'Creating pull request\nhttps://github.com/owner/repo/pull/456\n', '')
          );
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh api repos/testuser/repo')) {
          setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result).toMatchObject({
      success: true,
      url: 'https://github.com/owner/repo/pull/456',
    });
  });

  it('prefers SSH URLs when origin uses SSH', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git remote get-url origin')) {
          setImmediate(() => cb(null, 'git@github.com:owner/repo.git\n', ''));
        } else if (command.includes('gh api repos/testuser/repo -q .ssh_url')) {
          setImmediate(() => cb(null, 'git@github.com:testuser/repo.git\n', ''));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh pr create')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo/pull/123\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result.success).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('.ssh_url'))).toBe(true);
  });

  it('handles HTTPS URLs when origin uses HTTPS', async () => {
    const originalExec = await import('child_process');
    vi.mocked(originalExec.exec).mockImplementation(
      ((command: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;

        if (command.includes('git remote get-url origin')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo.git\n', ''));
        } else if (command.includes('gh api repos/testuser/repo -q .clone_url')) {
          setImmediate(() => cb(null, 'https://github.com/testuser/repo.git\n', ''));
        } else if (command.includes('git rev-parse')) {
          setImmediate(() => cb(null, 'true\n', ''));
        } else if (command.includes('gh repo view')) {
          setImmediate(() =>
            cb(null, JSON.stringify({ nameWithOwner: 'owner/repo', isFork: false }), '')
          );
        } else if (command.includes('gh api user')) {
          setImmediate(() => cb(null, 'testuser\n', ''));
        } else if (command.includes('git branch --show-current')) {
          setImmediate(() => cb(null, 'feature\n', ''));
        } else if (command.includes('gh pr create')) {
          setImmediate(() => cb(null, 'https://github.com/owner/repo/pull/123\n', ''));
        } else {
          setImmediate(() => cb(null, '', ''));
        }
        return { kill: vi.fn() };
      }) as any
    );

    registerGitIpc();
    const handler = getHandler('git:create-pr-from-fork');

    const result = await handler({}, { taskPath: '/tmp/repo' });

    expect(result.success).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes('.clone_url'))).toBe(true);
  });
});