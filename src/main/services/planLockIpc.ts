import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function isWindows() {
  return process.platform === 'win32';
}

type Entry = { p: string; m: number };

const YIELD_EVERY = 200;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function chmodNoWrite(mode: number, isDir: boolean): number {
  const noWrite = mode & ~0o222; // clear write bits
  if (isDir) {
    // Ensure traverse bits present
    return (noWrite | 0o111) & 0o7777;
  }
  return noWrite & 0o7777;
}

async function applyLock(
  root: string
): Promise<{ success: boolean; changed: number; error?: string }> {
  try {
    const state: Entry[] = [];
    let changed = 0;
    const stack = ['.'];
    let processed = 0;

    while (stack.length) {
      const rel = stack.pop()!;
      const abs = path.join(root, rel);
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;

      if (st.isDirectory()) {
        // Skip our internal folder so we can write logs/policies
        if (rel === '.emdash' || rel.startsWith(`.emdash${path.sep}`)) {
          continue;
        }
        const prevMode = st.mode & 0o7777;
        const nextMode = chmodNoWrite(prevMode, true);
        if (nextMode !== prevMode) {
          try {
            await fs.promises.chmod(abs, nextMode);
            state.push({ p: rel, m: prevMode });
            changed++;
          } catch {}
        }

        let entries: string[] = [];
        try {
          entries = await fs.promises.readdir(abs);
        } catch {
          continue;
        }
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          const nextRel = rel === '.' ? entry : path.join(rel, entry);
          stack.push(nextRel);
        }
      } else if (st.isFile()) {
        const prevMode = st.mode & 0o7777;
        const nextMode = chmodNoWrite(prevMode, false);
        if (nextMode !== prevMode) {
          try {
            await fs.promises.chmod(abs, nextMode);
            state.push({ p: rel, m: prevMode });
            changed++;
          } catch {}
        }
      }

      processed++;
      if (processed % YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
    // Persist lock state
    const baseDir = path.join(root, '.emdash');
    try {
      await fs.promises.mkdir(baseDir, { recursive: true });
    } catch {}
    const statePath = path.join(baseDir, '.planlock.json');
    try {
      await fs.promises.writeFile(statePath, JSON.stringify(state), 'utf8');
    } catch {}
    return { success: true, changed };
  } catch (e: any) {
    return { success: false, changed: 0, error: e?.message || String(e) };
  }
}

async function releaseLock(
  root: string
): Promise<{ success: boolean; restored: number; error?: string }> {
  try {
    const statePath = path.join(root, '.emdash', '.planlock.json');
    let raw = '';
    try {
      raw = await fs.promises.readFile(statePath, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { success: true, restored: 0 };
    }
    let entries: Entry[] = [];
    try {
      entries = JSON.parse(raw || '[]');
    } catch {}
    let restored = 0;
    let processed = 0;
    for (const ent of entries) {
      try {
        const abs = path.join(root, ent.p);
        await fs.promises.chmod(abs, ent.m);
        restored++;
      } catch {}
      processed++;
      if (processed % YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
    // Cleanup state file
    try {
      await fs.promises.unlink(statePath);
    } catch {}
    return { success: true, restored };
  } catch (e: any) {
    return { success: false, restored: 0, error: e?.message || String(e) };
  }
}

export function registerPlanLockIpc(): void {
  ipcMain.handle('plan:lock', async (_e, taskPath: string) => {
    if (isWindows()) {
      // Best-effort: still attempt chmod; ACL hardening could be added with icacls in a future pass
      return applyLock(taskPath);
    }
    return applyLock(taskPath);
  });

  ipcMain.handle('plan:unlock', async (_e, taskPath: string) => {
    if (isWindows()) {
      return releaseLock(taskPath);
    }
    return releaseLock(taskPath);
  });
}
