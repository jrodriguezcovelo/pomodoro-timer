import { useRef } from "react";

export interface MidiNote {
  time: number;
  duration: number;
  midi: number;
}

interface MidiPreviewProps {
  notes: MidiNote[];
  duration: number;
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
}

export default function MidiPreview({ notes, duration, from, to, onChange }: MidiPreviewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ mode: "from" | "to" | "move"; startX: number; from: number; to: number } | null>(
    null,
  );

  const W = 1000;
  const H = 140;
  const minWindow = Math.min(1, duration);
  const maxWindow = Math.min(10, duration);

  if (!duration) return null;

  // Limita el número de rects dibujados para no ralentizar el modal.
  const step = notes.length > 1500 ? Math.ceil(notes.length / 1500) : 1;
  const drawn = step > 1 ? notes.filter((_, i) => i % step === 0) : notes;

  const midis = notes.map((n) => n.midi);
  const minMidi = midis.length ? Math.min(...midis) : 48;
  const maxMidi = midis.length ? Math.max(...midis) : 84;
  const midiRange = Math.max(1, maxMidi - minMidi);
  const innerH = H - 12;
  const bandH = Math.max(2, innerH / midiRange);

  const timeToX = (t: number) => (t / duration) * W;
  const yFor = (m: number) => 6 + (1 - (m - minMidi) / midiRange) * innerH;
  const timeAt = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * duration;
  };
  const clampPos = (t: number, length: number) =>
    Math.min(Math.max(t, 0), Math.max(0, duration - length));

  const onMove = (clientX: number) => {
    const d = dragRef.current;
    if (!d) return;
    const t = timeAt(clientX);
    if (d.mode === "from") {
      const lo = Math.max(0, to - maxWindow);
      const hi = Math.max(0, to - minWindow);
      onChange(Math.min(hi, Math.max(lo, t)), to);
    } else if (d.mode === "to") {
      const lo = Math.min(duration, from + minWindow);
      const hi = Math.min(duration, from + maxWindow);
      onChange(from, Math.min(hi, Math.max(lo, t)));
    } else {
      const length = d.to - d.from;
      const nf = clampPos(d.from + (t - timeAt(d.startX)), length);
      onChange(nf, nf + length);
    }
  };

  const pointerProps = (mode: "from" | "to" | "move") => ({
    onPointerDown: (e: React.PointerEvent<SVGRectElement>) => {
      dragRef.current = { mode, startX: e.clientX, from, to };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.stopPropagation();
    },
    onPointerMove: (e: React.PointerEvent<SVGRectElement>) => onMove(e.clientX),
    onPointerUp: () => {
      dragRef.current = null;
    },
    onPointerCancel: () => {
      dragRef.current = null;
    },
  });

  return (
    <svg
      ref={svgRef}
      className="midi-preview"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onPointerDown={(e) => {
        // Clic fuera de la ventana: mueve la ventana hasta esa posición.
        const t = timeAt(e.clientX);
        const length = to - from;
        const nf = clampPos(t, length);
        onChange(nf, nf + length);
      }}
    >
      {drawn.map((n, i) => (
        <rect
          key={i}
          x={timeToX(n.time)}
          y={yFor(n.midi)}
          width={Math.max(2, (n.duration / duration) * W)}
          height={bandH}
          fill="var(--cds-interactive)"
          opacity={0.7}
        />
      ))}
      <rect
        x={timeToX(from)}
        y={0}
        width={Math.max(0, timeToX(to) - timeToX(from))}
        height={H}
        fill="var(--cds-interactive)"
        opacity={0.15}
        style={{ cursor: "grab" }}
        {...pointerProps("move")}
      />
      <rect
        x={timeToX(from) - 4}
        y={0}
        width={8}
        height={H}
        fill="var(--cds-interactive)"
        style={{ cursor: "ew-resize" }}
        {...pointerProps("from")}
      />
      <rect
        x={timeToX(to) - 4}
        y={0}
        width={8}
        height={H}
        fill="var(--cds-interactive)"
        style={{ cursor: "ew-resize" }}
        {...pointerProps("to")}
      />
    </svg>
  );
}
