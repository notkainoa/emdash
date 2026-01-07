import { useState } from 'react';
import { useToast } from './use-toast';
import { ToastAction } from '../components/ui/toast';
import { ArrowUpRight } from 'lucide-react';
import githubLogo from '../../assets/images/github.png';
type CreatePROptions = {
  taskPath: string;
  commitMessage?: string;
  createBranchIfOnDefault?: boolean;
  branchPrefix?: string;
  prOptions?: {
    title?: string;
    body?: string;
    base?: string;
    head?: string;
    draft?: boolean;
    web?: boolean;
    fill?: boolean;
  };
  onSuccess?: () => Promise<void> | void;
};

const formatErrorMessage = (value: unknown, fallback: string) => {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function useCreatePR() {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);

  const createPR = async (opts: CreatePROptions) => {
    const {
      taskPath,
      commitMessage = 'chore: apply task changes',
      createBranchIfOnDefault = true,
      branchPrefix = 'orch',
      prOptions,
      onSuccess,
    } = opts;

    setIsCreating(true);
    try {
      // Guard: ensure Electron bridge methods exist (prevents hard crashes in plain web builds)
      const api: any = (window as any).electronAPI;
      if (!api?.gitCommitAndPush || !api?.createPullRequest) {
        const msg = 'PR creation is only available in the Electron app. Start via "npm run d".';
        toast({ title: 'Create PR Unavailable', description: msg, variant: 'destructive' });
        return { success: false, error: 'Electron bridge unavailable' } as any;
      }

      let accessInfo: any = null;
      let compareUrl: string | null = null;

      if (!prOptions?.web && typeof api.checkPrAccess === 'function') {
        try {
          accessInfo = await api.checkPrAccess({
            taskPath,
            base: prOptions?.base,
            head: prOptions?.head,
          });
          compareUrl = accessInfo?.compareUrl ?? null;
          const accessDenied =
            accessInfo?.success &&
            (accessInfo?.canWrite === false ||
              accessInfo?.code === 'REPO_ACCESS_DENIED' ||
              accessInfo?.code === 'ORG_AUTH_APP_RESTRICTED');

          if (accessDenied) {
            const description =
              accessInfo?.code === 'ORG_AUTH_APP_RESTRICTED'
                ? 'Your organization restricts GitHub CLI access. Create the PR in your browser instead.'
                : "You don't have write access to this repo. Create the PR in your browser instead.";
            toast({
              title: (
                <span className="inline-flex items-center gap-2">
                  <img src={githubLogo} alt="GitHub" className="h-5 w-5 rounded-sm object-contain" />
                  Failed to Create PR
                </span>
              ),
              description,
              variant: 'destructive',
              action: compareUrl ? (
                <ToastAction
                  altText="Open compare"
                  onClick={() => {
                    if (compareUrl && window.electronAPI?.openExternal) {
                      window.electronAPI.openExternal(compareUrl);
                    }
                  }}
                >
                  <span className="inline-flex items-center gap-1">
                    Open compare
                    <ArrowUpRight className="h-3 w-3" />
                  </span>
                </ToastAction>
              ) : undefined,
            });
            return { success: false, error: accessInfo?.code || 'access_denied' } as any;
          }
        } catch {
          // Non-fatal: fall through to existing PR flow
        }
      }

      // Auto-generate PR title and description if not provided
      let finalPrOptions = { ...(prOptions || {}) };

      if (!finalPrOptions.title || !finalPrOptions.body) {
        try {
          // Get default branch for comparison
          let defaultBranch = accessInfo?.defaultBranch || 'main';
          if (!accessInfo?.defaultBranch) {
            try {
              const branchStatus = await api.getBranchStatus?.({ taskPath });
              if (branchStatus?.success && branchStatus.defaultBranch) {
                defaultBranch = branchStatus.defaultBranch;
              }
            } catch {}
          }

          // Generate PR content
          if (api.generatePrContent) {
            const generated = await api.generatePrContent({
              taskPath,
              base: finalPrOptions.base || defaultBranch,
            });

            if (generated?.success && generated.title) {
              finalPrOptions.title = finalPrOptions.title || generated.title;
              finalPrOptions.body = finalPrOptions.body || generated.description || '';
            }
          }
        } catch (error) {
          // Non-fatal: continue with fallback title
          // Silently fail - fallback title will be used
        }
      }

      // Fallback to inferred title if still not set
      if (!finalPrOptions.title) {
        finalPrOptions.title = taskPath.split(/[/\\]/).filter(Boolean).pop() || 'Task';
      }

      const commitRes = await api.gitCommitAndPush({
        taskPath,
        commitMessage,
        createBranchIfOnDefault,
        branchPrefix,
      });

      if (!commitRes?.success) {
        const commitError = formatErrorMessage(commitRes?.error, 'Unable to push changes.');
        toast({
          title: 'Commit/Push Failed',
          description: commitError,
          variant: 'destructive',
        });
        return { success: false, error: commitError } as any;
      }

      const res = await api.createPullRequest({
        taskPath,
        fill: true,
        ...finalPrOptions,
      });

      if (res?.success) {
        void (async () => {
          const { captureTelemetry } = await import('../lib/telemetryClient');
          captureTelemetry('pr_created');
        })();
        const prUrl = res?.url;
        toast({
          title: 'Pull request created successfully!',
          description: prUrl ? undefined : 'PR created but URL not available.',
          action: prUrl ? (
            <ToastAction
              altText="View PR"
              onClick={() => {
                void (async () => {
                  const { captureTelemetry } = await import('../lib/telemetryClient');
                  captureTelemetry('pr_viewed');
                })();
                if (prUrl && window.electronAPI?.openExternal) {
                  window.electronAPI.openExternal(prUrl);
                }
              }}
            >
              <span className="inline-flex items-center gap-1">
                View PR
                <ArrowUpRight className="h-3 w-3" />
              </span>
            </ToastAction>
          ) : undefined,
        });
        try {
          await onSuccess?.();
        } catch {
          // ignore onSuccess errors
        }
      } else {
        void (async () => {
          const { captureTelemetry } = await import('../lib/telemetryClient');
          captureTelemetry('pr_creation_failed', { error_type: res?.error || 'unknown' });
        })();
        const isAccessDenied =
          typeof res?.code === 'string' && res.code === 'REPO_ACCESS_DENIED';
        const isOrgRestricted =
          typeof res?.code === 'string' && res.code === 'ORG_AUTH_APP_RESTRICTED';
        const accessBlocked = isAccessDenied || isOrgRestricted;
        const details =
          !accessBlocked && res?.output && typeof res.output === 'string'
            ? `\n\nDetails:\n${res.output}`
            : '';
        const errorText = formatErrorMessage(res?.error, 'Unknown error');
        const accessDescription = isOrgRestricted
          ? 'Your organization restricts GitHub CLI access. Create the PR in your browser instead.'
          : "You don't have write access to this repo. Create the PR in your browser instead.";
        const fallbackAction = isOrgRestricted ? (
          <ToastAction
            altText="Open in browser"
            onClick={() => {
              void (async () => {
                const { captureTelemetry } = await import('../lib/telemetryClient');
                captureTelemetry('pr_creation_retry_browser');
              })();
              // Retry using web flow
              void createPR({
                taskPath,
                commitMessage,
                createBranchIfOnDefault,
                branchPrefix,
                prOptions: { ...(prOptions || {}), web: true, fill: true },
                onSuccess,
              });
            }}
          >
            <span className="inline-flex items-center gap-1">
              Open in browser
              <ArrowUpRight className="h-3 w-3" />
            </span>
          </ToastAction>
        ) : undefined;
        const accessAction = compareUrl ? (
          <ToastAction
            altText="Open compare"
            onClick={() => {
              if (compareUrl && window.electronAPI?.openExternal) {
                window.electronAPI.openExternal(compareUrl);
              }
            }}
          >
            <span className="inline-flex items-center gap-1">
              Open compare
              <ArrowUpRight className="h-3 w-3" />
            </span>
          </ToastAction>
        ) : undefined;

        toast({
          title: (
            <span className="inline-flex items-center gap-2">
              <img src={githubLogo} alt="GitHub" className="h-5 w-5 rounded-sm object-contain" />
              Failed to Create PR
            </span>
          ),
          description: accessBlocked ? accessDescription : errorText + details,
          variant: 'destructive',
          action: accessBlocked ? accessAction || fallbackAction : undefined,
        });
      }

      return res as any;
    } catch (err: any) {
      const message = err?.message || String(err) || 'Unknown error';
      toast({
        title: (
          <span className="inline-flex items-center gap-2">
            <img src={githubLogo} alt="GitHub" className="h-5 w-5 rounded-sm object-contain" />
            Failed to Create PR
          </span>
        ),
        description: message,
        variant: 'destructive',
      });
      return { success: false, error: message } as any;
    } finally {
      setIsCreating(false);
    }
  };

  return { isCreating, createPR };
}
