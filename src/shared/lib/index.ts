// Shared Library - Generic utilities only (no business logic)

// Utility functions
export * from './utils';

// Date utilities
export * as dateUtils from './date';
export { DateFormat } from './date';

// String utilities
export * as stringUtils from './string';

// Number utilities
export * as numberUtils from './number';

// Theme utilities
export { ThemeProvider, useTheme } from './theme';

// Live global-shortcut bindings (read-only hint surfaces)
export {
  useShortcuts,
  prettyAccel,
  SHORTCUT_DEFAULTS,
  type ShortcutId,
  type ShortcutItem,
  type ShortcutLookup,
} from './shortcuts';
