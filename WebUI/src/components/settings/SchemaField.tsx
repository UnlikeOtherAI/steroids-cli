import React from 'react';
import { ConfigSchema } from '../../services/api';

interface SchemaFieldProps {
  name: string;
  path: string;
  schema: ConfigSchema;
  value: unknown;
  onChange: (path: string, value: unknown) => void;
  scope?: 'global' | 'project';
  globalValue?: unknown;
}

export const SchemaField: React.FC<SchemaFieldProps> = ({
  name,
  path,
  schema,
  value,
  onChange,
  scope = 'global',
  globalValue,
}) => {
  // For project scope, check if value is inherited (undefined/null means inherited)
  const isInherited = scope === 'project' && (value === undefined || value === null || value === '');
  const displayValue = isInherited ? globalValue : value;

  const handleChange = (newValue: unknown) => {
    onChange(path, newValue);
  };

  const handleModeChange = (useInherited: boolean) => {
    if (useInherited) {
      // Clear the project-level value to inherit from global
      onChange(path, '');
    } else {
      // Copy global value as starting point for custom
      onChange(path, globalValue ?? schema.default ?? '');
    }
  };

  // Format field name for display
  const displayName = name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();

  // Format value for display
  const formatDisplayValue = (val: unknown): string => {
    if (val === undefined || val === null || val === '') return '(not set)';
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '(empty)';
    return String(val);
  };

  // Inherited/Custom toggle for project scope
  const renderModeToggle = () => {
    if (scope !== 'project') return null;

    return (
      <div className="flex items-center gap-2 mb-2">
        <div className="flex rounded-md border border-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => handleModeChange(true)}
            className={`px-2 py-1 transition-colors ${
              isInherited
                ? 'bg-accent text-white'
                : 'bg-bg-surface text-text-secondary hover:bg-bg-surface2'
            }`}
          >
            Inherited
          </button>
          <button
            type="button"
            onClick={() => handleModeChange(false)}
            className={`px-2 py-1 transition-colors ${
              !isInherited
                ? 'bg-accent text-white'
                : 'bg-bg-surface text-text-secondary hover:bg-bg-surface2'
            }`}
          >
            Custom
          </button>
        </div>
        {isInherited && globalValue !== undefined && globalValue !== null && globalValue !== '' && (
          <span className="text-xs text-text-secondary">
            Global: {formatDisplayValue(globalValue)}
          </span>
        )}
      </div>
    );
  };

  // String with enum -> dropdown
  if (schema.type === 'string' && schema.enum) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-secondary">
          {displayName}
        </label>
        {renderModeToggle()}
        <select
          value={String((displayValue as string) ?? schema.default ?? '')}
          onChange={(e) => handleChange(e.target.value)}
          disabled={isInherited}
          className={`px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent ${
            isInherited ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        >
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
        {schema.description && (
          <p className="text-xs text-text-muted">{schema.description}</p>
        )}
      </div>
    );
  }

  // String -> text input
  if (schema.type === 'string') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-secondary">
          {displayName}
        </label>
        {renderModeToggle()}
        <input
          type="text"
          value={(displayValue as string) ?? schema.default ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={schema.default ? String(schema.default) : undefined}
          disabled={isInherited}
          className={`px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent ${
            isInherited ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        />
        {schema.description && (
          <p className="text-xs text-text-muted">{schema.description}</p>
        )}
      </div>
    );
  }

  // Number -> number input
  if (schema.type === 'number') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-secondary">
          {displayName}
        </label>
        {renderModeToggle()}
        <input
          type="number"
          value={(displayValue as number) ?? schema.default ?? ''}
          onChange={(e) => handleChange(Number(e.target.value))}
          disabled={isInherited}
          className={`px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent ${
            isInherited ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        />
        {schema.description && (
          <p className="text-xs text-text-muted">{schema.description}</p>
        )}
      </div>
    );
  }

  // Boolean -> toggle switch
  if (schema.type === 'boolean') {
    const isChecked = displayValue !== undefined ? Boolean(displayValue) : Boolean(schema.default);
    return (
      <div className="flex flex-col gap-1 py-2">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <label className="text-sm font-medium text-text-secondary">
              {displayName}
            </label>
            {schema.description && (
              <p className="text-xs text-text-muted">{schema.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => !isInherited && handleChange(!isChecked)}
            disabled={isInherited}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              isChecked ? 'bg-accent' : 'bg-gray-300'
            } ${isInherited ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                isChecked ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        {renderModeToggle()}
      </div>
    );
  }

  // Array -> simple text area for now (comma-separated)
  if (schema.type === 'array') {
    const arrayValue = Array.isArray(displayValue) ? displayValue : (schema.default as unknown[]) || [];
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-secondary">
          {displayName}
        </label>
        {renderModeToggle()}
        <textarea
          value={arrayValue.join('\n')}
          onChange={(e) => {
            const lines = e.target.value.split('\n').filter((l) => l.trim());
            handleChange(lines);
          }}
          placeholder="One item per line"
          rows={3}
          disabled={isInherited}
          className={`px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm ${
            isInherited ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        />
        {schema.description && (
          <p className="text-xs text-text-muted">{schema.description}</p>
        )}
      </div>
    );
  }

  // Fallback: display as JSON
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-text-secondary">
        {displayName}
      </label>
      <pre className="px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary text-xs overflow-auto">
        {JSON.stringify(value ?? schema.default, null, 2)}
      </pre>
      {schema.description && (
        <p className="text-xs text-text-muted">{schema.description}</p>
      )}
    </div>
  );
};
