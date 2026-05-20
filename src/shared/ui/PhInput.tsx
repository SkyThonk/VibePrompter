import type { InputHTMLAttributes, ReactNode, CSSProperties } from 'react';
import { useId, useState } from 'react';

/**
 * Single-element input. Earlier versions wrapped a transparent `<input>`
 * inside a styled `<div>` to support icon + suffix slots, but that
 * pattern double-painted on autofill (WebView2 styles the input element
 * itself, and any wrapper border on top stacked into a visible "second
 * border"). Now the input element IS the styled surface; icon + suffix
 * are absolute-positioned overlays. One border, one background, one
 * focus state — no possibility of a second band leaking through.
 *
 * Theme: relies on `--bg-2`, `--border-strong`, `--accent`, `--accent-tint`.
 * Light theme: bg becomes near-white, border becomes a soft dark line.
 * Dark theme: bg becomes near-black, border becomes a soft light line.
 * The same CSS vars resolve correctly in both modes.
 */
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
  onFocus,
  onBlur,
  disabled,
  ...rest
}: PhInputProps) {
  const [focused, setFocused] = useState(false);
  const reactId = useId();
  const id = rest.id ?? `phi-${reactId.replace(/:/g, '')}`;

  const h = size === 'lg' ? 38 : size === 'sm' ? 26 : 32;
  const padX = size === 'sm' ? 8 : 10;
  const fontSize = size === 'sm' ? 12 : 13;

  // Padding adjusts to leave room for an icon (left) and/or suffix (right).
  // The slots overlay the input via absolute positioning, so we just need
  // to push the text out from under them.
  const padLeft = icon ? padX + 22 : padX;
  const padRight = suffix ? padX + 28 : padX;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {icon && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: padX,
            top: 0,
            height: h,
            display: 'flex',
            alignItems: 'center',
            color: 'var(--fg-mute)',
            pointerEvents: 'none',
          }}
        >
          {icon}
        </span>
      )}
      <input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        // Browser autofill opt-out. Without this, Edge/WebView2 paints a
        // colored fill + faux-focus border on inputs it recognises from
        // form history. None of our fields need autofill — keys live in
        // the OS keyring, labels are per-connection. The non-standard
        // autocomplete token bypasses Chromium's "ignore off" rule; the
        // data-* attrs opt out of password-manager extensions too.
        autoComplete="vp-no-autofill"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-form-type="other"
        data-lpignore="true"
        data-1p-ignore
        style={{
          // Sizing
          width: '100%',
          height: h,
          padding: `0 ${padRight}px 0 ${padLeft}px`,
          // Surface — same token across themes, resolves to the right
          // shade per `[data-theme]`. `--bg-2` is the muted-input fill
          // that pairs with `--surface` cards.
          background: 'var(--bg-2)',
          // Single border. Switches color on focus.
          border: `1px solid ${focused ? 'var(--accent)' : 'var(--border-strong)'}`,
          borderRadius: size === 'lg' ? 8 : 6,
          // One subtle outer halo on focus for accessibility. No inner
          // ring, no glow — the border-color change is the primary signal.
          boxShadow: focused ? '0 0 0 2px var(--accent-tint)' : 'none',
          // Typography
          color: 'var(--fg)',
          fontFamily: mono ? 'var(--mono)' : 'inherit',
          fontSize,
          lineHeight: `${h - 2}px`,
          // Reset browser defaults that were causing the inner artifacts.
          outline: 'none',
          WebkitAppearance: 'none',
          appearance: 'none',
          // Transitions: only what changes.
          transition: 'border-color 100ms ease, box-shadow 100ms ease',
          // Disabled feel.
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'not-allowed' : 'text',
          ...style,
        }}
        {...rest}
      />
      {suffix && (
        <span
          style={{
            position: 'absolute',
            right: padX,
            top: 0,
            height: h,
            display: 'flex',
            alignItems: 'center',
            color: 'var(--fg-mute)',
            pointerEvents: 'none',
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}
