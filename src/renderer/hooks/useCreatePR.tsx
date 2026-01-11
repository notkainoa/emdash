import { useState } from 'react';
import { useToast } from './use-toast';
import { ToastAction } from '../components/ui/toast';
import { ArrowUpRight } from 'lucide-react';
import githubLogo from '../../assets/images/github.png';
import { ForkConfirmationModal } from '../components/ForkConfirmationModal';

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

type CreatePRResult = {
  success: boolean;
  url?: string;
  error?: string;
  code?: string;
  output?: string;
};

type ForkFlowState = {
  needsFork: boolean;
  taskPath: string;
  repoName?: string;
  createBranchIfOnDefault?: boolean;
  branchPrefix?: string;
  commitMessage?: string;
  prOptions?: CreatePROptions['prOptions'];
  onSuccess?: CreatePROptions['onSuccess'];
  hasPendingChanges: boolean;
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

const createCompareAction = (compareUrl: string | null) => {
  if (!compareUrl) return undefined;
  return (
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
  );
};

// Helper to build fork compare URL: fork:branch -> upstream:base
const buildForkCompareUrl = (
  forkUrl: string,
  upstreamUrl: string,
  branch: string,
  baseBranch: string
): string => {
  try {
    // Parse URLs to get owner/repo
    const forkMatch = forkUrl.match(/github\.com\/([^/]+)\/([^/?]+)/);
    const upstreamMatch = upstreamUrl.match(/github\.com\/([^/]+)\/([^/?]+)/);

    if (forkMatch && upstreamMatch) {
      const forkOwner = forkMatch[1];
      const forkRepo = forkMatch[2];
      return `https://github.com/${forkOwner}/${forkRepo}/compare/${baseBranch}...${upstreamMatch[1]}:${branch}?expand=1`;
    }
  } catch {}
  return forkUrl;
};

export function useCreatePR() {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [forkFlow, setForkFlow] = useState<ForkFlowState | null>(null);

  const createPR = async (opts: CreatePROptions): Promise<CreatePRResult> => {
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
      // Guard: ensure Electron bridge methods exist
      const api = window.electronAPI;
      if (!api?.gitCommitAndPush || !api?.createPullRequest || !api?.checkPrAccess) {
        const msg = 'PR creation is only available in the Electron app.';
        toast({ title: 'Create PR Unavailable', description: msg, variant: 'destructive' });
        return { success: false, error: 'Electron bridge unavailable' };
      }

      // === STEP 1: Check access first ===
      const accessInfo = await api.checkPrAccess({
        taskPath,
        base: prOptions?.base,
        head: prOptions?.head,
      });

      if (!accessInfo?.success) {
        throw new Error(accessInfo?.error || 'Failed to check repository access');
      }

      const canWrite = accessInfo?.canWrite === true;

      // === STEP 2: If no write access, check for fork ===
      if (!canWrite) {
        const forkInfo = await api.checkFork({ taskPath });

        if (!forkInfo?.success) {
          throw new Error(forkInfo?.error || 'Failed to check for fork');
        }

        // If fork exists, use it
        if (forkInfo.hasFork) {
          return await handleForkFlow({
            taskPath,
            forkUrl: forkInfo.forkUrl!,
            parentUrl: forkInfo.parentUrl,
            branch: prOptions?.head || accessInfo.currentBranch || 'HEAD',
            baseBranch: prOptions?.base || accessInfo.defaultBranch || 'main',
            commitMessage,
            createBranchIfOnDefault,
            branchPrefix,
            prOptions,
            onSuccess,
          });
        }

        // If no fork exists, show confirmation modal
        setForkFlow({
          needsFork: true,
          taskPath,
          repoName: forkInfo.suggestedForkName || 'this repository',
          createBranchIfOnDefault,
          branchPrefix,
          commitMessage,
          prOptions,
          onSuccess,
          hasPendingChanges: false,
        });
        setIsCreating(false);
        return { success: false, error: 'Fork required', code: 'FORK_REQUIRED' };
      }

      // === STEP 3: Normal flow (has write access) ===
      return await handleNormalFlow({
        taskPath,
        commitMessage,
        createBranchIfOnDefault,
        branchPrefix,
        prOptions,
        onSuccess,
        defaultBranch: accessInfo.defaultBranch || 'main',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err) || 'Unknown error';
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
      return { success: false, error: message };
    } finally {
      if (!forkFlow) {
        setIsCreating(false);
      }
    }
  };

  // Handle normal flow (user has write access)
  const handleNormalFlow = async (args: {
    taskPath: string;
    commitMessage: string;
    createBranchIfOnDefault: boolean;
    branchPrefix: string;
    prOptions?: CreatePROptions['prOptions'];
    onSuccess?: () => Promise<void> | void;
    defaultBranch: string;
  }): Promise<CreatePRResult> => {
    const { taskPath, commitMessage, createBranchIfOnDefault, branchPrefix, prOptions, onSuccess, defaultBranch } =
      args;

    const api = window.electronAPI;
    if (!api) return { success: false, error: 'API unavailable' };

    // Auto-generate PR content if needed
    let finalPrOptions = { ...(prOptions || {}) };
    if (!finalPrOptions.title || !finalPrOptions.body) {
      try {
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
      } catch {}
    }

    if (!finalPrOptions.title) {
      finalPrOptions.title = taskPath.split(/[/\\]/).filter(Boolean).pop() || 'Task';
    }

    // Commit and push
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
      return { success: false, error: commitError };
    }

    // Create PR
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
      } catch {}
    } else {
      void (async () => {
        const { captureTelemetry } = await import('../lib/telemetryClient');
        captureTelemetry('pr_creation_failed', { error_type: res?.error || 'unknown' });
      })();
      toast({
        title: (
          <span className="inline-flex items-center gap-2">
            <img src={githubLogo} alt="GitHub" className="h-5 w-5 rounded-sm object-contain" />
            Failed to Create PR
          </span>
        ),
        description: res?.error || 'Unknown error',
        variant: 'destructive',
      });
    }

    return res;
  };

  // Handle fork flow (user doesn't have write access)
  const handleForkFlow = async (args: {
    taskPath: string;
    forkUrl: string;
    parentUrl?: string;
    branch: string;
    baseBranch: string;
    commitMessage: string;
    createBranchIfOnDefault: boolean;
    branchPrefix: string;
    prOptions?: CreatePROptions['prOptions'];
    onSuccess?: () => Promise<void> | void;
  }): Promise<CreatePRResult> => {
    const {
      taskPath,
      forkUrl,
      parentUrl,
      branch,
      baseBranch,
      commitMessage,
      createBranchIfOnDefault,
      branchPrefix,
      prOptions,
      onSuccess,
    } = args;

    const api = window.electronAPI;
    if (!api) return { success: false, error: 'API unavailable' };

    // Stage and commit changes
    const commitRes = await api.gitCommitAndPush({
      taskPath,
      commitMessage,
      createBranchIfOnDefault: false, // Don't create branch, just commit locally
      branchPrefix,
    });

    if (!commitRes?.success && typeof commitRes?.error !== 'string') {
      const commitError = formatErrorMessage(commitRes?.error, 'Unable to commit changes.');
      toast({
        title: 'Commit Failed',
        description: commitError,
        variant: 'destructive',
      });
      return { success: false, error: commitError };
    }

    // Push to fork
    const pushRes = await api.pushToFork({
      taskPath,
      forkUrl,
      branch,
      force: false,
    });

    if (!pushRes?.success) {
      const pushError = formatErrorMessage(pushRes?.error, 'Unable to push to fork.');
      toast({
        title: 'Push to Fork Failed',
        description: pushError,
        variant: 'destructive',
      });
      return { success: false, error: pushError };
    }

    // Show compare link
    const compareUrl = parentUrl
      ? buildForkCompareUrl(forkUrl, parentUrl, branch, baseBranch)
      : forkUrl;

    void (async () => {
      const { captureTelemetry } = await import('../lib/telemetryClient');
      captureTelemetry('fork_created', { has_fork: true });
    })();

    toast({
      title: (
        <span className="inline-flex items-center gap-2">
          <img src={githubLogo} alt="GitHub" className="h-5 w-5 rounded-sm object-contain" />
          Changes Pushed to Fork
        </span>
      ),
      description: "Your changes have been pushed to your fork. Open the compare page to create a pull request.",
      action: createCompareAction(compareUrl),
    });

    try {
      await onSuccess?.();
    } catch {}

    return { success: true, code: 'FORK_SUCCESS' };
  };

  // Handle fork creation from modal
  const handleForkConfirm = async () => {
    if (!forkFlow) return;

    const api = window.electronAPI;
    if (!api) return;

    try {
      // Create fork
      const forkResult = await api.createFork({ taskPath: forkFlow.taskPath });

      if (!forkResult?.success) {
        throw new Error(forkResult?.error || 'Failed to create fork');
      }

      setForkFlow(null);

      // Continue with fork flow using the new fork
      const accessInfo = await api.checkPrAccess({
        taskPath: forkFlow.taskPath,
        base: forkFlow.prOptions?.base,
        head: forkFlow.prOptions?.head,
      });
      if (accessInfo?.success) {
        await handleForkFlow({
          taskPath: forkFlow.taskPath,
          forkUrl: forkResult.forkUrl!,
          parentUrl: accessInfo.compareUrl || undefined,
          branch: forkFlow.prOptions?.head || accessInfo.currentBranch || 'HEAD',
          baseBranch: forkFlow.prOptions?.base || accessInfo.defaultBranch || 'main',
          commitMessage: forkFlow.commitMessage || 'chore: apply task changes',
          createBranchIfOnDefault: forkFlow.createBranchIfOnDefault ?? true,
          branchPrefix: forkFlow.branchPrefix || 'orch',
          prOptions: forkFlow.prOptions,
          onSuccess: forkFlow.onSuccess,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create fork';
      toast({
        title: 'Fork Creation Failed',
        description: message,
        variant: 'destructive',
      });
      setIsCreating(false);
    }
  };

  const handleForkCancel = () => {
    setForkFlow(null);
    setIsCreating(false);
  };

  return {
    isCreating,
    createPR,
    forkModal: (
      <ForkConfirmationModal
        isOpen={forkFlow?.needsFork ?? false}
        onClose={handleForkCancel}
        onConfirm={handleForkConfirm}
        repoName={forkFlow?.repoName}
      />
    ),
  };
}
