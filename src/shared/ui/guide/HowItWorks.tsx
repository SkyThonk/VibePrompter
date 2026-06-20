import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShortcuts } from '@shared/lib/shortcuts';
import { I } from '../Icon';

/**
 * "How it works" guide — the one place that explains the whole idea of the app
 * to a new user: the select → hotkey → overlay loop, what a Mode is, and how to
 * bend it into your own workflow. Deliberately a static explainer (not a
 * coach-mark tour) so it never breaks when the UI shifts and isn't annoying on
 * repeat views.
 *
 * Trigger: window event `app:show-guide` — fired from the dashboard button,
 * the command palette, the cheat sheet, the About panel, and once
 * automatically right after onboarding finishes.
 */
export function HowItWorks() {
  const navigate = useNavigate();
  const { pretty } = useShortcuts();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('app:show-guide', onOpen);
    return () => window.removeEventListener('app:show-guide', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(10, 11, 15, 0.45)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ph-anim-pop-in"
        style={{
          width: 'min(620px, 94vw)',
          maxHeight: '86vh',
          background: 'var(--glass)',
          backdropFilter: 'blur(40px) saturate(180%)',
          border: '.5px solid var(--border-strong)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: '.5px solid var(--divider)',
          }}
        >
          <I.sparkles size={14} style={{ color: 'var(--accent)' }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg-strong)' }}>
            How VibePrompter works
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-mute)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 4,
            }}
            title="Close (Esc)"
          >
            <I.close size={14} />
          </button>
        </div>

        <div style={{ overflow: 'auto', padding: '16px 18px 18px' }} className="flex flex-col gap-5">
          <p className="m-0 text-[12.5px] text-fg-mute leading-relaxed">
            VibePrompter sits in your system tray. You never switch windows — you
            fix text right where you are, in three steps:
          </p>

          {/* The core loop */}
          <CoreLoop />

          {/* What's a mode */}
          <Block icon={<I.layers size={13} />} title="What's a Mode?">
            A <strong className="text-fg">Mode</strong> is a saved prompt plus model
            settings — it decides <em>how</em> your text gets rewritten. The{' '}
            <strong className="text-fg">active mode</strong> is what the Rewrite
            hotkey (<Combo k={pretty('rewrite')} />) runs. Grammar and Summarize are
            their own built-in modes on their own keys.
            <div className="mt-2 text-fg-dim">
              Want a “Formal email” rewrite and a “Punchy & concise” rewrite? Make a
              mode for each, then switch between them from the dashboard or with{' '}
              <Combo k={pretty('modes')} />.
            </div>
          </Block>

          {/* Make it your workflow */}
          <Block icon={<I.wand size={13} />} title="Make it your workflow">
            <ul className="m-0 pl-4 flex flex-col gap-1 list-disc">
              <li>
                Edit a mode's <strong className="text-fg">system prompt</strong> to
                define exactly how it should rewrite — tone, length, rules.
              </li>
              <li>
                Use <code className="ph-mono">{'{{variables}}'}</code> in a prompt for
                reusable placeholders (e.g. audience, target language).
              </li>
              <li>
                Bind any mode or action to a <strong className="text-fg">global
                hotkey</strong> so it works everywhere.
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => go('/settings/modes')} style={pillBtn}>
                <I.layers size={11} /> Manage modes
              </button>
              <button type="button" onClick={() => go('/settings/shortcuts')} style={pillBtn}>
                <I.keyboard size={11} /> Edit shortcuts
              </button>
            </div>
          </Block>

          <div className="text-[11.5px] text-fg-dim">
            Handy anytime: <Combo k="Ctrl + K" /> command palette ·{' '}
            <Combo k="Ctrl + /" /> all keyboard shortcuts.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 16px',
            borderTop: '.5px solid var(--divider)',
          }}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '7px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

const pillBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 12,
  padding: '5px 10px',
  borderRadius: 7,
  background: 'var(--surface-2)',
  border: '.5px solid var(--border-strong)',
  color: 'var(--fg)',
  cursor: 'pointer',
};

/**
 * The select → hotkey → review loop, shared by the guide modal and the
 * dashboard's "How to use" card so the two never tell a different story.
 */
export function CoreLoop() {
  const { pretty } = useShortcuts();
  return (
    <div className="flex flex-col gap-2.5">
      <Step
        n={1}
        title="Select text — in any app"
        body="An email, a Slack message, a doc, code… just highlight it."
      />
      <Step
        n={2}
        title="Press a hotkey"
        body={
          <span className="flex flex-wrap items-center gap-1.5">
            <Combo k={pretty('rewrite')} /> rewrite ·
            <Combo k={pretty('grammar')} /> fix grammar ·
            <Combo k={pretty('summary')} /> summarize
          </span>
        }
      />
      <Step
        n={3}
        title="Review the popup at your cursor"
        body={
          <>
            Press <Combo k="Enter" /> to replace your selection, or <Combo k="Esc" />{' '}
            to discard. Not quite right? Type a follow-up like “make it shorter” to
            tweak it.
          </>
        }
      />
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="flex items-center justify-center flex-shrink-0 ph-mono"
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--accent-tint)',
          color: 'var(--accent)',
          border: '.5px solid var(--accent-tint-2)',
          fontSize: 11,
          fontWeight: 700,
          marginTop: 1,
        }}
      >
        {n}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-fg-strong">{title}</div>
        <div className="text-[12px] text-fg-mute leading-relaxed mt-0.5">{body}</div>
      </div>
    </div>
  );
}

function Block({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-lg p-3.5"
      style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span style={{ color: 'var(--accent)' }}>{icon}</span>
        <span className="text-[12.5px] font-semibold text-fg-strong">{title}</span>
      </div>
      <div className="text-[12px] text-fg-mute leading-relaxed">{children}</div>
    </section>
  );
}

function Combo({ k }: { k: string }) {
  return (
    <kbd
      className="ph-mono"
      style={{
        fontSize: 10.5,
        padding: '1.5px 6px',
        borderRadius: 5,
        background: 'var(--surface-2)',
        border: '.5px solid var(--border-strong)',
        color: 'var(--fg-strong)',
        whiteSpace: 'nowrap',
      }}
    >
      {k}
    </kbd>
  );
}
