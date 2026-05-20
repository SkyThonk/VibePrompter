import { I } from '@shared/ui';

interface Step {
  n: string;
  label: string;
  done?: boolean;
  active?: boolean;
}

export function StepIndicator({ steps }: { steps: Step[] }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-fg-mute">
      {steps.map((s, i) => (
        <div key={s.n} className="contents">
          <StepDot {...s} />
          {i < steps.length - 1 && <StepLine done={s.done} />}
        </div>
      ))}
    </div>
  );
}

function StepDot({ n, label, active, done }: Step) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="w-[18px] h-[18px] rounded-full border-[0.5px] flex items-center justify-center text-[10.5px] font-semibold"
        style={{
          background: done ? 'var(--accent)' : active ? 'var(--accent-tint-2)' : 'var(--surface-2)',
          color: done ? '#ffffff' : active ? 'var(--accent)' : 'var(--fg-mute)',
          borderColor: active ? 'var(--accent)' : 'var(--border-strong)',
        }}
      >
        {done ? <I.check size={11} sw={2.4} /> : n}
      </span>
      <span style={{ color: active || done ? 'var(--fg)' : 'var(--fg-mute)' }}>{label}</span>
    </span>
  );
}

function StepLine({ done }: { done?: boolean }) {
  return (
    <span
      className="flex-1 h-px"
      style={{ background: done ? 'var(--accent)' : 'var(--border)' }}
    />
  );
}
