import { useEffect, useState } from 'react';
import { I, PanelHead, PhButton, useToast } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { relativeTimeAgo } from '@shared/lib/date';

/**
 * About / diagnostics panel. Real values pulled from the backend:
 *   - app version + OS target
 *   - where data + logs are written
 *   - whether the OS keyring is active or the fallback in-memory store
 *   - a tail of the most recent log file for quick triage
 *
 * No more "v1.2.0 · build 4421" placeholders.
 */
interface Diagnostics {
  version: string;
  buildTarget: string;
  dataDir: string;
  logDir: string;
  secretBackend: string;
}

interface AnalyticsSummary {
  runs24h: number;
  runsTotal: number;
  tests24h: number;
  testsFailed24h: number;
  lastEventType?: string | null;
  lastEventAt?: string | null;
}

export function AboutPanel() {
  const toast = useToast();
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [usage, setUsage] = useState<AnalyticsSummary | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [reloading, setReloading] = useState(false);

  const reloadLogs = async () => {
    setReloading(true);
    try {
      const lines = await invokeCommand<string[]>('get_recent_logs', { lines: 200 });
      setLogs(lines);
    } catch (e) {
      toast.err(String(e), 'Could not read logs');
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    invokeCommand<Diagnostics>('get_diagnostics').then(setDiag).catch(() => {});
    invokeCommand<AnalyticsSummary>('get_analytics_summary').then(setUsage).catch(() => {});
  }, []);

  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    toast.ok(`${label} copied`);
  };

  const openExternal = (url: string) =>
    invokeCommand<void>('open_url', { url }).catch((e) =>
      toast.err(String(e), 'Could not open link')
    );

  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        title="About VibePrompter"
        hint="Build info, where your data lives, and a tail of the rolling log file."
      />

      <div className="grid grid-cols-2 gap-3">
        <div
          className="rounded-lg p-4 flex items-center justify-between"
          style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
        >
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
              Version
            </div>
            <div className="text-[16px] font-semibold text-fg-strong mt-1 ph-mono">
              {diag ? diag.version : '…'}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.sparkles size={11} />}
              onClick={() => window.dispatchEvent(new Event('app:show-guide'))}
            >
              How it works
            </PhButton>
            <PhButton
              size="sm"
              variant="ghost"
              onClick={() => window.dispatchEvent(new Event('app:show-changelog'))}
            >
              What's new
            </PhButton>
          </div>
        </div>
        <InfoCard label="Platform" value={diag ? diag.buildTarget : '…'} />
      </div>

      {usage && (
        <div className="grid grid-cols-4 gap-3">
          <InfoCard label="Runs / 24h" value={String(usage.runs24h)} />
          <InfoCard label="Runs total" value={String(usage.runsTotal)} />
          <InfoCard
            label="Tests / 24h"
            value={
              usage.tests24h === 0
                ? '0'
                : `${usage.tests24h - usage.testsFailed24h}/${usage.tests24h} ok`
            }
          />
          <InfoCard
            label="Last event"
            value={
              usage.lastEventType
                ? `${usage.lastEventType}\n${relativeTimeAgo(usage.lastEventAt)}`
                : '—'
            }
          />
        </div>
      )}

      <section
        className="rounded-lg p-4 flex items-start gap-3"
        style={{
          background: 'var(--surface)',
          border: '.5px solid var(--accent-tint-2)',
        }}
      >
        <span
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{
            background: 'var(--accent-tint)',
            color: 'var(--accent)',
          }}
        >
          <I.info size={14} />
        </span>
        <div className="flex-1 min-w-0 text-[12px] text-fg-mute leading-relaxed">
          <div className="text-[12.5px] font-semibold text-fg-strong mb-1">
            Your data stays local
          </div>
          VibePrompter is fully offline-first. Nothing — settings, history, prompts,
          analytics — leaves your machine except your prompts going to whichever LLM
          vendor you configured (using <em>your</em> API key, billed by them, not us).
          The counts above are computed from your local SQLite history. No telemetry
          server. No accounts. Open-source so you can verify.
          <div className="mt-3">
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.upload size={11} />}
              onClick={() =>
                invokeCommand<void>('open_url', {
                  url: 'https://github.com/SkyThonk/VibePrompter/blob/main/PRIVACY.md',
                }).catch((e) => toast.err(String(e), 'Could not open link'))
              }
            >
              Privacy Policy
            </PhButton>
          </div>
        </div>
      </section>

      <section
        className="rounded-lg p-4 flex items-start gap-3"
        style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
      >
        <span
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--accent-tint)', color: 'var(--accent)' }}
        >
          <I.star size={14} />
        </span>
        <div className="flex-1 min-w-0 text-[12px] text-fg-mute leading-relaxed">
          <div className="text-[12.5px] font-semibold text-fg-strong mb-1">
            VibePrompter is open source — contributions welcome
          </div>
          Hit a bug, want a feature, or fancy improving the code? The project lives on
          GitHub. Star it to follow along, open an issue, or send a pull request —
          every bit helps.
          <div className="mt-3 flex flex-wrap gap-2">
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.star size={11} />}
              onClick={() => openExternal('https://github.com/SkyThonk/VibePrompter')}
            >
              Star on GitHub
            </PhButton>
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.info size={11} />}
              onClick={() =>
                openExternal('https://github.com/SkyThonk/VibePrompter/issues/new')
              }
            >
              Report an issue
            </PhButton>
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.code size={11} />}
              onClick={() =>
                openExternal(
                  'https://github.com/SkyThonk/VibePrompter/blob/main/CONTRIBUTING.md'
                )
              }
            >
              Contributing guide
            </PhButton>
          </div>
        </div>
      </section>

      <Section title="Storage">
        <Row
          label="Data directory"
          value={diag?.dataDir ?? ''}
          onCopy={copy}
          onOpen={() =>
            invokeCommand<void>('open_app_folder', { which: 'data' }).catch((e) =>
              toast.err(String(e), 'Could not open folder')
            )
          }
        />
        <Row
          label="Log directory"
          value={diag?.logDir ?? ''}
          onCopy={copy}
          onOpen={() =>
            invokeCommand<void>('open_app_folder', { which: 'log' }).catch((e) =>
              toast.err(String(e), 'Could not open folder')
            )
          }
        />
        <Row
          label="Secret store"
          value={diag?.secretBackend ?? ''}
          hint="API keys live here. The OS keyring is per-user-encrypted by the platform."
        />
      </Section>

      <Section
        title="Recent logs"
        action={
          <div className="flex gap-1.5">
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.refresh size={12} />}
              onClick={reloadLogs}
              disabled={reloading}
            >
              {reloading ? 'Reading…' : 'Reload'}
            </PhButton>
            <PhButton
              size="sm"
              variant="ghost"
              onClick={() => setLogsOpen((v) => !v)}
            >
              {logsOpen ? 'Hide' : 'Show'}
            </PhButton>
          </div>
        }
      >
        {logsOpen && (
          <pre
            className="ph-mono"
            style={{
              margin: 0,
              padding: 12,
              maxHeight: 320,
              overflow: 'auto',
              fontSize: 11,
              lineHeight: 1.5,
              color: 'var(--fg)',
              background: 'var(--bg-2)',
              border: '.5px solid var(--border)',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {logs.length === 0
              ? 'Press Reload to fetch the last 200 lines.'
              : logs.join('\n')}
          </pre>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="m-0 text-[12px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
          {title}
        </h3>
        {action}
      </div>
      <div
        className="flex flex-col"
        style={{ background: 'var(--surface)', border: '.5px solid var(--border)', borderRadius: 10 }}
      >
        {children}
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-lg p-4"
      style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
    >
      <div className="text-[10.5px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
        {label}
      </div>
      <div
        className="text-[14px] font-semibold text-fg-strong mt-1 ph-mono"
        style={{ whiteSpace: 'pre-line', wordBreak: 'break-word' }}
      >
        {value}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  onCopy,
  onOpen,
}: {
  label: string;
  value: string;
  hint?: string;
  onCopy?: (label: string, value: string) => void;
  onOpen?: () => void;
}) {
  return (
    <div
      className="px-4 py-3 flex items-center gap-3"
      style={{ borderTop: '.5px solid var(--divider)' }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-fg-strong font-medium">{label}</div>
        <div className="text-[11.5px] text-fg-dim mt-0.5 ph-mono truncate">{value || '—'}</div>
        {hint && <div className="text-[11px] text-fg-dim mt-1">{hint}</div>}
      </div>
      {onOpen && value && (
        <PhButton size="sm" variant="ghost" onClick={onOpen} icon={<I.upload size={11} />}>
          Open
        </PhButton>
      )}
      {onCopy && value && (
        <PhButton size="sm" variant="ghost" onClick={() => onCopy(label, value)}>
          Copy
        </PhButton>
      )}
    </div>
  );
}
