import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useState } from 'react';

type Variant = 'primary' | 'subtle' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface PhButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode;
  icon?: ReactNode;
  kbd?: ReactNode;
  variant?: Variant;
  size?: Size;
}

const SIZES: Record<Size, { h: number; px: number; fs: number; gap: number }> = {
  sm: { h: 24, px: 8, fs: 11.5, gap: 5 },
  md: { h: 30, px: 12, fs: 12.5, gap: 7 },
  lg: { h: 36, px: 14, fs: 13.5, gap: 8 },
};

export function PhButton({
  children,
  icon,
  kbd,
  variant = 'subtle',
  size = 'md',
  style,
  disabled,
  ...rest
}: PhButtonProps) {
  const [hover, setHover] = useState(false);
  const s = SIZES[size];

  const variants = {
    primary: {
      bg: hover ? 'var(--accent-deep)' : 'var(--accent)',
      // White text reads cleanly against every accent (violet, blue, green,
      // amber, rose, mono-dark in light theme). The previous near-black text
      // worked on light pastels but looked muddy on the default dark theme's
      // saturated accent.
      color: '#ffffff',
      border: '.5px solid transparent',
      shadow: hover
        ? '0 0 0 1px var(--accent-deep), 0 0 18px rgba(167,139,250,0.35)'
        : '0 1px 2px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.18)',
    },
    subtle: {
      bg: hover ? 'var(--surface-3)' : 'var(--surface-2)',
      color: 'var(--fg)',
      border: '.5px solid var(--border-strong)',
      shadow: 'none',
    },
    ghost: {
      bg: hover ? 'var(--surface-2)' : 'transparent',
      color: hover ? 'var(--fg)' : 'var(--fg-mute)',
      border: '.5px solid transparent',
      shadow: 'none',
    },
    danger: {
      bg: hover ? 'rgba(248,113,113,0.18)' : 'rgba(248,113,113,0.10)',
      color: 'var(--danger)',
      border: '.5px solid rgba(248,113,113,0.30)',
      shadow: 'none',
    },
  }[variant];

  return (
    <button
      type="button"
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'inline-flex items-center whitespace-nowrap select-none',
        // Tactile press: a tiny 1px drop on active, instant settle on release.
        // The `transition` covers bg/color/shadow + transform for the press,
        // and `prefers-reduced-motion` is clamped globally by tokens.css.
        'transition-[background,color,box-shadow,transform] duration-150',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'cursor-pointer active:translate-y-px active:duration-75',
      ].join(' ')}
      style={{
        gap: s.gap,
        height: s.h,
        padding: `0 ${s.px}px`,
        background: variants.bg,
        color: variants.color,
        border: variants.border,
        boxShadow: variants.shadow,
        borderRadius: s.h >= 30 ? 8 : 6,
        fontFamily: 'inherit',
        fontSize: s.fs,
        fontWeight: variant === 'primary' ? 500 : 450,
        ...style,
      }}
      {...rest}
    >
      {icon && <span className="flex">{icon}</span>}
      {children}
      {kbd && (
        <span style={{ opacity: variant === 'primary' ? 0.7 : 0.65, marginLeft: 2 }}>{kbd}</span>
      )}
    </button>
  );
}
