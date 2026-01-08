import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import IntegrationRow from './IntegrationRow';
import { Input } from './ui/input';
import claudeLogo from '../../assets/images/claude.png';

const ClaudeGlmSettingsCard: React.FC = () => {
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.claudeGlmCheck();
      setConnected(status?.connected ?? false);
      setError(null);
    } catch (err) {
      console.error('Failed to check Claude GLM status:', err);
      setError('Unable to verify GLM API key.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleConnect = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.claudeGlmSaveKey(trimmed);
      if (result?.success) {
        setConnected(true);
        setInput('');
      } else {
        setError(result?.error || 'Could not save API key.');
      }
    } catch (err) {
      console.error('Failed to save Claude GLM key:', err);
      setError('Could not save API key.');
    } finally {
      setLoading(false);
    }
  }, [input]);

  const handleDisconnect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.claudeGlmClearKey();
      if (result?.success) {
        setConnected(false);
        setInput('');
      } else {
        setError(result?.error || 'Could not remove API key.');
      }
    } catch (err) {
      console.error('Failed to clear Claude GLM key:', err);
      setError('Could not remove API key.');
    } finally {
      setLoading(false);
    }
  }, []);

  const status = useMemo(() => {
    if (checking || loading) return 'loading' as const;
    if (connected) return 'connected' as const;
    if (error) return 'error' as const;
    return 'disconnected' as const;
  }, [checking, loading, connected, error]);

  const middle = useMemo(() => {
    if (connected) {
      return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Connected via Z.AI API key.
        </span>
      );
    }

    return (
      <div className="flex items-center gap-2" aria-live="polite">
        <Input
          type="password"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={loading || checking}
          placeholder="Enter Z.AI API key"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void handleConnect();
            }
          }}
          aria-label="Z.AI API key"
          className="h-8 w-full max-w-[240px]"
        />
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : null}
      </div>
    );
  }, [connected, checking, handleConnect, input, loading]);

  const canConnect = !!input.trim() && !loading && !checking;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Use your Z.AI API key to run Claude Code against GLM models. The key is stored securely on
        this device.
      </p>
      <IntegrationRow
        logoSrc={claudeLogo}
        name="Claude Code (GLM)"
        status={status}
        middle={middle}
        showStatusPill={false}
        onConnect={() => void handleConnect()}
        connectDisabled={!canConnect}
        connectContent={
          loading ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Saving…
            </>
          ) : (
            'Save key'
          )
        }
        onDisconnect={connected ? () => void handleDisconnect() : undefined}
      />
      {error && !connected ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default ClaudeGlmSettingsCard;
