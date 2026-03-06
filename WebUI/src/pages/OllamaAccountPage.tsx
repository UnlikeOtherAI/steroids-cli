import { useEffect, useState } from 'react';
import { ollamaApi } from '../services/ollamaApi';
import type { OllamaConnectionStatus } from '../types';

const OLLAMA_BILLING_URL = 'https://ollama.com/settings/billing';

export function OllamaAccountPage() {
  const [account, setAccount] = useState<OllamaConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await ollamaApi.getAccount();
        setAccount(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load account');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Account</h1>
        <p className="mt-2 text-sm text-text-muted">
          View connection status for local/cloud mode and open billing settings for cloud.
        </p>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading account...
        </div>
      )}

      {!loading && account && (
        <div className="card p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-text-muted">Mode</p>
              <p className="font-semibold text-text-primary">{account.mode === 'cloud' ? 'Cloud' : 'Local'}</p>
            </div>
            <div>
              <p className="text-text-muted">Status</p>
              <p className={account.connected ? 'font-semibold text-success' : 'font-semibold text-danger'}>
                {account.connected ? 'Connected' : 'Disconnected'}
              </p>
            </div>
            <div>
              <p className="text-text-muted">Version</p>
              <p className="font-semibold text-text-primary">{account.version || 'Unknown'}</p>
            </div>
            <div>
              <p className="text-text-muted">Loaded Models</p>
              <p className="font-semibold text-text-primary">{account.loadedModels.length}</p>
            </div>
            {account.mode === 'cloud' && (
              <>
                <div>
                  <p className="text-text-muted">Tier</p>
                  <p className="font-semibold text-text-primary">{account.cloudTier || 'Unknown (no API available)'}</p>
                </div>
                <div>
                  <p className="text-text-muted">Billing</p>
                  <a className="btn-pill inline-flex mt-1" href={OLLAMA_BILLING_URL} target="_blank" rel="noreferrer">
                    Manage Billing
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
