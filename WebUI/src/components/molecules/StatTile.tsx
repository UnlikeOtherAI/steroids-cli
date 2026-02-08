import React from 'react';

interface StatTileProps {
  label: string;
  value: number | string;
  description?: string;
  variant?: 'default' | 'info' | 'warning' | 'success' | 'danger';
  onClick?: () => void;
}

export const StatTile: React.FC<StatTileProps> = ({ label, value, description, variant = 'default', onClick }) => {
  const valueColors = {
    default: 'text-text-primary',
    info: 'text-info',
    warning: 'text-warning',
    success: 'text-success',
    danger: 'text-danger',
  };

  const baseClasses = 'stat-tile';
  const clickableClasses = onClick ? 'cursor-pointer hover:bg-bg-surface2 transition-colors' : '';

  return (
    <div className={`${baseClasses} ${clickableClasses}`} onClick={onClick}>
      <div className="text-text-secondary text-sm mb-2">{label}</div>
      <div className={`text-4xl font-bold ${valueColors[variant]}`}>{value}</div>
      {description && <div className="text-xs text-text-muted mt-1">{description}</div>}
    </div>
  );
};
