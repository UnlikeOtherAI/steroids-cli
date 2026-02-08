import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'accent';
  size?: 'sm' | 'md' | 'lg';
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}) => {
  const baseClasses = 'rounded-full font-medium transition-all duration-150 disabled:opacity-50';

  const variantClasses = {
    primary: 'bg-accent text-white hover:bg-accent-hover shadow-pill',
    secondary: 'bg-bg-elevated text-text-primary hover:shadow-card shadow-pill',
    danger: 'bg-danger text-white hover:opacity-90',
    ghost: 'bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-surface2',
    accent: 'bg-accent text-white hover:bg-accent-hover shadow-pill',
  };

  const sizeClasses = {
    sm: 'px-3 py-1 text-sm',
    md: 'px-4 py-2',
    lg: 'px-6 py-3 text-lg',
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
