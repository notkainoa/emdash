import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLANNING_MD } from '@/lib/planRules';
import { log } from '@/lib/logger';
import { logPlanEvent } from '@/lib/planLogs';

type PlanModeOptions = {
  disabled?: boolean;
};

export function usePlanMode(
  taskId: string,
  taskPath: string,
  scope?: string,
  options: PlanModeOptions = {}
) {
  const disabled = options.disabled ?? false;
  const key = useMemo(
    () => `planMode:${taskId}${scope ? `:${scope}` : ''}`,
    [taskId, scope]
  );
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (disabled) return false;
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const skipPersistRef = useRef(false);

  useEffect(() => {
    if (disabled) {
      setEnabled(false);
      return;
    }
    skipPersistRef.current = true;
    try {
      setEnabled(localStorage.getItem(key) === '1');
    } catch {
      setEnabled(false);
    }
  }, [disabled, key]);

  // Persist flag
  useEffect(() => {
    if (disabled) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    try {
      if (enabled) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch {}
  }, [disabled, enabled, key]);

  const ensurePlanFile = useCallback(async () => {
    try {
      // Hidden policy file in .emdash/
      const hiddenRel = '.emdash/planning.md';
      log.info('[plan] writing policy (hidden)', { taskPath, hiddenRel });
      const resHidden = await (window as any).electronAPI.fsWriteFile(
        taskPath,
        hiddenRel,
        PLANNING_MD,
        true
      );
      if (!resHidden?.success) {
        log.warn('[plan] failed to write hidden planning.md', resHidden?.error);
      }

      // Root-level helper only for non-worktree repos and only if it doesn't exist.
      let wroteRootHelper = false;
      try {
        const gitRef = await (window as any).electronAPI.fsRead(taskPath, '.git', 1024);
        const isWorktree = !!(
          gitRef?.success &&
          typeof gitRef.content === 'string' &&
          /^gitdir:\s*/i.test(gitRef.content.trim())
        );
        if (!isWorktree) {
          const rootRel = 'PLANNING.md';
          let exists = false;
          try {
            const readTry = await (window as any).electronAPI.fsRead?.(taskPath, rootRel, 1);
            exists = !!readTry?.success;
          } catch {}
          if (!exists) {
            log.info('[plan] writing policy (root helper)', { taskPath, rootRel });
            const rootHeader = '# Plan Mode (Read‑only)\n\n';
            const rootBody = `${rootHeader}${PLANNING_MD}`;
            const resRoot = await (window as any).electronAPI.fsWriteFile(
              taskPath,
              rootRel,
              rootBody,
              true
            );
            if (!resRoot?.success) {
              log.warn('[plan] failed to write root PLANNING.md', resRoot?.error);
            } else {
              wroteRootHelper = true;
            }
          }
        }
      } catch {}

      // Record whether we created the root helper (for safe cleanup)
      try {
        const metaRel = '.emdash/planning.meta.json';
        const meta = { wroteRootHelper };
        await (window as any).electronAPI.fsWriteFile(
          taskPath,
          metaRel,
          JSON.stringify(meta),
          true
        );
      } catch {}

      await logPlanEvent(taskPath, 'planning.md written (hidden; root helper maybe)');
    } catch (e) {
      log.warn('[plan] failed to write planning.md', e);
    }
  }, [taskPath]);

  const ensureGitExclude = useCallback(async () => {
    try {
      // For worktrees, we cannot safely write to the external gitdir from renderer; rely on
      // commit-time exclusions and UI filtering. For normal repos, update .git/info/exclude.
      try {
        const gitRef = await window.electronAPI.fsRead(taskPath, '.git', 1024);
        if (gitRef?.success && typeof gitRef.content === 'string') {
          const txt = gitRef.content.trim();
          if (/^gitdir:\s*/i.test(txt)) {
            log.info('[plan] worktree detected; skip .git/info/exclude');
            return;
          }
        }
      } catch {}

      const rel = '.git/info/exclude';
      let current = '';
      try {
        const read = await window.electronAPI.fsRead(taskPath, rel, 32 * 1024);
        if (read?.success && typeof read.content === 'string') current = read.content;
      } catch {}
      const lines: string[] = [];
      if (!current.includes('.emdash/')) lines.push('.emdash/');
      if (!current.includes('PLANNING.md')) lines.push('PLANNING.md');
      if (!current.toLowerCase().includes('planning.md')) lines.push('planning.md');
      if (lines.length === 0) return;
      const next = `${current.trimEnd()}\n# emdash plan mode\n${lines.join('\n')}\n`;
      log.info('[plan] appending .emdash/ to git exclude');
      await (window as any).electronAPI.fsWriteFile(taskPath, rel, next, true);
      await logPlanEvent(taskPath, 'updated .git/info/exclude with .emdash/');
    } catch (e) {
      log.warn('[plan] failed to update git exclude', e);
    }
  }, [taskPath]);

  const removePlanFile = useCallback(async () => {
    try {
      const hiddenRel = '.emdash/planning.md';
      await (window as any).electronAPI.fsRemove(taskPath, hiddenRel);
      // Only remove root helper if we created it
      try {
        const metaRel = '.emdash/planning.meta.json';
        const metaRead = await (window as any).electronAPI.fsRead?.(taskPath, metaRel, 4096);
        const meta =
          metaRead?.success && typeof metaRead.content === 'string'
            ? JSON.parse(metaRead.content)
            : {};
        if (meta?.wroteRootHelper) {
          const rootRel = 'PLANNING.md';
          await (window as any).electronAPI.fsRemove(taskPath, rootRel);
        }
        try {
          await (window as any).electronAPI.fsRemove(taskPath, metaRel);
        } catch {}
      } catch {}
    } catch (e) {
      // ignore
    }
  }, [taskPath]);

  const cleanupPlanMode = useCallback(async () => {
    // Only perform disable cleanup if there is evidence plan mode was active
    let wasActive = false;
    try {
      const hiddenRel = '.emdash/planning.md';
      const lockRel = '.emdash/.planlock.json';
      const metaRel = '.emdash/planning.meta.json';
      const a = await (window as any).electronAPI.fsRead?.(taskPath, hiddenRel, 1);
      const b = await (window as any).electronAPI.fsRead?.(taskPath, lockRel, 1);
      const c = await (window as any).electronAPI.fsRead?.(taskPath, metaRel, 1);
      wasActive = !!(a?.success || b?.success || c?.success);
    } catch {}

    if (!wasActive) return;
    log.info('[plan] disabled', { taskId, taskPath });
    await logPlanEvent(taskPath, 'Plan Mode disabled');
    void (async () => {
      const { captureTelemetry } = await import('../lib/telemetryClient');
      captureTelemetry('plan_mode_disabled');
    })();
    try {
      const unlock = await (window as any).electronAPI.planReleaseLock(taskPath);
      if (!unlock?.success) log.warn('[plan] failed to release lock', unlock?.error);
      else
        await logPlanEvent(
          taskPath,
          `Released read-only lock (restored=${unlock.restored ?? 0})`
        );
    } catch (e) {
      log.warn('[plan] planReleaseLock error', e);
    }
    removePlanFile();
  }, [removePlanFile, taskId, taskPath]);

  // Side effects on enable/disable
  useEffect(() => {
    (async () => {
      if (disabled) {
        if (enabled) {
          setEnabled(false);
        }
        await cleanupPlanMode();
        return;
      }
      if (enabled) {
        log.info('[plan] enabled', { taskId, taskPath });
        await logPlanEvent(taskPath, 'Plan Mode enabled');
        void (async () => {
          const { captureTelemetry } = await import('../lib/telemetryClient');
          captureTelemetry('plan_mode_enabled');
        })();
        ensureGitExclude();
        await ensurePlanFile();
        try {
          const lock = await (window as any).electronAPI.planApplyLock(taskPath);
          if (!lock?.success) log.warn('[plan] failed to apply lock', lock?.error);
          else
            await logPlanEvent(taskPath, `Applied read-only lock (changed=${lock.changed ?? 0})`);
        } catch (e) {
          log.warn('[plan] planApplyLock error', e);
        }
      } else {
        await cleanupPlanMode();
      }
    })();
  }, [cleanupPlanMode, disabled, enabled, ensureGitExclude, ensurePlanFile, taskId, taskPath]);

  const setEnabledSafe = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      if (disabled) return;
      setEnabled(next);
    },
    [disabled]
  );

  const toggle = useCallback(() => {
    if (disabled) return;
    setEnabled((v) => !v);
  }, [disabled]);

  return {
    enabled: disabled ? false : enabled,
    setEnabled: setEnabledSafe,
    toggle,
  } as const;
}
