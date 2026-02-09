import React, { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { ConfigSchema } from '../../services/api';
import { SchemaField } from './SchemaField';
import { AIRoleSettings } from './AIRoleSettings';

interface SchemaFormProps {
  schema: ConfigSchema;
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  basePath?: string;
  level?: number;
}

export const SchemaForm: React.FC<SchemaFormProps> = ({
  schema,
  values,
  onChange,
  basePath = '',
  level = 0,
}) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!schema.properties) {
    return null;
  }

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
    const keys = path.split('.');
    let current: unknown = obj;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };

  return (
    <div className={`space-y-4 ${level > 0 ? 'pl-4 border-l border-border' : ''}`}>
      {Object.entries(schema.properties).map(([key, fieldSchema]) => {
        const fullPath = basePath ? `${basePath}.${key}` : key;
        const value = getNestedValue(values, fullPath);
        const isCollapsed = collapsed[key] ?? false;

        // Format section name
        const displayName = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (str) => str.toUpperCase())
          .trim();

        // Check if this is an AI role section (orchestrator, coder, reviewer under ai)
        const isAIRoleSection =
          basePath === 'ai' &&
          (key === 'orchestrator' || key === 'coder' || key === 'reviewer') &&
          fieldSchema.type === 'object' &&
          fieldSchema.properties;

        // If it's an AI role section, use the custom AIRoleSettings component
        if (isAIRoleSection) {
          return (
            <div key={key} className="border border-border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => toggleCollapse(key)}
                className="w-full flex items-center justify-between px-4 py-3 bg-bg-surface2 hover:bg-bg-surface2/80 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {isCollapsed ? (
                    <ChevronRightIcon className="w-4 h-4 text-text-muted" />
                  ) : (
                    <ChevronDownIcon className="w-4 h-4 text-text-muted" />
                  )}
                  <span className="font-medium text-text-primary">{displayName}</span>
                </div>
                {fieldSchema.description && (
                  <span className="text-xs text-text-muted hidden sm:block">
                    {fieldSchema.description}
                  </span>
                )}
              </button>
              {!isCollapsed && (
                <div className="p-4 bg-bg-surface">
                  <AIRoleSettings
                    role={key as 'orchestrator' | 'coder' | 'reviewer'}
                    schema={fieldSchema}
                    values={values}
                    onChange={onChange}
                    basePath={fullPath}
                  />
                </div>
              )}
            </div>
          );
        }

        // If it's an object type with properties, render as collapsible section
        if (fieldSchema.type === 'object' && fieldSchema.properties) {
          return (
            <div key={key} className="border border-border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => toggleCollapse(key)}
                className="w-full flex items-center justify-between px-4 py-3 bg-bg-surface2 hover:bg-bg-surface2/80 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {isCollapsed ? (
                    <ChevronRightIcon className="w-4 h-4 text-text-muted" />
                  ) : (
                    <ChevronDownIcon className="w-4 h-4 text-text-muted" />
                  )}
                  <span className="font-medium text-text-primary">{displayName}</span>
                </div>
                {fieldSchema.description && (
                  <span className="text-xs text-text-muted hidden sm:block">
                    {fieldSchema.description}
                  </span>
                )}
              </button>
              {!isCollapsed && (
                <div className="p-4 bg-bg-surface space-y-4">
                  <SchemaForm
                    schema={fieldSchema}
                    values={values}
                    onChange={onChange}
                    basePath={fullPath}
                    level={level + 1}
                  />
                </div>
              )}
            </div>
          );
        }

        // Otherwise render as a field
        return (
          <SchemaField
            key={key}
            name={key}
            path={fullPath}
            schema={fieldSchema}
            value={value}
            onChange={onChange}
          />
        );
      })}
    </div>
  );
};
