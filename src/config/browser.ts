/**
 * TUI Config Browser
 * Simple interactive terminal browser for configuration
 */

import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { loadConfig, getConfigValue, type SteroidsConfig } from './loader.js';
import { CONFIG_SCHEMA, isSchemaField, type SchemaObject, type SchemaField } from './schema.js';

interface BrowserState {
  path: string[];
  selectedIndex: number;
  items: string[];
}

/**
 * Get items at current path
 */
function getItemsAtPath(schema: SchemaObject, path: string[]): string[] {
  let current: SchemaObject = schema;

  for (const part of path) {
    const entry = current[part];
    if (!entry || isSchemaField(entry)) {
      return [];
    }
    current = entry as SchemaObject;
  }

  return Object.keys(current).filter((k) => !k.startsWith('_'));
}

/**
 * Get description for an item
 */
function getDescription(schema: SchemaObject, path: string[], item: string): string {
  let current: SchemaObject = schema;

  for (const part of path) {
    const entry = current[part];
    if (!entry || isSchemaField(entry)) {
      return '';
    }
    current = entry as SchemaObject;
  }

  const entry = current[item];
  if (!entry) return '';

  if (isSchemaField(entry)) {
    return entry._description;
  }

  if ('_description' in entry) {
    return (entry as unknown as { _description: string })._description;
  }

  return '';
}

/**
 * Get value at path
 */
function getValue(config: SteroidsConfig, path: string[]): unknown {
  const fullPath = path.join('.');
  return getConfigValue(config, fullPath);
}

/**
 * Clear screen and move cursor to top
 */
function clearScreen(): void {
  stdout.write('\x1b[2J\x1b[H');
}

/**
 * Render the browser UI
 */
function render(state: BrowserState, config: SteroidsConfig): void {
  clearScreen();

  const pathStr = state.path.length > 0 ? state.path.join(' > ') : 'root';

  console.log('┌' + '─'.repeat(70) + '┐');
  console.log('│' + ` Steroids Config Browser: ${pathStr}`.padEnd(70) + '│');
  console.log('├' + '─'.repeat(70) + '┤');

  if (state.items.length === 0) {
    console.log('│' + '  (empty)'.padEnd(70) + '│');
  } else {
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? '▸ ' : '  ';
      const description = getDescription(CONFIG_SCHEMA, state.path, item);

      // Get current value if it's a leaf
      const itemPath = [...state.path, item];
      const fullPath = itemPath.join('.');
      let schemaNode: SchemaObject | SchemaField = CONFIG_SCHEMA;
      for (const p of itemPath) {
        schemaNode = (schemaNode as SchemaObject)[p];
      }

      let line: string;
      if (isSchemaField(schemaNode)) {
        const value = getValue(config, itemPath);
        const valueStr = value !== undefined ? String(value) : '(not set)';
        line = `${prefix}${item.padEnd(20)} = ${valueStr}`;
      } else {
        line = `${prefix}${item.padEnd(20)}   [${description.substring(0, 40)}]`;
      }

      if (isSelected) {
        console.log('│' + `\x1b[7m${line.substring(0, 70).padEnd(70)}\x1b[0m` + '│');
      } else {
        console.log('│' + line.substring(0, 70).padEnd(70) + '│');
      }
    }
  }

  console.log('├' + '─'.repeat(70) + '┤');
  console.log('│' + ' [↑/↓] Navigate  [Enter] Drill down  [Backspace] Back  [q] Quit'.padEnd(70) + '│');
  console.log('└' + '─'.repeat(70) + '┘');
}

/**
 * Run the interactive browser
 */
export async function runBrowser(): Promise<void> {
  const config = loadConfig();

  const state: BrowserState = {
    path: [],
    selectedIndex: 0,
    items: getItemsAtPath(CONFIG_SCHEMA, []),
  };

  // Set up raw mode for key input
  if (!stdin.isTTY) {
    console.error('Browser requires an interactive terminal.');
    console.error('Use "steroids config show" instead.');
    process.exit(1);
  }

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);

  render(state, config);

  return new Promise((resolve) => {
    stdin.on('keypress', (str, key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        stdin.setRawMode(false);
        clearScreen();
        console.log('Exited config browser.');
        resolve();
        return;
      }

      if (key.name === 'up') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      } else if (key.name === 'down') {
        state.selectedIndex = Math.min(state.items.length - 1, state.selectedIndex + 1);
      } else if (key.name === 'return') {
        // Drill down
        if (state.items.length > 0) {
          const selected = state.items[state.selectedIndex];
          const newPath = [...state.path, selected];
          const newItems = getItemsAtPath(CONFIG_SCHEMA, newPath);

          if (newItems.length > 0) {
            state.path = newPath;
            state.items = newItems;
            state.selectedIndex = 0;
          }
        }
      } else if (key.name === 'backspace' || key.name === 'escape') {
        // Go back
        if (state.path.length > 0) {
          state.path.pop();
          state.items = getItemsAtPath(CONFIG_SCHEMA, state.path);
          state.selectedIndex = 0;
        }
      }

      render(state, config);
    });
  });
}
