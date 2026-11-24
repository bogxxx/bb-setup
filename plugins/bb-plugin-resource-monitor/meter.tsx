import type { Sample } from "./shared";

type Reading = { label: string; percent: number | null; detail: string };

const GIB = 1024 ** 3;
const gb = (bytes: number) => (bytes / GIB).toFixed(1);

/** CPU, RAM, and GPU in the order every view shows them. */
function readings(sample: Sample | null): Reading[] {
  const { cpu, memory, gpu } = sample ?? {};
  return [
    {
      label: "CPU",
      percent: cpu?.percent ?? null,
      detail: cpu ? `${cpu.model} · ${cpu.coreCount} cores` : "",
    },
    {
      label: "RAM",
      percent: memory ? (100 * memory.usedBytes) / memory.totalBytes : null,
      detail: memory
        ? `${gb(memory.usedBytes)} of ${gb(memory.totalBytes)} GB`
        : "",
    },
    {
      label: "GPU",
      percent: gpu?.percent ?? null,
      detail: gpu === null ? "Not reported" : (gpu?.name ?? ""),
    },
  ];
}

/** High load tints a fill; normal load keeps the text color. */
function tint(percent: number | null): string | undefined {
  if (percent === null || percent < 85) return undefined;
  return percent < 95 ? "var(--warning)" : "var(--destructive)";
}

const fill = (percent: number | null) =>
  Math.min(100, Math.max(0, percent ?? 0));

/** Three bars in a 16×16 viewBox: CPU, RAM, GPU. */
export function MeterBars({ sample }: { sample: Sample | null }) {
  return readings(sample).map(({ label, percent }, index) => {
    const height = Math.max(1, (14 * fill(percent)) / 100);
    const x = 1.5 + index * 5;
    return (
      <g key={label}>
        <rect x={x} y={1} width={3} height={14} rx={1} opacity={0.25} />
        <rect
          x={x}
          y={15 - height}
          width={3}
          height={height}
          rx={1}
          fill={tint(percent)}
        />
      </g>
    );
  });
}

/** A column per resource: the percent, a thin bar, the label. */
export function LoadColumns({
  sample,
  details = false,
}: {
  sample: Sample | null;
  details?: boolean;
}) {
  return readings(sample).map(({ label, percent, detail }) => (
    <div key={label} className="rm-column">
      <span className="rm-value" style={{ color: tint(percent) }}>
        {percent === null ? "—" : `${Math.round(percent)}%`}
      </span>
      <span className="rm-bar">
        <i style={{ width: `${fill(percent)}%`, background: tint(percent) }} />
      </span>
      <span className="rm-label">{label}</span>
      {details && <span className="rm-detail">{detail}</span>}
    </div>
  ));
}

/** "now", "5 min ago", "3 h ago", "2 d ago" for an epoch-ms time. */
export function ago(at: number | null, now = Date.now()) {
  if (!at) return "never";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** The hover card's line for one machine: its name, then CPU, RAM, GPU. */
export function MachineRow({
  name,
  sample,
  note,
}: {
  name: string;
  sample: Sample | null;
  /** Shown in place of the numbers, as for an offline machine. */
  note?: string;
}) {
  return (
    <div className="rm-row" data-muted={note ? "" : undefined}>
      <span className="rm-row-name">{name}</span>
      {note ? (
        <span className="rm-row-note">{note}</span>
      ) : (
        readings(sample).map(({ label, percent }) => (
          <span key={label} className="rm-row-cell" title={label}>
            <span className="rm-row-value" style={{ color: tint(percent) }}>
              {percent === null ? "—" : `${Math.round(percent)}%`}
            </span>
            <span className="rm-bar">
              <i
                style={{ width: `${fill(percent)}%`, background: tint(percent) }}
              />
            </span>
          </span>
        ))
      )}
    </div>
  );
}
