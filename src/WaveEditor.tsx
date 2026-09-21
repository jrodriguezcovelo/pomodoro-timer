import { useEffect, useRef, useState } from "react";
import { Button, ContentSwitcher, Select, SelectItem, Switch, Toggle } from "@carbon/react";
import NumField from "./NumField";

/** Un canal = una onda (o un wavetable) dibujado por el usuario. */
export interface WaveChannel {
  enabled: boolean;
  points: number[];
  /** Volumen relativo del canal (0-1). */
  gain: number;
  /** Desafinado en cents, aplicado por oscilador. */
  detune: number;
  /** Desfase en grados. */
  phase: number;
  /** Oscilador 3D tipo wavetable: usa `frames` + `wtPos`. */
  is3d: boolean;
  /** Wavetable: ondas apiladas en profundidad (máx. MAX_FRAMES). */
  frames: number[][];
  /** Posición en el wavetable (0-1): interpola entre frames. */
  wtPos: number;
}

/** Muestras por periodo. */
export const WAVE_POINTS = 32;
/** Frames máximos del wavetable. */
export const MAX_FRAMES = 8;

const N = WAVE_POINTS;
const L = N / 2 + 1; // armónicos que Web Audio necesita (hasta Nyquist)
const W = 600;
const H = 200;
const PAD = 10;

// Proyección isométrica del wavetable: cada frame se aleja arriba-derecha.
const FDX = 18;
const FDY = -9;
const X03 = 70;
const SPAN3 = W - 2 * X03 - (MAX_FRAMES - 1) * FDX;
const Y03 = H / 2 + 30;
const AMP3 = 34;

const SHAPES: Record<string, (i: number) => number> = {
  sine: (i) => Math.sin((2 * Math.PI * i) / N),
  square: (i) => (i < N / 2 ? 1 : -1),
  triangle: (i) => 4 * Math.abs(i / N - 0.5) - 1,
  saw: (i) => 1 - (2 * i) / N,
};

function shapePoints(name: keyof typeof SHAPES): number[] {
  return Array.from({ length: N }, (_, i) => SHAPES[name](i));
}

function normPoints(points: number[] | undefined): number[] {
  return Array.from({ length: N }, (_, i) => points?.[i] ?? 0);
}

const clamp = (v: number, min = -1, max = 1) => Math.min(max, Math.max(min, v));

export function defaultWaveChannels(): WaveChannel[] {
  return Array.from({ length: 4 }, (_, c) => ({
    enabled: c === 0,
    points: shapePoints("sine"),
    gain: 1,
    detune: 0,
    phase: 0,
    is3d: false,
    frames: [],
    wtPos: 0,
  }));
}

function normalize(channels: WaveChannel[]): WaveChannel[] {
  return Array.from({ length: 4 }, (_, c) => {
    const src = channels[c];
    const is3d = src?.is3d ?? false;
    let frames = (src?.frames ?? []).map(normPoints).slice(0, MAX_FRAMES);
    let points = normPoints(src?.points);
    if (is3d) {
      if (frames.length === 0) frames = [points.slice()];
      points = frames[0];
    }
    return {
      enabled: src?.enabled ?? false,
      points,
      gain: src?.gain ?? 1,
      detune: src?.detune ?? 0,
      phase: src?.phase ?? 0,
      is3d,
      frames,
      wtPos: clamp(src?.wtPos ?? 0, 0, 1),
    };
  });
}

// Frame que suena: interpolación lineal entre los dos frames que rodean wtPos.
export function frameAt(ch: WaveChannel): number[] {
  if (!ch.is3d || !ch.frames?.length) return ch.points;
  const last = ch.frames.length - 1;
  const pos = clamp(ch.wtPos ?? 0, 0, 1) * last;
  const i = Math.floor(pos);
  const j = Math.min(last, i + 1);
  const t = pos - i;
  return ch.frames[i].map((v, k) => v + (ch.frames[j][k] - v) * t);
}

