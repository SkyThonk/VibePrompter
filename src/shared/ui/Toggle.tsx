interface ToggleProps {
  value: boolean;
  onChange: (v: boolean) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Accessible label, important when the toggle isn't paired with visible text. */
  'aria-label'?: string;
}

/**
 * Animated toggle.
 *  - Thumb glides on a calm spring (160ms, cubic-bezier(.34,1.56,.64,1)).
 *  - Press compresses the thumb to 0.86 scale for tactile feedback (driven by
 *    a CSS rule in `tokens.css` that combines the translate and the scale).
 *  - Global `prefers-reduced-motion` clamp keeps both behaviors instant under
 *    reduced motion.
 */
export function Toggle({ value, onChange, size = 'md', disabled, ...aria }: ToggleProps) {
  const w = size === 'sm' ? 28 : 32;
  const h = size === 'sm' ? 16 : 18;
  const dot = h - 4;
  const offset = value ? w - dot - 4 : 0;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`ph-toggle relative border-0 p-0.5 transition-colors duration-150 select-none ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
      style={
        {
          width: w,
          height: h,
          borderRadius: h,
          background: value ? 'var(--accent)' : 'var(--surface-3)',
          boxShadow: value
            ? 'inset 0 0 0 .5px rgba(255,255,255,0.15)'
            : 'inset 0 0 0 .5px var(--border-strong)',
          // Expose the thumb position as a custom property so the press CSS
          // can combine translateX + scale without losing position.
          ['--ph-toggle-x' as string]: `${offset}px`,
        } as React.CSSProperties
      }
      {...aria}
    >
      <span
        aria-hidden="true"
        className="ph-toggle__thumb block rounded-full"
        style={{
          width: dot,
          height: dot,
          // White thumb on the accent-coloured "on" track reads cleanly
          // against every accent in both themes. The previous near-black
          // was muddy on light-theme accents and looked off-brand on dark.
          background: value ? '#ffffff' : 'var(--fg-mute)',
          transform: 'translateX(var(--ph-toggle-x))',
          transition:
            'transform 160ms cubic-bezier(.34,1.56,.64,1), background 140ms ease-out',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  );
}
