import type { ReactElement } from 'react';
import { THEMES, type Theme } from '@sheep/core';

const LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

/**
 * Theme choice, persisted through the settings store.
 *
 * Three states rather than two: `system` is a live preference that follows the
 * OS, which is different from having picked whichever value the OS happens to
 * hold right now.
 */
export function ThemeToggle({
  theme,
  resolved,
  onChange,
  disabled,
}: {
  theme: Theme;
  resolved: 'light' | 'dark';
  onChange: (theme: Theme) => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div
      className="theme-toggle"
      role="group"
      aria-label="Colour theme"
      data-sheep-theme={theme}
      data-sheep-theme-resolved={resolved}
    >
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          className="theme-toggle__option"
          aria-pressed={theme === option}
          data-sheep-theme-option={option}
          disabled={disabled}
          onClick={() => {
            onChange(option);
          }}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