// Serie de Fourier (DFT) de la onda/frame que suena en cada canal. La fase va
// dentro de los coeficientes; la suma de canales da la onda final.
export function waveCoefficients(channels: WaveChannel[]): {
  real: Float32Array;
  imag: Float32Array;
} {
  const real = new Float32Array(L);
  const imag = new Float32Array(L);
  for (const ch of channels) {
    if (!ch.enabled) continue;
    const pts = frameAt(ch);
    const gain = ch.gain ?? 1;
    const phi = ((ch.phase ?? 0) * Math.PI) / 180;
    for (let k = 1; k < L; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const x = pts[n] ?? 0;
        const a = (2 * Math.PI * k * n) / N;
        re += x * Math.cos(a);
        im += x * Math.sin(a);
      }
      re *= (2 / N) * gain;
      im *= (2 / N) * gain;
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

export function buildPeriodicWave(ctx: AudioContext, channels: WaveChannel[]): PeriodicWave {
  const { real, imag } = waveCoefficients(channels);
  // Sin normalizar para conservar la ganancia relativa entre canales.
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

// Autocomprobación en dev: la DFT (+ desfase) debe reconstruir la onda dibujada.
if (import.meta.env.DEV) {
  const src = shapePoints("sine");
  let maxErr = 0;
  for (const phase of [0, 90, 217]) {
    const { real, imag } = waveCoefficients([
      { enabled: true, points: src, gain: 1, detune: 0, phase, is3d: false, frames: [], wtPos: 0 },
    ]);
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
  // El morph de wavetable a mitad de camino debe caer justo entre dos frames.
  const a = shapePoints("square");
  const b = shapePoints("saw");
  const mid = frameAt({
    enabled: true, points: a, gain: 1, detune: 0, phase: 0,
    is3d: true, frames: [a, b], wtPos: 0.5,
  });
  maxErr = Math.max(...mid.map((v, n) => Math.abs(v - (a[n] + b[n]) / 2)), maxErr);
  if (maxErr > 1e-9) console.error(`WaveEditor self-check failed: error ${maxErr}`);
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
  const [frameIdx, setFrameIdx] = useState(0);

  useEffect(() => {
    if (dragging.current) return;
    const next = normalize(channels);
    draftRef.current = next;
    setDraft(next);
  }, [channels]);

  useEffect(() => {
    setFrameIdx(0);
  }, [active]);

  // Arrastrar no guarda en cada movimiento; se confirma al soltar (commit=true).
  const update = (next: WaveChannel[], commit: boolean) => {
    draftRef.current = next;
    setDraft(next);
    if (commit) onChange(next);
  };

  const patchActive = (patch: Partial<WaveChannel>, commit: boolean) =>
    update(
      draftRef.current.map((c, i) => (i === active ? { ...c, ...patch } : c)),
      commit,
    );

  const setPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    const y = ((clientY - r.top) / r.height) * H;
    const ch = draftRef.current[active];
    if (ch.is3d) {
      const frames = ch.frames.length ? ch.frames : [ch.points];
      const f = Math.min(frameIdx, frames.length - 1);
      const i = Math.min(N - 1, Math.max(0, Math.floor(((x - X03 - f * FDX) / SPAN3) * N)));
      const v = clamp((Y03 + f * FDY - y) / AMP3);
      const next = frames.map((fr, k) =>
        k === f ? fr.map((p, pi) => (pi === i ? v : p)) : fr,
      );
      patchActive({ frames: next, points: next[0] }, false);
    } else {
      const i = Math.min(N - 1, Math.max(0, Math.floor((x / W) * N)));
      const v = clamp((H / 2 - y) / (H / 2 - PAD));
      patchActive({ points: ch.points.map((p, pi) => (pi === i ? v : p)) }, false);
    }
  };

  const flat = (points: number[]) =>
    [...points, points[0]]
      .map((v, i) => `${((i / N) * W).toFixed(1)},${(H / 2 - v * (H / 2 - PAD)).toFixed(1)}`)
      .join(" ");

  // Frame `f` proyectado en isométrico (x = fase, y = amplitud, z = profundidad).
  const plane = (points: number[], f: number) =>
    [...points, points[0]]
      .map((v, i) => {
        const x = X03 + (i / N) * SPAN3 + f * FDX;
        const y = Y03 - v * AMP3 + f * FDY;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const ch = draft[active];
  const frames = ch.frames.length ? ch.frames : [ch.points];
  const fi = Math.min(frameIdx, frames.length - 1);
  const playedF = clamp(ch.wtPos ?? 0, 0, 1) * (frames.length - 1);

  const applyShape = (pts: number[]) => {
    const c = draftRef.current[active];
    if (c.is3d) {
      const next = (c.frames.length ? c.frames : [c.points]).map((fr, k) => (k === fi ? pts : fr));
      patchActive({ enabled: true, frames: next, points: next[0] }, true);
    } else {
      patchActive({ enabled: true, points: pts }, true);
    }
  };

  const addFrame = () => {
    const c = draftRef.current[active];
    const cur = c.frames.length ? c.frames : [c.points];
    if (cur.length >= MAX_FRAMES) return;
    const copy = cur[Math.min(fi, cur.length - 1)].slice();
    const next = [...cur, copy];
    patchActive({ frames: next, points: next[0] }, true);
    setFrameIdx(next.length - 1);
  };

  const removeFrame = () => {
    const c = draftRef.current[active];
    if (c.frames.length <= 1) return;
    const next = c.frames.filter((_, k) => k !== fi);
    patchActive({ frames: next, points: next[0] }, true);
    setFrameIdx(Math.max(0, fi - 1));
  };

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

        {/* Canales no activos: onda que suena (plana). */}
        {draft.map((c, i) =>
          c.enabled && i !== active ? (
            <polyline key={i} points={flat(frameAt(c))} className="wave-line" />
          ) : null,
        )}

        {/* Canal 3D: mapa isométrico del wavetable. */}
        {ch.enabled && ch.is3d && (
          <>
            {frames.map((f, i) => (
              <polyline
                key={i}
                points={plane(f, i)}
                className="wave-line"
                style={{ opacity: frames.length > 1 ? 0.6 - 0.35 * (i / (frames.length - 1)) : 0.6 }}
              />
            ))}
            {/* Frame que suena (posición WT interpolada). */}
            <polyline points={plane(frameAt(ch), playedF)} className="wave-line wave-line-active" />
            {frames[fi].map((v, i) => (
              <circle
                key={i}
                cx={X03 + (i / N) * SPAN3 + fi * FDX}
                cy={Y03 - v * AMP3 + fi * FDY}
                r={3}
                className="wave-handle"
              />
            ))}
          </>
        )}

        {/* Canal normal: onda 2D editable. */}
        {ch.enabled && !ch.is3d && (
          <>
            <polyline points={flat(ch.points)} className="wave-line wave-line-active" />
            {ch.points.map((v, i) => (
              <circle
                key={i}
                cx={(i / N) * W}
                cy={H / 2 - v * (H / 2 - PAD)}
                r={3}
                className="wave-handle"
              />
            ))}
          </>
        )}
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
          onToggle={(t) => patchActive({ enabled: t }, true)}
        />
        <Toggle
          id="wave-channel-3d"
          labelText="Oscilador 3D (wavetable)"
          toggled={ch.is3d}
          onToggle={(t) => {
            const c = draftRef.current[active];
            const f = c.frames.length ? c.frames : [c.points.slice()];
            patchActive({ is3d: t, frames: f }, true);
          }}
        />
        <Select
          id="wave-shape"
          labelText="Forma base"
          value=""
          onChange={(e) => {
            const shape = e.target.value;
            if (SHAPES[shape]) applyShape(shapePoints(shape));
          }}
        >
          <SelectItem value="" text="Elegir…" />
          <SelectItem value="sine" text="Seno" />
          <SelectItem value="square" text="Cuadrada" />
          <SelectItem value="triangle" text="Triangular" />
          <SelectItem value="saw" text="Sierra" />
        </Select>
        <Button kind="ghost" size="sm" onClick={() => applyShape(new Array(N).fill(0))}>
          Limpiar
        </Button>
        <NumField label="Ganancia" min={0} max={1} decimals={2} value={ch.gain} onChange={(n) => patchActive({ gain: n }, true)} />
        <NumField label="Detune (cents)" min={-100} max={100} value={ch.detune} onChange={(n) => patchActive({ detune: n }, true)} />
        <NumField label="Fase (°)" min={0} max={360} value={ch.phase} onChange={(n) => patchActive({ phase: n }, true)} />
        {ch.is3d && (
          <>
            <Select
              id="wave-frame"
              labelText={`Frame a editar (${frames.length}/${MAX_FRAMES})`}
              value={String(fi)}
              onChange={(e) => setFrameIdx(Number(e.target.value))}
            >
              {frames.map((_, i) => (
                <SelectItem key={i} value={String(i)} text={`Frame ${i + 1}`} />
              ))}
            </Select>
            <Button kind="ghost" size="sm" disabled={frames.length >= MAX_FRAMES} onClick={addFrame}>
              Añadir frame
            </Button>
            <Button kind="ghost" size="sm" disabled={frames.length <= 1} onClick={removeFrame}>
              Borrar frame
            </Button>
            <NumField label="Posición WT" min={0} max={1} decimals={2} value={ch.wtPos} onChange={(n) => patchActive({ wtPos: n }, true)} />
          </>
        )}
      </div>
      <p className="wave-hint">
        Arrastra sobre el lienzo para dibujar el canal activo. En modo 3D, cada frame es una onda del
        wavetable y «Posición WT» interpola entre ellas.
      </p>
    </div>
  );
}
