import React, { useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from './ui/select';
import {
  Layers,
  Focus,
  Zap,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Types
export type ReviewAgent = 'codex' | 'claude-code';
export type ReviewDepth = 'comprehensive' | 'focused' | 'quick';

export interface ReviewConfiguration {
  agent: ReviewAgent;
  model: string;
  depth: ReviewDepth;
}

interface CodeReviewConfigModalProps {
  open: boolean;
  onClose: () => void;
  onStartReview?: (config: ReviewConfiguration) => void;
  fileCount?: number;
  totalAdditions?: number;
  totalDeletions?: number;
}

// Agent logos/icons
const CodexLogo = ({ className }: { className?: string }) => (
  <div className={cn('flex items-center justify-center rounded bg-emerald-100 dark:bg-emerald-900/30', className)}>
    <Terminal className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
  </div>
);

const ClaudeLogo = ({ className }: { className?: string }) => (
  <div className={cn('flex items-center justify-center rounded bg-orange-100 dark:bg-orange-900/30', className)}>
    <Sparkles className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
  </div>
);

// Combined agent + model options
const AGENT_MODEL_OPTIONS = [
  {
    group: 'Codex',
    agent: 'codex' as ReviewAgent,
    Logo: CodexLogo,
    options: [
      { value: 'codex:gpt-5.2', label: 'GPT 5.2', recommended: true, description: 'Latest & most capable' },
      { value: 'codex:5.2-codex', label: '5.2 Codex', description: 'Optimized for code' },
      { value: 'codex:5.1-codex-max', label: '5.1 Codex Max', description: 'Extended context' },
    ],
  },
  {
    group: 'Claude Code',
    agent: 'claude-code' as ReviewAgent,
    Logo: ClaudeLogo,
    options: [
      { value: 'claude-code:opus-4.5', label: 'Opus 4.5', recommended: true, description: 'Most thorough' },
      { value: 'claude-code:sonnet-4.5', label: 'Sonnet 4.5', description: 'Fast & capable' },
    ],
  },
];

// Review depth configurations
const REVIEW_DEPTHS: Array<{
  id: ReviewDepth;
  title: string;
  agentCount: number;
  description: string;
  details: string[];
  icon: React.ReactNode;
}> = [
  {
    id: 'comprehensive',
    title: 'Comprehensive',
    agentCount: 5,
    description: 'Deep multi-agent analysis covering architecture, logic, performance, security, and style independently',
    details: [
      'Architecture: System design & patterns',
      'Logic: Correctness & edge cases',
      'Performance: Bottlenecks & optimization',
      'Security: Vulnerabilities & auth',
      'Style: Conventions & documentation',
    ],
    icon: <Layers className="h-5 w-5" />,
  },
  {
    id: 'focused',
    title: 'Focused',
    agentCount: 3,
    description: 'Balanced coverage with combined analysis for structure, safety, and quality',
    details: [
      'Structure: Architecture & logic',
      'Safety: Security & performance',
      'Quality: Style & documentation',
    ],
    icon: <Focus className="h-5 w-5" />,
  },
  {
    id: 'quick',
    title: 'Quick',
    agentCount: 1,
    description: 'Single unified pass for rapid feedback on small changes',
    details: [
      'Holistic review covering all aspects',
      'Best for small changes & iterations',
    ],
    icon: <Zap className="h-5 w-5" />,
  },
];

// Helper to get current agent info from value
const getAgentInfo = (value: string) => {
  const agent = value.split(':')[0] as ReviewAgent;
  const model = value.split(':')[1];
  const group = AGENT_MODEL_OPTIONS.find((g) => g.agent === agent);
  const option = group?.options.find((o) => o.value === value);
  return { agent, model, group, option };
};

const CodeReviewConfigModal: React.FC<CodeReviewConfigModalProps> = ({
  open,
  onClose,
  onStartReview,
  fileCount = 0,
  totalAdditions = 0,
  totalDeletions = 0,
}) => {
  // Combined agent+model state
  const [agentModel, setAgentModel] = useState<string>('codex:gpt-5.2');
  const [depth, setDepth] = useState<ReviewDepth>('focused');

  // Derive agent and model from combined value
  const { agent, model, group: currentGroup, option: currentOption } = getAgentInfo(agentModel);
  const CurrentLogo = currentGroup?.Logo;

  // Handle starting the review
  const handleStartReview = useCallback(() => {
    const config: ReviewConfiguration = {
      agent,
      model,
      depth,
    };
    onStartReview?.(config);
    onClose();
  }, [agent, model, depth, onStartReview, onClose]);

  // Handle depth selection with keyboard navigation
  const handleDepthKeyDown = (e: React.KeyboardEvent, currentId: ReviewDepth) => {
    const depths = REVIEW_DEPTHS.map((d) => d.id);
    const currentIndex = depths.indexOf(currentId);

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = (currentIndex + 1) % depths.length;
      setDepth(depths[nextIndex]);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = (currentIndex - 1 + depths.length) % depths.length;
      setDepth(depths[prevIndex]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl overflow-hidden rounded-xl border-gray-200 bg-white p-0 dark:border-gray-700 dark:bg-gray-800">
        {/* Header */}
        <DialogHeader className="border-b border-gray-200 px-6 py-5 dark:border-gray-700">
          <DialogTitle className="flex items-center gap-2.5 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Sparkles className="h-5 w-5 text-gray-500 dark:text-gray-400" />
            AI Code Review
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Review{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">{fileCount} files</span>
            <span className="mx-2 text-gray-400">•</span>
            <span className="font-medium text-green-600 dark:text-green-400">+{totalAdditions}</span>
            <span className="mx-1.5 text-gray-400">/</span>
            <span className="font-medium text-red-600 dark:text-red-400">-{totalDeletions}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-6 py-5">
          {/* Agent + Model Selection with Logo */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Agent & Model
            </Label>
            <Select value={agentModel} onValueChange={setAgentModel}>
              <SelectTrigger className="h-11 w-full border-gray-200 text-sm dark:border-gray-700">
                <div className="flex items-center gap-3">
                  {CurrentLogo && <CurrentLogo className="h-6 w-6 p-1" />}
                  <span className="font-medium">{currentGroup?.group}</span>
                  <span className="text-gray-400">•</span>
                  <span>{currentOption?.label}</span>
                </div>
              </SelectTrigger>
              <SelectContent className="z-[120] min-w-[320px]">
                {AGENT_MODEL_OPTIONS.map((group, groupIndex) => {
                  const GroupLogo = group.Logo;
                  return (
                    <React.Fragment key={group.group}>
                      {groupIndex > 0 && <SelectSeparator className="my-2" />}
                      <SelectGroup>
                        <SelectLabel className="flex items-center gap-2.5 px-2 py-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                          <GroupLogo className="h-6 w-6 p-1" />
                          {group.group}
                        </SelectLabel>
                        {group.options.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            className="py-2.5 pl-10"
                          >
                            <div className="flex flex-col gap-0.5">
                              <span className="flex items-center gap-2">
                                <span className="font-medium">{option.label}</span>
                                {option.recommended && (
                                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                                    Recommended
                                  </span>
                                )}
                              </span>
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {option.description}
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </React.Fragment>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Review Depth Selection - Horizontal */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Review Depth
            </Label>
            <div role="radiogroup" aria-label="Review depth" className="grid grid-cols-3 gap-3">
              {REVIEW_DEPTHS.map((depthOption) => {
                const isSelected = depth === depthOption.id;

                return (
                  <button
                    key={depthOption.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => setDepth(depthOption.id)}
                    onKeyDown={(e) => handleDepthKeyDown(e, depthOption.id)}
                    className={cn(
                      'group relative flex flex-col rounded-xl border p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2',
                      isSelected
                        ? 'border-gray-400 bg-gray-50 dark:border-gray-500 dark:bg-gray-700/50'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50/50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-gray-700/30'
                    )}
                  >
                    {/* Radio indicator */}
                    <div className="absolute right-3 top-3">
                      <div
                        className={cn(
                          'flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors',
                          isSelected
                            ? 'border-gray-900 dark:border-gray-100'
                            : 'border-gray-300 dark:border-gray-600'
                        )}
                      >
                        {isSelected && (
                          <div className="h-2.5 w-2.5 rounded-full bg-gray-900 dark:bg-gray-100" />
                        )}
                      </div>
                    </div>

                    {/* Icon and title */}
                    <div className="flex items-center gap-2.5">
                      <span className={cn(
                        'text-gray-500 dark:text-gray-400',
                        isSelected && 'text-gray-700 dark:text-gray-200'
                      )}>
                        {depthOption.icon}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {depthOption.title}
                      </span>
                    </div>

                    {/* Agent count badge */}
                    <div className="mt-2">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                        isSelected
                          ? 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                      )}>
                        {depthOption.agentCount} agent{depthOption.agentCount > 1 ? 's' : ''}
                      </span>
                    </div>

                    {/* Description */}
                    <p className="mt-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                      {depthOption.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="flex w-full items-center justify-end gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="h-9 border-gray-200 px-4 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleStartReview}
              className="h-9 gap-2 bg-gray-900 px-5 text-sm text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
            >
              <Sparkles className="h-4 w-4" />
              Start Review
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CodeReviewConfigModal;
