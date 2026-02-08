/**
 * Colored output support for Steroids CLI
 *
 * Respects NO_COLOR environment variable and --no-color flag
 * following the no-color.org standard.
 */

/**
 * ANSI color codes
 */
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright variants
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
};

/**
 * Check if colors should be disabled
 *
 * Colors are disabled if:
 * - NO_COLOR environment variable is set (any value)
 * - STEROIDS_NO_COLOR is set to '1' or 'true'
 * - stdout is not a TTY
 *
 * Note: This is an internal function. Use the env.ts version for global checks.
 */
function shouldDisableColors(): boolean {
  return (
    process.env.NO_COLOR !== undefined ||
    process.env.STEROIDS_NO_COLOR === '1' ||
    process.env.STEROIDS_NO_COLOR === 'true' ||
    !process.stdout.isTTY
  );
}

/**
 * Apply color to text if colors are enabled
 */
function colorize(text: string, color: string): string {
  if (shouldDisableColors()) {
    return text;
  }
  return `${color}${text}${COLORS.reset}`;
}

/**
 * Color helpers for common use cases
 */
export const colors = {
  /**
   * Red text (for errors)
   */
  red(text: string): string {
    return colorize(text, COLORS.red);
  },

  /**
   * Green text (for success)
   */
  green(text: string): string {
    return colorize(text, COLORS.green);
  },

  /**
   * Yellow text (for warnings)
   */
  yellow(text: string): string {
    return colorize(text, COLORS.yellow);
  },

  /**
   * Blue text (for info)
   */
  blue(text: string): string {
    return colorize(text, COLORS.blue);
  },

  /**
   * Magenta text
   */
  magenta(text: string): string {
    return colorize(text, COLORS.magenta);
  },

  /**
   * Cyan text
   */
  cyan(text: string): string {
    return colorize(text, COLORS.cyan);
  },

  /**
   * Gray text (for dimmed output)
   */
  gray(text: string): string {
    return colorize(text, COLORS.gray);
  },

  /**
   * Bold text
   */
  bold(text: string): string {
    return colorize(text, COLORS.bold);
  },

  /**
   * Dim text
   */
  dim(text: string): string {
    return colorize(text, COLORS.dim);
  },

  /**
   * Bright variants
   */
  brightRed(text: string): string {
    return colorize(text, COLORS.brightRed);
  },

  brightGreen(text: string): string {
    return colorize(text, COLORS.brightGreen);
  },

  brightYellow(text: string): string {
    return colorize(text, COLORS.brightYellow);
  },

  brightBlue(text: string): string {
    return colorize(text, COLORS.brightBlue);
  },

  brightMagenta(text: string): string {
    return colorize(text, COLORS.brightMagenta);
  },

  brightCyan(text: string): string {
    return colorize(text, COLORS.brightCyan);
  },
};

/**
 * Status markers with colors
 */
export const markers = {
  /**
   * Success marker (✓)
   */
  success(text?: string): string {
    const marker = colors.green('✓');
    return text ? `${marker} ${text}` : marker;
  },

  /**
   * Error marker (✗)
   */
  error(text?: string): string {
    const marker = colors.red('✗');
    return text ? `${marker} ${text}` : marker;
  },

  /**
   * Warning marker (⚠)
   */
  warning(text?: string): string {
    const marker = colors.yellow('⚠');
    return text ? `${marker} ${text}` : marker;
  },

  /**
   * Info marker (ℹ)
   */
  info(text?: string): string {
    const marker = colors.blue('ℹ');
    return text ? `${marker} ${text}` : marker;
  },

  /**
   * Pending marker (○)
   */
  pending(text?: string): string {
    const marker = colors.gray('○');
    return text ? `${marker} ${text}` : marker;
  },

  /**
   * In progress marker (◐)
   */
  progress(text?: string): string {
    const marker = colors.cyan('◐');
    return text ? `${marker} ${text}` : marker;
  },

  /**
   * Completed marker (●)
   */
  completed(text?: string): string {
    const marker = colors.green('●');
    return text ? `${marker} ${text}` : marker;
  },

  /**
   * Bullet point (•)
   */
  bullet(text?: string): string {
    const marker = colors.dim('•');
    return text ? `${marker} ${text}` : marker;
  },
};

/**
 * Format error message with red color
 */
export function formatError(message: string): string {
  return colors.red(`Error: ${message}`);
}

/**
 * Format success message with green color
 */
export function formatSuccess(message: string): string {
  return colors.green(message);
}

/**
 * Format warning message with yellow color
 */
export function formatWarning(message: string): string {
  return colors.yellow(`Warning: ${message}`);
}

/**
 * Format info message with blue color
 */
export function formatInfo(message: string): string {
  return colors.blue(message);
}
