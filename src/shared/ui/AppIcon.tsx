import logoUrl from '@/assets/logo.png';

interface AppIconProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Render the app logo PNG exactly as-is — no rounded clip, no cropping,
 * no background. The image's own transparency is the shape; whatever
 * design lives in `assets/logo.png` is what the user sees.
 *
 * Earlier versions clipped to `rounded-[Npx]` + `object-cover` to mimic
 * the Windows MSIX rounded-tile look. That made sense for a generic
 * square logomark; once the PNG itself includes a finished design with
 * its own padding and shape, the clip just crops content off the edges
 * and re-frames it. The wrapper container is left to inherit page
 * background (most often dark via `--bg`), so a tinted halo in the PNG
 * itself shows through as a faint fringe on light themes. Solution:
 * trust the PNG, use `object-contain`, drop the rounded clip.
 *
 * Size presets give consistent layout dimensions across surfaces (window
 * titlebar, dashboard hero, setup screen, tray menu) while preserving
 * aspect ratio inside the requested box.
 */
const SIZE_PX: Record<NonNullable<AppIconProps['size']>, number> = {
  sm: 18,
  md: 22,
  lg: 28,
  xl: 40,
};

export function AppIcon({ size = 'md', className = '', style }: AppIconProps) {
  const px = SIZE_PX[size];
  return (
    <img
      src={logoUrl}
      width={px}
      height={px}
      alt="VibePrompter"
      draggable={false}
      className={`select-none pointer-events-none ${className}`}
      style={{
        // `object-contain` preserves the PNG's aspect + transparent
        // padding instead of cropping a square out of the middle.
        objectFit: 'contain',
        // No background, no border, no clip. The PNG is the icon.
        background: 'transparent',
        ...style,
      }}
    />
  );
}
