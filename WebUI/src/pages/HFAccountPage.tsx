import { useEffect, useState } from 'react';
import type { HFAccountStatus, HFUsageDashboardResponse } from '../types';
import { huggingFaceApi } from '../services/huggingFaceApi';
import { formatTokenCount, formatUsdCost } from '../services/modelUsageFormat';

const BILLING_URL = 'https://huggingface.co/settings/billing';
const USAGE_URL = 'https://huggingface.co/settings/inference-providers/overview';

function getTierLabel(tier?: HFAccountStatus['tier']): string {
  if (tier === 'pro') return 'PRO (~$2.00/mo credits)';
  if (tier === 'enterprise') return 'Enterprise (~$2.00/seat credits)';
  return 'Free (~$0.10/mo credits)';
}

export function HFAccountPage() {
  const [account, setAccount] = useState<HFAccountStatus | null>(null);
  const [usage, setUsage] = useState<HFUsageDashboardResponse | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [accountData, usageData] = await Promise.all([
        huggingFaceApi.getAccount(),
        huggingFaceApi.getUsage(),
      ]);
      setAccount(accountData);
      setUsage(usageData);
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
                <div>
                  <p className="text-text-muted">Hub API Rate Limit</p>
                  <p className="font-semibold text-text-primary">
                    {formatRateLimit(account)}
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

      {!loading && usage && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="card p-5">
              <p className="text-xs uppercase tracking-wide text-text-muted">Today Requests</p>
              <p className="mt-2 text-2xl font-semibold text-text-primary">{usage.today.requests}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs uppercase tracking-wide text-text-muted">Today Tokens</p>
              <p className="mt-2 text-2xl font-semibold text-text-primary">{formatTokenCount(usage.today.totalTokens)}</p>
              <p className="text-xs text-text-muted mt-1">
                {formatTokenCount(usage.today.promptTokens)} in / {formatTokenCount(usage.today.completionTokens)} out
              </p>
            </div>
            <div className="card p-5">
              <p className="text-xs uppercase tracking-wide text-text-muted">Estimated Cost Today</p>
              <p className="mt-2 text-2xl font-semibold text-text-primary">{formatUsdCost(usage.today.estimatedCostUsd)}</p>
            </div>
          </div>

          <div className="card p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-text-primary">Per Model (Last 7 Days)</h2>
              <span className="text-xs text-text-muted">HF local usage log</span>
            </div>
            {usage.byModel7d.length === 0 ? (
              <p className="text-sm text-text-muted">No Hugging Face usage has been recorded yet.</p>
            ) : (
              <div className="space-y-3">
                {usage.byModel7d.map((entry) => (
                  <div key={`${entry.model}:${entry.routingPolicy}:${entry.provider ?? 'auto'}`} className="border border-border rounded-lg p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-primary truncate" title={entry.model}>{entry.model}</p>
                      <span className="badge-accent text-xs">
                        {entry.provider ? `via ${entry.provider}` : `policy ${entry.routingPolicy}`}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-text-muted">
                      {entry.requests} request(s) • {formatTokenCount(entry.totalTokens)} tokens • {formatUsdCost(entry.estimatedCostUsd)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function formatRateLimit(account: HFAccountStatus | null): string {
  const snapshot = account?.rateLimit;
  if (!snapshot) return 'Unavailable';
  if (snapshot.remaining === null || snapshot.limit === null) return 'Unavailable';

  const reset = snapshot.resetSeconds !== null ? ` (resets in ${formatReset(snapshot.resetSeconds)})` : '';
  return `${snapshot.remaining}/${snapshot.limit} remaining${reset}`;
}

function formatReset(seconds: number): string {
  if (seconds <= 0) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}
