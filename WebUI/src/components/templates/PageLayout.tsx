import React from 'react';
import { useNavigate } from 'react-router-dom';

export interface PageLayoutProps {
  /** Page title */
  title: string;
  /** Optional subtitle shown below title */
  subtitle?: string;
  /** Optional muted text shown after title (e.g., "in ProjectName") */
  titleSuffix?: string;
  /** Back navigation - if provided, shows back button to the left of title */
  backTo?: string | (() => void);
  /** Label for back button (default: "Back") */
  backLabel?: string;
  /** Actions shown on the right side of header */
  actions?: React.ReactNode;
  /** Page content */
  children: React.ReactNode;
  /** Max width class (default: max-w-6xl) */
  maxWidth?: 'max-w-4xl' | 'max-w-5xl' | 'max-w-6xl' | 'max-w-7xl';
  /** Loading state - shows spinner instead of children */
  loading?: boolean;
  /** Loading message */
  loadingMessage?: string;
  /** Error message - shows error alert */
  error?: string | null;
}

export const PageLayout: React.FC<PageLayoutProps> = ({
  title,
  subtitle,
  titleSuffix,
  backTo,
  backLabel = 'Back',
  actions,
  children,
  maxWidth = 'max-w-6xl',
  loading,
  loadingMessage = 'Loading...',
  error,
}) => {
  const navigate = useNavigate();

  const handleBack = () => {
    if (typeof backTo === 'function') {
      backTo();
    } else if (backTo) {
      navigate(backTo);
    } else {
      navigate(-1);
    }
  };

  return (
    <div className={`p-8 ${maxWidth} mx-auto`}>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {backTo !== undefined && (
              <button
                onClick={handleBack}
                className="p-2 -ml-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors"
                title={backLabel}
              >
                <i className="fa-solid fa-arrow-left text-lg"></i>
              </button>
            )}
            <div>
              <h1 className="text-3xl font-bold text-text-primary">
                {title}
                {titleSuffix && (
                  <span className="text-text-muted font-normal text-xl ml-2">
                    {titleSuffix}
                  </span>
                )}
              </h1>
              {subtitle && (
                <p className="text-text-muted mt-1">{subtitle}</p>
              )}
            </div>
          </div>

          {actions && (
            <div className="flex items-center gap-3">
              {actions}
            </div>
          )}
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
          <i className="fa-solid fa-exclamation-triangle text-red-500"></i>
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="text-center py-12 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin text-3xl mb-4"></i>
          <p>{loadingMessage}</p>
        </div>
      ) : (
        children
      )}
    </div>
  );
};

export default PageLayout;
