import { useEffect, useState } from 'react';
import type { HFAccountStatus } from '../types';
import { huggingFaceApi } from '../services/huggingFaceApi';

const BILLING_URL = 'https://huggingface.co/settings/billing';
const USAGE_URL = 'https://huggingface.co/settings/inference-providers/overview';

function getTierLabel(tier?: HFAccountStatus['tier']): string {
  if (tier === 'pro') return 'PRO (~$2.00/mo credits)';
  if (tier === 'enterprise') return 'Enterprise (~$2.00/seat credits)';
  return 'Free (~$0.10/mo credits)';
}

export function HFAccountPage() {
  const [account, setAccount] = useState<HFAccountStatus | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await huggingFaceApi.getAccount();
      setAccount(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleConnect = async () => {
    if (!token.trim()) {
      setError('Paste a Hugging Face token first.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await huggingFaceApi.connect(token.trim());
      setToken('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect account');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      await huggingFaceApi.disconnect();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect account');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Hugging Face Account</h1>
        <p className="mt-2 text-sm text-text-muted">
          Connect your HF token to access curated models and router-backed inference.
        </p>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading account...
        </div>
      )}

      {!loading && (
        <div className="card p-6 space-y-4">
          {account?.connected && account.valid !== false ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-text-muted">Username</p>
                  <p className="font-semibold text-text-primary">{account.name ?? 'Unknown'}</p>
                </div>
                <div>
                  <p className="text-text-muted">Tier</p>
                  <p className="font-semibold text-text-primary">{getTierLabel(account.tier)}</p>
                </div>
                <div>
                  <p className="text-text-muted">Payment</p>
                  <p className="font-semibold text-text-primary">{account.canPay ? 'Configured' : 'Not configured'}</p>
                </div>
                <div>
                  <p className="text-text-muted">Token Scope</p>
                  <p className={account.hasBroadScopes ? 'font-semibold text-warning' : 'font-semibold text-success'}>
                    {account.hasBroadScopes ? 'Includes write/admin scopes' : 'Read + inference scoped'}
                  </p>
                </div>
              </div>
              {account.hasBroadScopes && (
                <div className="badge-warning inline-flex">
                  This token has broader-than-needed permissions. Use fine-grained read + inference scopes when possible.
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="btn-accent"
                  onClick={handleDisconnect}
                  disabled={saving}
                >
                  Disconnect
                </button>
                <a className="btn-pill" href={BILLING_URL} target="_blank" rel="noreferrer">Manage Billing</a>
                <a className="btn-pill" href={USAGE_URL} target="_blank" rel="noreferrer">Usage Dashboard</a>
              </div>
            </>
          ) : (
            <>
              <label className="block">
                <span className="text-sm text-text-muted">HF API Token</span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="hf_..."
                  className="mt-2 w-full bg-bg-elevated rounded-full px-5 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                />
              </label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="btn-accent"
                  onClick={handleConnect}
                  disabled={saving}
                >
                  Connect Account
                </button>
                {account?.valid === false && <span className="text-sm text-danger">{account.error ?? 'Token validation failed'}</span>}
              </div>
            </>
          )}

          {error && <div className="text-sm text-danger">{error}</div>}
        </div>
      )}
    </div>
  );
}
