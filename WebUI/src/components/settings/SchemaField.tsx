import React from 'react';
import { ConfigSchema } from '../../services/api';

interface SchemaFieldProps {
  name: string;
  path: string;
  schema: ConfigSchema;
  value: unknown;
  onChange: (path: string, value: unknown) => void;
}

export const SchemaField: React.FC<SchemaFieldProps> = ({
  name,
  path,
  schema,
  value,
  onChange,
}) => {
  const handleChange = (newValue: unknown) => {
    onChange(path, newValue);
  };

  // Format field name for display
  const displayName = name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();

  // String with enum -> dropdown
  if (schema.type === 'string' && schema.enum) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-secondary">
          {displayName}
        </label>
        <select
          value={String((value as string) ?? schema.default ?? '')}
          onChange={(e) => handleChange(e.target.value)}
          className="px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
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
        <input
          type="text"
          value={(value as string) ?? schema.default ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={schema.default ? String(schema.default) : undefined}
          className="px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
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
        <input
          type="number"
          value={(value as number) ?? schema.default ?? ''}
          onChange={(e) => handleChange(Number(e.target.value))}
          className="px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
        />
        {schema.description && (
          <p className="text-xs text-text-muted">{schema.description}</p>
        )}
      </div>
    );
  }

  // Boolean -> toggle switch
  if (schema.type === 'boolean') {
    const isChecked = value !== undefined ? Boolean(value) : Boolean(schema.default);
    return (
      <div className="flex items-center justify-between py-2">
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
          onClick={() => handleChange(!isChecked)}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            isChecked ? 'bg-accent' : 'bg-gray-300'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
              isChecked ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
    );
  }

  // Array -> simple text area for now (comma-separated)
  if (schema.type === 'array') {
    const arrayValue = Array.isArray(value) ? value : (schema.default as unknown[]) || [];
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-secondary">
          {displayName}
        </label>
        <textarea
          value={arrayValue.join('\n')}
          onChange={(e) => {
            const lines = e.target.value.split('\n').filter((l) => l.trim());
            handleChange(lines);
          }}
          placeholder="One item per line"
          rows={3}
          className="px-3 py-2 bg-bg-surface rounded-lg border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"
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
