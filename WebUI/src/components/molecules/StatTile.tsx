import React from 'react';

interface StatTileProps {
  label: string;
  value: number | string;
  description?: string;
  variant?: 'default' | 'info' | 'warning' | 'success' | 'danger';
}

export const StatTile: React.FC<StatTileProps> = ({ label, value, description, variant = 'default' }) => {
  const valueColors = {
    default: 'text-text-primary',
    info: 'text-info',
    warning: 'text-warning',
    success: 'text-success',
    danger: 'text-danger',
  };

  return (
    <div className="stat-tile">
      <div className="text-text-secondary text-sm mb-2">{label}</div>
      <div className={`text-4xl font-bold ${valueColors[variant]}`}>{value}</div>
      {description && <div className="text-xs text-text-muted mt-1">{description}</div>}
    </div>
  );
};
