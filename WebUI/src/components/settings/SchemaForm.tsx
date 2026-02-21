import React, { useState, useEffect } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { ConfigSchema } from '../../services/api';
import { SchemaField } from './SchemaField';
import { AIRoleSettings } from './AIRoleSettings';

const STORAGE_KEY = 'steroids-settings-collapsed';

/**
 * Load collapsed state from localStorage
 */
function loadCollapsedState(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * Save collapsed state to localStorage
 */
function saveCollapsedState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

interface SchemaFormProps {
  schema: ConfigSchema;
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  basePath?: string;
  level?: number;
  // For nested forms to share collapsed state with root
  collapsedState?: Record<string, boolean>;
  onToggleCollapse?: (path: string) => void;
  // For project-level settings to show inherited values
  scope?: 'global' | 'project';
  globalValues?: Record<string, unknown>;
}

export const SchemaForm: React.FC<SchemaFormProps> = ({
  schema,
  values,
  onChange,
  basePath = '',
  level = 0,
  collapsedState,
  onToggleCollapse,
  scope = 'global',
  globalValues,
}) => {
  // Only manage state at root level
  const [localCollapsed, setLocalCollapsed] = useState<Record<string, boolean>>(() =>
    level === 0 ? loadCollapsedState() : {}
  );

  // Use parent state if provided, otherwise use local state
  const collapsed = collapsedState ?? localCollapsed;

  // Save to localStorage whenever collapsed state changes (root level only)
  useEffect(() => {
    if (level === 0) {
      saveCollapsedState(localCollapsed);
    }
  }, [localCollapsed, level]);

  if (!schema.properties) {
    return null;
  }

  const toggleCollapse = (path: string) => {
    if (onToggleCollapse) {
      onToggleCollapse(path);
    } else {
      setLocalCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
    }
  };

  // Check if a section is collapsed (default to true = collapsed)
  const isSectionCollapsed = (path: string): boolean => {
    if (path in collapsed) {
      return collapsed[path];
    }
    return true; // Default to collapsed
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

  // Sort properties alphabetically
  const sortedProperties = Object.entries(schema.properties).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className={`space-y-4 ${level > 0 ? 'pl-4 border-l border-border' : ''}`}>
      {sortedProperties.map(([key, fieldSchema]) => {
        const fullPath = basePath ? `${basePath}.${key}` : key;
        const value = getNestedValue(values, fullPath);
        const sectionCollapsed = isSectionCollapsed(fullPath);

        // Format section name
        const displayName = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (str) => str.toUpperCase())
          .trim();

        // Check if this is an AI role section (orchestrator, coder, reviewer, reviewers under ai)
        const isAIRoleSection =
          basePath === 'ai' &&
          (key === 'orchestrator' || key === 'coder' || key === 'reviewer' || key === 'reviewers') &&
          (fieldSchema.type === 'object' || fieldSchema.type === 'array');

        // If it's an AI role section, use the custom AIRoleSettings component
        if (isAIRoleSection) {
          return (
            <div key={key} className="border border-border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => toggleCollapse(fullPath)}
                className="w-full flex items-center justify-between px-4 py-3 bg-bg-surface2 hover:bg-bg-surface2/80 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {sectionCollapsed ? (
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
              {!sectionCollapsed && (
                <div className="p-4 bg-bg-surface">
                  <AIRoleSettings
                    role={key as 'orchestrator' | 'coder' | 'reviewer' | 'reviewers'}
                    schema={fieldSchema}
                    values={values}
                    onChange={onChange}
                    basePath={fullPath}
                    scope={scope}
                    globalValues={globalValues}
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
                onClick={() => toggleCollapse(fullPath)}
                className="w-full flex items-center justify-between px-4 py-3 bg-bg-surface2 hover:bg-bg-surface2/80 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {sectionCollapsed ? (
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
              {!sectionCollapsed && (
                <div className="p-4 bg-bg-surface space-y-4">
                  <SchemaForm
                    schema={fieldSchema}
                    values={values}
                    onChange={onChange}
                    basePath={fullPath}
                    level={level + 1}
                    collapsedState={collapsed}
                    onToggleCollapse={toggleCollapse}
                    scope={scope}
                    globalValues={globalValues}
                  />
                </div>
              )}
            </div>
          );
        }

        // Otherwise render as a field
        const globalFieldValue = globalValues ? getNestedValue(globalValues, fullPath) : undefined;
        return (
          <SchemaField
            key={key}
            name={key}
            path={fullPath}
            schema={fieldSchema}
            value={value}
            onChange={onChange}
            scope={scope}
            globalValue={globalFieldValue}
          />
        );
      })}
    </div>
  );
};
