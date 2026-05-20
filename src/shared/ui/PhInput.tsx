import type { InputHTMLAttributes, ReactNode, CSSProperties } from 'react';
import { useState } from 'react';

interface PhInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'style' | 'onChange'> {
  icon?: ReactNode;
  suffix?: ReactNode;
  mono?: boolean;
  size?: 'sm' | 'md' | 'lg';
  style?: CSSProperties;
  onChange?: (value: string) => void;
}

export function PhInput({
  icon,
  suffix,
  mono,
  size = 'md',
  style,
  value,
  onChange,
  ...rest
}: PhInputProps) {
  const [f, setF] = useState(false);
  const h = size === 'lg' ? 38 : size === 'sm' ? 26 : 32;

  return (
    <div
      className="flex items-center text-fg transition-[border-color,box-shadow] duration-100"
      style={{
        height: h,
        padding: `0 ${size === 'sm' ? 8 : 10}px`,
        background: 'var(--surface-2)',
        border: '.5px solid',
        borderColor: f ? 'var(--accent)' : 'var(--border-strong)',
        borderRadius: size === 'lg' ? 'var(--r-md)' : 6,
        // Subtle focus indicator: the border-color change already reads as
        // active; we add a very soft outer glow for accessibility without
        // the heavy 1px ring + 24px glow that `--accent-glow` used to apply
        // (that combination read as a "thick purple band" on every focused
        // input). Buttons / cards keep using `--accent-glow` unchanged.
        boxShadow: f ? '0 0 0 2px var(--accent-tint)' : 'none',
        gap: 8,
        ...style,
      }}
    >
      {icon && <span className="text-fg-mute flex">{icon}</span>}
      <input
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onFocus={() => setF(true)}
        onBlur={() => setF(false)}
        // Disable browser autofill across the board. Edge/WebView2 was
        // painting a colored fill + faux-focus border on inputs it
        // recognized from history, and the user had no way to clear
        // it. None of our fields benefit from browser autofill — keys
        // live in the OS keyring, labels are per-connection. We use
        // a contrived autocomplete value ("vp-no-autofill") because
        // "off" is widely ignored by modern Chromium for security
        // reasons; a non-standard token reliably opts out.
        autoComplete="vp-no-autofill"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-form-type="other"
        data-lpignore="true"
        className="flex-1 min-w-0 h-full bg-transparent border-0 outline-none text-fg p-0"
        style={{
          fontFamily: mono ? 'var(--mono)' : 'inherit',
          fontSize: size === 'sm' ? 12 : 13,
        }}
        {...rest}
      />
      {suffix}
    </div>
  );
}
