import { useEffect, useRef, useState } from "react";
import { Button, ContentSwitcher, Select, SelectItem, Switch, Toggle } from "@carbon/react";
import NumField from "./NumField";

/** Un canal = una onda dibujada por el usuario. */
export interface WaveChannel {
  enabled: boolean;
  points: number[];
  /** Volumen relativo del canal (0-1). */
  gain: number;
  /** Desafinado en cents, aplicado por oscilador. */
  detune: number;
  /** Desfase en grados. */
  phase: number;
  /** Canal 3D: estéreo en cuadratura (L/R) y mapa isométrico en el editor. */
  is3d: boolean;
}

/** Muestras por periodo. */
export const WAVE_POINTS = 32;

const N = WAVE_POINTS;
const L = N / 2 + 1; // armónicos que Web Audio necesita (hasta Nyquist)
const W = 600;
const H = 200;
const PAD = 10;
// Proyección isométrica del canal 3D: plano trasero desplazado arriba-derecha.
const D3X = 90;
const D3Y = -40;
const X03 = 110;
const SPAN3 = W - 2 * D3X - 40;
const AMP3 = (H / 2 - PAD) * 0.65;

const SHAPES: Record<string, (i: number) => number> = {
  sine: (i) => Math.sin((2 * Math.PI * i) / N),
  square: (i) => (i < N / 2 ? 1 : -1),
  triangle: (i) => 4 * Math.abs(i / N - 0.5) - 1,
  saw: (i) => 1 - (2 * i) / N,
};

function shapePoints(name: keyof typeof SHAPES): number[] {
  return Array.from({ length: N }, (_, i) => SHAPES[name](i));
}

export function defaultWaveChannels(): WaveChannel[] {
  return Array.from({ length: 4 }, (_, c) => ({
    enabled: c === 0,
    points: shapePoints("sine"),
    gain: 1,
    detune: 0,
    phase: 0,
    is3d: false,
  }));
}

function normalize(channels: WaveChannel[]): WaveChannel[] {
  return Array.from({ length: 4 }, (_, c) => ({
    enabled: channels[c]?.enabled ?? false,
    points: Array.from({ length: N }, (_, i) => channels[c]?.points?.[i] ?? 0),
    gain: channels[c]?.gain ?? 1,
    detune: channels[c]?.detune ?? 0,
    phase: channels[c]?.phase ?? 0,
    is3d: channels[c]?.is3d ?? false,
  }));
}

// Serie de Fourier de la onda dibujada (DFT). La suma de todos los canales
// activos da la onda final; Web Audio la normaliza por defecto.
export function waveCoefficients(channels: WaveChannel[]): {
  real: Float32Array;
  imag: Float32Array;
} {
  const real = new Float32Array(L);
  const imag = new Float32Array(L);
  for (const ch of channels) {
    if (!ch.enabled) continue;
    const gain = ch.gain ?? 1;
    const phi = ((ch.phase ?? 0) * Math.PI) / 180;
    for (let k = 1; k < L; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const x = ch.points[n] ?? 0;
        const a = (2 * Math.PI * k * n) / N;
        re += x * Math.cos(a);
        im += x * Math.sin(a);
      }
      re *= ((2 / N) * gain);
      im *= ((2 / N) * gain);
      // Desfase φ: rota cada armónico k por k·φ.
      const kp = k * phi;
      const c = Math.cos(kp);
      const s = Math.sin(kp);
      real[k] += re * c + im * s;
      imag[k] += -re * s + im * c;
    }
  }
  return { real, imag };
}

