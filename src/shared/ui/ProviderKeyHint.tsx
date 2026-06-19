import { I } from './Icon';
import { FREE_KEY_PROVIDERS, PROVIDER_LINKS } from '@shared/lib/providerLinks';

/**
 * Two small, pure hints that help a user who doesn't yet have an API key:
 *   - `FreeKeyCallout` — a banner listing vendors with a free tier.
 *   - `GetKeyLink` — an inline "Get a key →" link for a specific vendor.
 *
 * Both stay presentational: the caller passes `onOpenUrl` so opening a link
 * goes through whatever the app uses (the `open_url` Tauri command), keeping
 * this component free of kernel/IPC imports.
 */

export function FreeKeyCallout({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  return (
    <section
      className="rounded-lg p-3 flex items-start gap-2.5"
      style={{ background: 'var(--accent-tint)', border: '.5px solid var(--accent-tint-2)' }}
    >
      <span
        className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
        style={{ color: 'var(--accent)' }}
      >
        <I.sparkles size={13} />
      </span>
      <div className="flex-1 min-w-0 text-[12px] text-fg-mute leading-relaxed">
        <span className="text-fg-strong font-medium">No API key yet?</span> Several
        providers hand you one for free — limited models and rate limits, but no card
        needed. Click to grab one:
        <div className="flex flex-wrap gap-1.5 mt-2">
          {FREE_KEY_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onOpenUrl(p.url)}
              className="text-[11px] px-2 py-0.5 rounded inline-flex items-center gap-1 transition-colors"
              style={{
                background: 'var(--surface)',
                border: '.5px solid var(--accent-tint-2)',
                color: 'var(--accent)',
                cursor: 'pointer',
              }}
            >
              {p.label}
              <I.arrowR size={10} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function GetKeyLink({
  providerId,
  onOpenUrl,
}: {
  providerId: string | null | undefined;
  onOpenUrl: (url: string) => void;
}) {
  const link = providerId ? PROVIDER_LINKS[providerId] : undefined;
  if (!link || !link.keysUrl) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => onOpenUrl(link.keysUrl)}
        className="text-[11px] inline-flex items-center gap-1"
        style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer' }}
      >
        Get a key
        <I.arrowR size={10} />
      </button>
      {link.freeTier && (
        <span className="text-[11px] text-fg-dim">· {link.freeTier}</span>
      )}
    </span>
  );
}
