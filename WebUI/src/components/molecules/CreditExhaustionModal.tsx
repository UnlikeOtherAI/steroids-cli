import type { CreditAlert } from '../../services/api';

interface CreditExhaustionModalProps {
  alert: CreditAlert;
  onDismiss: () => void;
  onChangeModel: () => void;
  onRetry: () => void;
}

export function CreditExhaustionModal({
  alert,
  onDismiss,
  onChangeModel,
  onRetry,
}: CreditExhaustionModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onDismiss}
      />

      {/* Modal card */}
      <div className="relative bg-bg-shell rounded-2xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-warning-soft flex items-center justify-center mb-4">
            <i className="fa-solid fa-coins text-2xl text-warning" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">
            Out of Credits
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            The <span className="font-medium">{alert.provider}</span> provider
            (model: <span className="font-mono text-xs">{alert.model}</span>)
            used for <span className="font-medium">{alert.role}</span> has run
            out of credits. The runner is paused until this is resolved.
          </p>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 space-y-3">
          <button
            onClick={onChangeModel}
            className="w-full px-4 py-3 bg-accent text-white rounded-xl font-medium hover:bg-accent-hover transition-colors"
          >
            <i className="fa-solid fa-gear mr-2" />
            Change AI Model
          </button>
          <button
            onClick={onRetry}
            className="w-full px-4 py-2.5 bg-bg-surface text-text-primary rounded-xl font-medium hover:bg-bg-surface2 transition-colors text-sm"
          >
            <i className="fa-solid fa-rotate-right mr-2" />
            Retry
          </button>
          <button
            onClick={onDismiss}
            className="w-full px-4 py-2 text-text-secondary rounded-xl hover:bg-bg-surface2 transition-colors text-sm"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