export function buildPeriodicWave(
  ctx: AudioContext,
  channels: WaveChannel[],
  extraPhase = 0,
): PeriodicWave {
  const shifted = extraPhase
    ? channels.map((c) => ({ ...c, phase: (c.phase ?? 0) + extraPhase }))
    : channels;
  const { real, imag } = waveCoefficients(shifted);
  // Sin normalizar para conservar la ganancia relativa entre canales.
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

// Misma DFT pero con desfase: se usa para el plano trasero del mapa 3D (cuadratura).
export function shiftPoints(points: number[], deg: number): number[] {
  const { real, imag } = waveCoefficients([
    { enabled: true, points, gain: 1, detune: 0, phase: deg, is3d: false },
  ]);
  return Array.from({ length: N }, (_, n) => {
    let v = 0;
    for (let k = 1; k < L; k++) {
      const a = (2 * Math.PI * k * n) / N;
      v += real[k] * Math.cos(a) + imag[k] * Math.sin(a);
    }
    return v;
  });
}

// Autocomprobación en dev: la DFT (+ desfase) debe reconstruir la onda dibujada.
if (import.meta.env.DEV) {
  const src = shapePoints("sine");
  let maxErr = 0;
  for (const phase of [0, 90, 217]) {
    const { real, imag } = waveCoefficients([{ enabled: true, points: src, gain: 1, detune: 0, phase, is3d: false }]);
    for (let n = 0; n < N; n++) {
      let v = 0;
      for (let k = 1; k < L; k++) {
        const a = (2 * Math.PI * k * n) / N;
        v += real[k] * Math.cos(a) + imag[k] * Math.sin(a);
      }
      const expected = Math.sin((2 * Math.PI * n) / N + (phase * Math.PI) / 180);
      maxErr = Math.max(maxErr, Math.abs(v - expected));
    }
  }
  const q = shiftPoints(src, 90);
  maxErr = Math.max(
    maxErr,
    ...q.map((v, n) => Math.abs(v - Math.cos((2 * Math.PI * n) / N))),
  );
  if (maxErr > 1e-6) console.error(`WaveEditor self-check failed: error ${maxErr}`);
}

export default function WaveEditor({
  channels,
  onChange,
}: {
  channels: WaveChannel[];
  onChange: (channels: WaveChannel[]) => void;
}) {
  const [draft, setDraft] = useState(() => normalize(channels));
  const draftRef = useRef(draft);
  const dragging = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (dragging.current) return;
    const next = normalize(channels);
    draftRef.current = next;
    setDraft(next);
  }, [channels]);

  // Arrastrar no guarda en cada movimiento; se confirma al soltar (commit=true).
  const update = (next: WaveChannel[], commit: boolean) => {
    draftRef.current = next;
    setDraft(next);
    if (commit) onChange(next);
  };

  const setPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const is3 = draftRef.current[active]?.is3d ?? false;
    const x0 = is3 ? X03 : 0;
    const span = is3 ? SPAN3 : W;
    const amp = is3 ? AMP3 : H / 2 - PAD;
    const x = ((clientX - r.left) / r.width) * W;
    const y = ((clientY - r.top) / r.height) * H;
    const i = Math.min(N - 1, Math.max(0, Math.floor(((x - x0) / span) * N)));
    const v = Math.min(1, Math.max(-1, (H / 2 - y) / amp));
    update(
      draftRef.current.map((c, ci) =>
        ci === active ? { ...c, points: c.points.map((p, pi) => (pi === i ? v : p)) } : c,
      ),
      false,
    );
  };

  const polyline = (points: number[]) =>
    [...points, points[0]]
      .map((v, i) => `${((i / N) * W).toFixed(1)},${(H / 2 - v * (H / 2 - PAD)).toFixed(1)}`)
      .join(" ");

  // Mapa isométrico: la onda en el plano frontal (layer 0) y su cuadratura (layer 1).
  const iso = (points: number[], layer: number) =>
    [...points, points[0]]
      .map((v, i) => {
        const t = i / N;
        return `${(X03 + t * SPAN3 + layer * D3X).toFixed(1)},${(
          H / 2 -
          v * AMP3 +
          layer * D3Y
        ).toFixed(1)}`;
      })
      .join(" ");

  const ribbon = (points: number[]) => {
    const front = [...points, points[0]].map((v, i) => [X03 + (i / N) * SPAN3, H / 2 - v * AMP3]);
    const back = [...points, points[0]].map((v, i) => [
      X03 + (i / N) * SPAN3 + D3X,
      H / 2 - v * AMP3 + D3Y,
    ]);
    return [...front, ...[...back].reverse()]
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
  };

  const ch = draft[active];

  return (
    <div className="wave-editor">
      <svg
        ref={svgRef}
        className="wave-canvas"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setPoint(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) setPoint(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
          onChange(draftRef.current);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          onChange(draftRef.current);
        }}
      >
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} className="wave-axis" />
        {draft.map((c, i) =>
          c.enabled && i !== active ? (
            <polyline key={i} points={polyline(c.points)} className="wave-line" />
          ) : null,
        )}
        {ch.enabled && ch.is3d && (
          <>
            <polygon points={ribbon(ch.points)} className="wave-3d-fill" />
            <polyline
              points={iso(shiftPoints(ch.points, 90), 1)}
              className="wave-line wave-line-back"
            />
            <polyline points={iso(ch.points, 0)} className="wave-line wave-line-active" />
          </>
        )}
        {ch.enabled && !ch.is3d && (
          <polyline points={polyline(ch.points)} className="wave-line wave-line-active" />
        )}
        {ch.enabled &&
          ch.points.map((v, i) => (
            <circle
              key={i}
              cx={ch.is3d ? X03 + (i / N) * SPAN3 : (i / N) * W}
              cy={ch.is3d ? H / 2 - v * AMP3 : H / 2 - v * (H / 2 - PAD)}
              r={3}
              className="wave-handle"
            />
          ))}
      </svg>

      <ContentSwitcher
        size="sm"
        selectedIndex={active}
        onChange={({ name }) => name && setActive(Number(name))}
      >
        {draft.map((c, i) => (
          <Switch key={i} name={String(i)} text={`Canal ${i + 1}${c.enabled ? "" : " (off)"}`} />
        ))}
      </ContentSwitcher>

      <div className="wave-editor-controls">
        <Toggle
          id="wave-channel-enabled"
          labelText="Activar canal"
          toggled={ch.enabled}
          onToggle={(t) =>
            update(
              draft.map((c, i) => (i === active ? { ...c, enabled: t } : c)),
              true,
            )
          }
        />
        <Toggle
          id="wave-channel-3d"
          labelText="Canal 3D (isométrico)"
          toggled={ch.is3d}
          onToggle={(t) =>
            update(
              draft.map((c, i) => (i === active ? { ...c, is3d: t } : c)),
              true,
            )
          }
        />
        <Select
          id="wave-shape"
          labelText="Forma base"
          value=""
          onChange={(e) => {
            const shape = e.target.value;
            if (!SHAPES[shape]) return;
            update(
              draft.map((c, i) =>
                i === active ? { ...c, enabled: true, points: shapePoints(shape) } : c,
              ),
              true,
            );
          }}
        >
          <SelectItem value="" text="Elegir…" />
          <SelectItem value="sine" text="Seno" />
          <SelectItem value="square" text="Cuadrada" />
          <SelectItem value="triangle" text="Triangular" />
          <SelectItem value="saw" text="Sierra" />
        </Select>
        <Button
          kind="ghost"
          size="sm"
          onClick={() =>
            update(
              draft.map((c, i) => (i === active ? { ...c, points: new Array(N).fill(0) } : c)),
              true,
            )
          }
        >
          Limpiar
        </Button>
        <NumField
          label="Ganancia"
          min={0}
          max={1}
          decimals={2}
          value={ch.gain}
          onChange={(n) =>
            update(
              draft.map((c, i) => (i === active ? { ...c, gain: n } : c)),
              true,
            )
          }
        />
        <NumField
          label="Detune (cents)"
          min={-100}
          max={100}
          value={ch.detune}
          onChange={(n) =>
            update(
              draft.map((c, i) => (i === active ? { ...c, detune: n } : c)),
              true,
            )
          }
        />
        <NumField
          label="Fase (°)"
          min={0}
          max={360}
          value={ch.phase}
          onChange={(n) =>
            update(
              draft.map((c, i) => (i === active ? { ...c, phase: n } : c)),
              true,
            )
          }
        />
      </div>
      <p className="wave-hint">
        Arrastra sobre el lienzo para dibujar el canal activo. Se suman todos los canales activos.
        En modo 3D el plano frontal es la onda y el trasero su cuadratura (va a cada oído).
      </p>
    </div>
  );
}
