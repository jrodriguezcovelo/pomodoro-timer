import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ActionableNotification,
  Button,
  Checkbox,
  ContentSwitcher,
  IconButton,
  Modal,
  Select,
  SelectItem,
  Stack,
  Switch,
  TextInput,
  Theme,
  Toggle,
} from "@carbon/react";
import {
  Add,
  DocumentImport,
  ListChecked,
  Moon,
  Pause,
  Play,
  Reset,
  Save,
  Settings,
  StopFilled,
  Sun,
  TrashCan,
  VolumeUp,
} from "@carbon/icons-react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Midi } from "@tonejs/midi";
import MidiPreview from "./MidiPreview";
import WaveEditor, { buildPeriodicWave, defaultWaveChannels, WaveChannel } from "./WaveEditor";
import NumField from "./NumField";
import "./App.css";

type Mode = "focus" | "shortBreak" | "longBreak";

interface Task {
  id: string;
  text: string;
  done: boolean;
}

interface Note {
  id: string;
  freq: number;
  beats: number;
}

interface SavedMelody {
  id: string;
  name: string;
  tempo: number;
  wave: string;
  customWave?: WaveChannel[];
  melody: Note[];
}

interface MidiSound {
  id: string;
  name: string;
  data: string;
  from: number;
  to?: number | null;
}

interface Config {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  pomodorosUntilLong: number;
  theme: "white" | "g100";
  font: string;
  bgFocus: string;
  bgShort: string;
  bgLong: string;
  sound: string;
  tempo: number;
  wave: string;
  customWave: WaveChannel[];
  melody: Note[];
  savedMelodies: SavedMelody[];
  midiSounds: MidiSound[];
  tasks: Task[];
}

interface TimerState {
  mode: Mode;
  running: boolean;
  remainingSecs: number;
  pomodorosCompleted: number;
}

const DEFAULT_CONFIG: Config = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  pomodorosUntilLong: 3,
  theme: "g100",
  font: "default",
  bgFocus: "#0f62fe",
  bgShort: "#198038",
  bgLong: "#8a3ffc",
  sound: "beep",
  tempo: 120,
  wave: "sine",
  customWave: defaultWaveChannels(),
  melody: [
    { id: "1", freq: 261.63, beats: 1 },
    { id: "2", freq: 293.66, beats: 1 },
    { id: "3", freq: 329.63, beats: 1 },
    { id: "4", freq: 392.0, beats: 2 },
  ],
  savedMelodies: [],
  midiSounds: [],
  tasks: [],
};

const FONTS: Record<string, string> = {
  default: "'IBM Plex Sans', system-ui, sans-serif",
  mono: "'IBM Plex Mono', monospace",
  serif: "'IBM Plex Serif', serif",
  digital: "'Orbitron', monospace",
};

const MODE_LABELS: Record<Mode, string> = {
  focus: "Enfoque",
  shortBreak: "Descanso corto",
  longBreak: "Descanso largo",
};

const MODE_INDEX: Record<Mode, number> = {
  focus: 0,
  shortBreak: 1,
  longBreak: 2,
};

const NOTE_FREQS = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];
const NOTE_BEATS = [0.5, 1, 1.5, 2];

function randomNote(): Note {
  return {
    id: crypto.randomUUID(),
    freq: NOTE_FREQS[Math.floor(Math.random() * NOTE_FREQS.length)],
    beats: NOTE_BEATS[Math.floor(Math.random() * NOTE_BEATS.length)],
  };
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// --- audio idempotente: un solo contexto activo, detenible ---
let activeCtx: AudioContext | null = null;
let activeEndTimer: ReturnType<typeof setTimeout> | null = null;
let onActiveEnd: (() => void) | null = null;

function stopAudio() {
  if (activeEndTimer !== null) {
    clearTimeout(activeEndTimer);
    activeEndTimer = null;
  }
  if (activeCtx) {
    activeCtx.close().catch(() => {});
    activeCtx = null;
  }
  const cb = onActiveEnd;
  onActiveEnd = null;
  if (cb) cb();
}

function beginAudio(): AudioContext {
  stopAudio();
  const ctx = new AudioContext();
  activeCtx = ctx;
  return ctx;
}

function endAudioAfter(total: number, onEnd?: () => void) {
  onActiveEnd = onEnd ?? null;
  activeEndTimer = setTimeout(() => stopAudio(), (total + 0.3) * 1000);
}

// Reproduce un MIDI completo de forma directa: todas las pistas con su tiempo y
// polifonía. Cada pista usa una onda distinta para mantener canales separados.
function playMidiData(
  data: string,
  onEnd?: () => void,
  from = 0,
  to?: number,
  trackIndex?: number,
) {
  const ctx = beginAudio();
  const midi = new Midi(base64ToBytes(data));
  const waves: OscillatorType[] = ["sine", "triangle", "square", "sawtooth"];
  midi.tracks.forEach((track, i) => {
    if (trackIndex !== undefined && i !== trackIndex) return;
    const wave = waves[i % waves.length];
    for (const n of track.notes) {
      if (n.time < from) continue;
      if (to !== undefined && n.time > to) continue;
      tone(ctx, midiToFreq(n.midi), wave, n.time - from, n.duration);
    }
  });
  endAudioAfter((to ?? midi.duration) - from + 0.5, onEnd);
}

function fmt(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

type Wave = OscillatorType | PeriodicWave;

function tone(
  ctx: AudioContext,
  freq: number,
  wave: Wave,
  start: number,
  dur: number,
  gainVal = 0.2,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  if (typeof wave === "string") osc.type = wave as OscillatorType;
  else osc.setPeriodicWave(wave);
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(gainVal, ctx.currentTime + start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}

// Dos osciladores desafinados y paneados L/R: da amplitud estéreo al tono.
function toneWide(
  ctx: AudioContext,
  freq: number,
  wave: Wave,
  start: number,
  dur: number,
  gainVal = 0.16,
  detuneCents = 0,
) {
  const make = (detune: number, pan: number, gainVal: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    if (typeof wave === "string") osc.type = wave as OscillatorType;
    else osc.setPeriodicWave(wave);
    osc.frequency.value = freq;
    osc.detune.value = detune;
    panner.pan.value = pan;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(gainVal, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    osc.connect(gain).connect(panner).connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur + 0.05);
  };
  make(-6 + detuneCents, -0.5, gainVal);
  make(6 + detuneCents, 0.5, gainVal);
}

// Onda personalizada: un oscilador por canal, con su ganancia y detune. El
// desfase va dentro de los coeficientes (buildPeriodicWave); el wavetable 3D ya
// viene interpolado por frameAt(), así que aquí no hay nada especial.
function toneChannels(
  ctx: AudioContext,
  freq: number,
  channels: WaveChannel[],
  start: number,
  dur: number,
) {
  const active = channels.filter((c) => c.enabled);
  if (active.length === 0) return;
  const gain = 0.16 / active.length;
  for (const ch of active) {
    toneWide(ctx, freq, buildPeriodicWave(ctx, [ch]), start, dur, gain, ch.detune ?? 0);
  }
}

function playSound(cfg: Config, onEnd?: () => void) {
  if (cfg.sound === "none") return;
  if (cfg.sound.startsWith("midi:")) {
    const id = cfg.sound.slice(5);
    const found = cfg.midiSounds.find((m) => m.id === id);
    if (found) {
      playMidiData(found.data, onEnd, found.from || 0, found.to ?? undefined);
      return;
    }
  }
  const ctx = beginAudio();
  let total = 1.2;
  switch (cfg.sound) {
    case "double":
      tone(ctx, 880, "sine", 0, 0.18);
      tone(ctx, 660, "sine", 0.22, 0.25);
      break;
    case "chime":
      tone(ctx, 523.25, "sine", 0, 0.4);
      tone(ctx, 659.25, "sine", 0.15, 0.4);
      tone(ctx, 783.99, "sine", 0.3, 0.5);
      break;
    case "success":
      tone(ctx, 523.25, "triangle", 0, 0.2);
      tone(ctx, 659.25, "triangle", 0.18, 0.2);
      tone(ctx, 783.99, "triangle", 0.36, 0.2);
      tone(ctx, 1046.5, "triangle", 0.54, 0.5);
      break;
    case "custom": {
      const spb = 60 / Math.max(1, cfg.tempo);
      let t = 0;
      for (const note of cfg.melody) {
        const dur = Math.max(0.05, note.beats) * spb;
        if (cfg.wave === "custom") toneChannels(ctx, note.freq, cfg.customWave, t, dur);
        else toneWide(ctx, note.freq, cfg.wave as OscillatorType, t, dur);
        t += dur;
      }
      total = t + 0.2;
      break;
    }
    case "beep":
    default:
      tone(ctx, 880, "sine", 0, 0.35);
      break;
  }
  endAudioAfter(total, onEnd);
}

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications not available */
  }
}

interface UpdateInfo {
  latest: string;
  url: string;
}

const GITHUB_REPO = "jrodriguezcovelo/pomodoro-timer";

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const current = await getVersion();
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`);
    if (!res.ok) return null;
    const releases: { tag_name?: string; html_url?: string; draft?: boolean }[] = await res.json();
    let best: UpdateInfo | null = null;
    for (const r of releases) {
      if (r.draft) continue;
      const tag = r.tag_name;
      const url = r.html_url;
      if (!tag || !url) continue;
      if (!best || isNewer(tag, best.latest)) best = { latest: tag, url };
    }
    if (!best) return null;
    if (isNewer(best.latest, current)) return best;
  } catch {
    /* sin conexión o API bloqueada */
  }
  return null;
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [waveEditorOpen, setWaveEditorOpen] = useState(false);
  const [newTask, setNewTask] = useState("");
  const [melodyName, setMelodyName] = useState("");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const [midiPending, setMidiPending] = useState<{
    data: string;
    duration: number;
    tempo: number;
    name: string;
    mode: "editor" | "sound";
    tracks: { time: number; duration: number; midi: number }[][];
    notes: { time: number; duration: number; midi: number }[];
  } | null>(null);
  const [midiFrom, setMidiFrom] = useState(0);
  const [midiTo, setMidiTo] = useState(10);
  const [selectedTrack, setSelectedTrack] = useState(0);
  const [playing, setPlaying] = useState<"preview" | "midi" | null>(null);
  const lastTickRef = useRef<TimerState | null>(null);
  const configRef = useRef<Config | null>(null);
  const midiInputRef = useRef<HTMLInputElement>(null);
  const midiSoundInputRef = useRef<HTMLInputElement>(null);

  const save = useCallback(async (cfg: Config) => {
    setConfig(cfg);
    await invoke("save_config", { config: cfg });
  }, []);

  const applyTimer = useCallback((t: TimerState) => {
    lastTickRef.current = t;
    setTimer(t);
  }, []);

  useEffect(() => {
    (async () => {
      const [cfg, t] = await Promise.all([
        invoke<Config>("get_config"),
        invoke<TimerState>("get_timer"),
      ]);
      setConfig(cfg);
      applyTimer(t);
    })();
  }, [applyTimer]);

  useEffect(() => {
    const id = setInterval(async () => {
      const t = await invoke<TimerState>("tick");
      const prev = lastTickRef.current;
      if (prev) {
        if (t.pomodorosCompleted > prev.pomodorosCompleted) {
          notify("¡Pomodoro completado!", "Hora de un descanso");
          if (configRef.current) playSound(configRef.current);
        } else if (t.mode !== prev.mode) {
          notify("Descanso terminado", "¡A enfocarse de nuevo!");
          if (configRef.current) playSound(configRef.current);
        }
      }
      applyTimer(t);
    }, 500);
    return () => clearInterval(id);
  }, [applyTimer]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    checkForUpdate().then((u) => {
      if (u) setUpdate(u);
    });
  }, []);

  useEffect(() => {
    if (!config) return;
    const root = document.documentElement;
    root.classList.remove("cds--white", "cds--g100", "cds--g10", "cds--g90");
    root.classList.add(config.theme === "g100" ? "cds--g100" : "cds--white");
  }, [config?.theme]);

  if (!config || !timer) return null;

  const bg =
    timer.mode === "focus"
      ? config.bgFocus
      : timer.mode === "shortBreak"
        ? config.bgShort
        : config.bgLong;

  const start = async (mode: Mode) => applyTimer(await invoke<TimerState>("start_timer", { mode }));
  const pause = async () => applyTimer(await invoke<TimerState>("pause_timer"));
  const resume = async () => applyTimer(await invoke<TimerState>("resume_timer"));
  const reset = async () => applyTimer(await invoke<TimerState>("reset_timer"));

  const togglePreview = () => {
    if (playing === "preview") {
      stopAudio();
      setPlaying(null);
    } else {
      playSound(config, () => setPlaying(null));
      setPlaying("preview");
    }
  };

  const previewWave = () => {
    const ctx = beginAudio();
    toneChannels(ctx, 440, config.customWave, 0, 0.7);
    endAudioAfter(1.0);
  };

  const addNote = () => save({ ...config, melody: [...config.melody, randomNote()] });

  const updateNote = (id: string, note: Note) =>
    save({ ...config, melody: config.melody.map((m) => (m.id === id ? note : m)) });

  const removeNote = (id: string) =>
    save({ ...config, melody: config.melody.filter((m) => m.id !== id) });

  const saveMelody = () => {
    const name = melodyName.trim();
    if (!name) return;
    save({
      ...config,
      savedMelodies: [
        ...config.savedMelodies,
        {
          id: crypto.randomUUID(),
          name,
          tempo: config.tempo,
          wave: config.wave,
          customWave: config.customWave,
          melody: config.melody,
        },
      ],
    });
    setMelodyName("");
  };

  const loadMelody = (m: SavedMelody) =>
    save({
      ...config,
      tempo: m.tempo,
      wave: m.wave,
      customWave: m.customWave?.length ? m.customWave : config.customWave,
      melody: m.melody,
    });

  const removeMelody = (id: string) =>
    save({ ...config, savedMelodies: config.savedMelodies.filter((m) => m.id !== id) });

  const handleMidiFile = async (file: File, mode: "editor" | "sound") => {
    try {
      const buf = await file.arrayBuffer();
      const midi = new Midi(buf);
      const tempo = midi.header.tempos[0]?.bpm ?? 120;
      const tracks = midi.tracks.map((t) =>
        t.notes.map((n) => ({
          time: n.time,
          duration: n.duration,
          midi: n.midi,
        })),
      );
      const notes = tracks.flat();
      const first = tracks.findIndex((t) => t.length > 0);
      setSelectedTrack(first >= 0 ? first : 0);
      setMidiPending({
        data: bufToBase64(buf),
        duration: midi.duration,
        tempo,
        name: file.name.replace(/\.(mid|midi)$/i, ""),
        mode,
        tracks,
        notes,
      });
      setMidiFrom(0);
      setMidiTo(Math.min(10, midi.duration));
    } catch {
      setMidiPending(null);
    }
  };

  const confirmMidi = () => {
    if (!midiPending) return;
    const { data, tempo, name, mode } = midiPending;
    const from = midiFrom;
    const to = Math.max(midiTo, from);
    if (mode === "sound") {
      const sound: MidiSound = {
        id: crypto.randomUUID(),
        name,
        data,
        from,
        to,
      };
      save({ ...config, midiSounds: [...config.midiSounds, sound], sound: `midi:${sound.id}` });
    } else {
      const track = midiPending.tracks[selectedTrack] ?? [];
      const melody = track
        .filter((n) => n.time >= from && n.time < to)
        .sort((a, b) => a.time - b.time)
        .map((n) => ({
          id: crypto.randomUUID(),
          freq: Math.round(midiToFreq(n.midi) * 100) / 100,
          beats: Math.min(32, Math.max(0.125, Math.round((n.duration * tempo) / 60 * 1000) / 1000)),
        }));
      setMidiPending(null);
      if (melody.length === 0) return;
      save({ ...config, tempo: Math.round(tempo * 100) / 100, melody });
    }
    setMidiPending(null);
  };

  const toggleAudition = () => {
    if (!midiPending) return;
    if (playing === "midi") {
      stopAudio();
      setPlaying(null);
    } else {
      playMidiData(
        midiPending.data,
        () => setPlaying(null),
        midiFrom,
        midiTo,
        midiPending.mode === "editor" ? selectedTrack : undefined,
      );
      setPlaying("midi");
    }
  };

  const removeMidiSound = (id: string) =>
    save({
      ...config,
      midiSounds: config.midiSounds.filter((m) => m.id !== id),
      sound: config.sound === `midi:${id}` ? "beep" : config.sound,
    });

  const manualCheck = async () => {
    setUpdateStatus("Comprobando…");
    const u = await checkForUpdate();
    if (u) {
      setUpdate(u);
      setUpdateStatus(`Hay una nueva versión disponible (${u.latest}).`);
    } else {
      setUpdateStatus("Estás en la última versión.");
    }
  };

  const addTask = () => {
    const text = newTask.trim();
    if (!text) return;
    save({
      ...config,
      tasks: [...config.tasks, { id: crypto.randomUUID(), text, done: false }],
    });
    setNewTask("");
  };

  const toggleTask = (id: string) =>
    save({
      ...config,
      tasks: config.tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    });

  const removeTask = (id: string) =>
    save({ ...config, tasks: config.tasks.filter((t) => t.id !== id) });

  return (
    <Theme theme={config.theme}>
      {update && (
        <div className="update-toast">
          <ActionableNotification
            kind="info"
            title="Actualización disponible"
            subtitle={`Nueva versión: ${update.latest}`}
            actionButtonLabel="Ver release"
            onActionButtonClick={() => openUrl(update.url)}
            onClose={() => setUpdate(null)}
            inline
          />
        </div>
      )}
      <div className="app" style={{ background: bg }}>
        <header className="topbar">
          <ContentSwitcher
            size="lg"
            selectedIndex={MODE_INDEX[timer.mode]}
            onChange={({ name }) => name && start(name as Mode)}
          >
            <Switch name="focus" text="Enfoque" />
            <Switch name="shortBreak" text="Descanso" />
            <Switch name="longBreak" text="Largo" />
          </ContentSwitcher>

          <div className="topbar-actions">
            <IconButton
              kind="ghost"
              label={config.theme === "g100" ? "Tema claro" : "Tema oscuro"}
              onClick={() => save({ ...config, theme: config.theme === "g100" ? "white" : "g100" })}
            >
              {config.theme === "g100" ? <Sun /> : <Moon />}
            </IconButton>
            <IconButton kind="ghost" label="Ajustes" onClick={() => setSettingsOpen(true)}>
              <Settings />
            </IconButton>
          </div>
        </header>

        <main className="center">
          <p className="mode-label">{MODE_LABELS[timer.mode]}</p>
          <div className="timer" style={{ fontFamily: FONTS[config.font] ?? FONTS.default }}>
            {fmt(timer.remainingSecs)}
          </div>
          <div className="controls">
            <Button
              kind="primary"
              size="lg"
              renderIcon={timer.running ? Pause : Play}
              onClick={() => (timer.running ? pause() : resume())}
            >
              {timer.running ? "Pausar" : "Iniciar"}
            </Button>
            <Button kind="secondary" size="lg" renderIcon={Reset} onClick={reset}>
              Reiniciar
            </Button>
          </div>
        </main>

        <section className="tasks">
          <h3 className="tasks-title">
            <ListChecked size={20} /> Tareas
          </h3>
          {config.tasks.length === 0 ? (
            <p className="tasks-empty">Sin tareas. Agrega una para empezar.</p>
          ) : (
            <ul className="task-list">
              {config.tasks.map((t) => (
                <li key={t.id} className="task-item">
                  <Checkbox
                    id={`task-${t.id}`}
                    checked={t.done}
                    onChange={() => toggleTask(t.id)}
                    labelText={<span className={t.done ? "task-done" : undefined}>{t.text}</span>}
                  />
                  <IconButton
                    kind="ghost"
                    size="sm"
                    align="bottom-end"
                    label="Eliminar tarea"
                    onClick={() => removeTask(t.id)}
                  >
                    <TrashCan />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <div className="task-add">
            <TextInput
              id="new-task"
              labelText="Nueva tarea"
              hideLabel
              placeholder="Nueva tarea"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTask();
              }}
            />
            <Button kind="primary" renderIcon={Add} iconDescription="Agregar tarea" onClick={addTask}>
              Agregar
            </Button>
          </div>
        </section>

        <Modal
          open={settingsOpen}
          modalHeading="Ajustes"
          primaryButtonText="Listo"
          secondaryButtonText="Cancelar"
          size="md"
          onRequestSubmit={() => {
            setSettingsOpen(false);
            setWaveEditorOpen(false);
            setMidiPending(null);
            stopAudio();
            setPlaying(null);
          }}
          onRequestClose={() => {
            setSettingsOpen(false);
            setWaveEditorOpen(false);
            setMidiPending(null);
            stopAudio();
            setPlaying(null);
          }}
        >
          <Stack gap={6}>
            <section>
              <h4 className="settings-title">Duración (minutos)</h4>
              <div className="row-3">
                <NumField
                  label="Enfoque"
                  min={1}
                  max={180}
                  value={config.focusMin}
                  onChange={(n) => save({ ...config, focusMin: n })}
                />
                <NumField
                  label="Descanso corto"
                  min={1}
                  max={180}
                  value={config.shortBreakMin}
                  onChange={(n) => save({ ...config, shortBreakMin: n })}
                />
                <NumField
                  label="Descanso largo"
                  min={1}
                  max={180}
                  value={config.longBreakMin}
                  onChange={(n) => save({ ...config, longBreakMin: n })}
                />
              </div>
            </section>

            <NumField
              label="Pomodoros hasta descanso largo"
              min={1}
              max={12}
              value={config.pomodorosUntilLong}
              onChange={(n) => save({ ...config, pomodorosUntilLong: n })}
            />

            <Toggle
              id="theme"
              labelText="Tema oscuro"
              toggled={config.theme === "g100"}
              onToggle={(t) => save({ ...config, theme: t ? "g100" : "white" })}
            />

            <Select
              id="font"
              labelText="Fuente del reloj"
              value={config.font}
              onChange={(e) => save({ ...config, font: e.target.value })}
            >
              <SelectItem value="default" text="IBM Plex Sans" />
              <SelectItem value="mono" text="IBM Plex Mono" />
              <SelectItem value="serif" text="IBM Plex Serif" />
              <SelectItem value="digital" text="Orbitron (digital)" />
            </Select>

            <section>
              <div className="sound-row">
                <div className="sound-select">
                  <Select
                    id="sound"
                    labelText="Sonido al terminar"
                    value={config.sound}
                    onChange={(e) => save({ ...config, sound: e.target.value })}
                  >
                    <SelectItem value="beep" text="Beep" />
                    <SelectItem value="double" text="Beep doble" />
                    <SelectItem value="chime" text="Campana" />
                    <SelectItem value="success" text="Éxito" />
                    <SelectItem value="custom" text="Personalizado" />
                    {config.midiSounds.map((m) => (
                      <SelectItem key={m.id} value={`midi:${m.id}`} text={`MIDI: ${m.name}`} />
                    ))}
                    <SelectItem value="none" text="Sin sonido" />
                  </Select>
                </div>
                <Button
                  kind="ghost"
                  size="sm"
                  renderIcon={playing === "preview" ? StopFilled : VolumeUp}
                  disabled={config.sound === "none"}
                  onClick={togglePreview}
                >
                  {playing === "preview" ? "Detener" : "Probar"}
                </Button>
              </div>

              <div className="midi-sounds">
                <Button
                  kind="ghost"
                  size="sm"
                  renderIcon={DocumentImport}
                  onClick={() => midiSoundInputRef.current?.click()}
                >
                  Añadir MIDI como sonido
                </Button>
                <input
                  ref={midiSoundInputRef}
                  type="file"
                  accept=".mid,.midi"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleMidiFile(file, "sound");
                    e.target.value = "";
                  }}
                />
                {config.midiSounds.length > 0 && (
                  <ul className="midi-list">
                    {config.midiSounds.map((m) => (
                      <li key={m.id} className="midi-item">
                        <Button
                          kind={config.sound === `midi:${m.id}` ? "primary" : "ghost"}
                          size="sm"
                          onClick={() => save({ ...config, sound: `midi:${m.id}` })}
                        >
                          {m.name}
                        </Button>
                        <IconButton
                          kind="ghost"
                          size="sm"
                          align="bottom-end"
                          label={`Eliminar ${m.name}`}
                          onClick={() => removeMidiSound(m.id)}
                        >
                          <TrashCan />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {config.sound === "custom" && (
                <div className="melody">
                  <div className="row-2">
                    <NumField
                      label="Tempo (BPM)"
                      min={20}
                      max={300}
                      value={config.tempo}
                      onChange={(n) => save({ ...config, tempo: n })}
                    />
                    <Select
                      id="wave"
                      labelText="Onda"
                      value={config.wave}
                      onChange={(e) => save({ ...config, wave: e.target.value })}
                    >
                      <SelectItem value="sine" text="Seno" />
                      <SelectItem value="square" text="Cuadrada" />
                      <SelectItem value="triangle" text="Triangular" />
                      <SelectItem value="sawtooth" text="Sierra" />
                      <SelectItem value="custom" text="Personalizada…" />
                    </Select>
                  </div>
                  {config.wave === "custom" && (
                    <div className="wave-open">
                      <Button kind="ghost" size="sm" onClick={() => setWaveEditorOpen(true)}>
                        Editar onda ({config.customWave.filter((c) => c.enabled).length} de 4 canales)
                      </Button>
                    </div>
                  )}
                  <div className="melody-head">
                    <span>Frecuencia (Hz)</span>
                    <span>Tiempos</span>
                    <span />
                  </div>
                  {config.melody.map((note) => (
                    <div key={note.id} className="melody-note">
                      <NumField
                        hideLabel
                        label="Frecuencia (Hz)"
                        min={20}
                        max={20000}
                        decimals={2}
                        value={note.freq}
                        onChange={(n) => updateNote(note.id, { ...note, freq: n })}
                      />
                      <NumField
                        hideLabel
                        label="Tiempos"
                        min={0.125}
                        max={32}
                        decimals={3}
                        value={note.beats}
                        onChange={(n) => updateNote(note.id, { ...note, beats: n })}
                      />
                      <IconButton
                        kind="ghost"
                        size="sm"
                        align="bottom-end"
                        label="Eliminar nota"
                        onClick={() => removeNote(note.id)}
                      >
                        <TrashCan />
                      </IconButton>
                    </div>
                  ))}
                  <div className="melody-actions">
                    <Button kind="ghost" size="sm" renderIcon={Add} onClick={addNote}>
                      Añadir nota
                    </Button>
                    <Button
                      kind="ghost"
                      size="sm"
                      renderIcon={DocumentImport}
                      onClick={() => midiInputRef.current?.click()}
                    >
                      Importar MIDI
                    </Button>
                    <input
                      ref={midiInputRef}
                      type="file"
                      accept=".mid,.midi"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleMidiFile(file, "editor");
                        e.target.value = "";
                      }}
                    />
                  </div>


                  <div className="melody-save">
                    <TextInput
                      id="melody-name"
                      labelText="Nombre de la melodía"
                      placeholder="Mi melodía"
                      value={melodyName}
                      onChange={(e) => setMelodyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveMelody();
                      }}
                    />
                    <Button kind="secondary" size="sm" renderIcon={Save} onClick={saveMelody}>
                      Guardar
                    </Button>
                  </div>
                  {config.savedMelodies.length > 0 && (
                    <ul className="melody-list">
                      {config.savedMelodies.map((m) => (
                        <li key={m.id} className="melody-item">
                          <Button kind="ghost" size="sm" onClick={() => loadMelody(m)}>
                            {m.name}
                          </Button>
                          <IconButton
                            kind="ghost"
                            size="sm"
                            align="bottom-end"
                            label={`Eliminar ${m.name}`}
                            onClick={() => removeMelody(m.id)}
                          >
                            <TrashCan />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            <section>
              <h4 className="settings-title">Color de fondo</h4>
              <div className="row-3">
                <label className="color-field">
                  <span>Enfoque</span>
                  <input
                    type="color"
                    value={config.bgFocus}
                    onChange={(e) => save({ ...config, bgFocus: e.target.value })}
                  />
                </label>
                <label className="color-field">
                  <span>Descanso corto</span>
                  <input
                    type="color"
                    value={config.bgShort}
                    onChange={(e) => save({ ...config, bgShort: e.target.value })}
                  />
                </label>
                <label className="color-field">
                  <span>Descanso largo</span>
                  <input
                    type="color"
                    value={config.bgLong}
                    onChange={(e) => save({ ...config, bgLong: e.target.value })}
                  />
                </label>
              </div>
            </section>

            <Button
              kind="ghost"
              size="sm"
              onClick={() => save({ ...DEFAULT_CONFIG, tasks: config.tasks })}
            >
              Restablecer valores
            </Button>

            <div className="update-check">
              <Button kind="secondary" size="sm" onClick={manualCheck}>
                Buscar actualizaciones
              </Button>
              {updateStatus && <span className="update-status">{updateStatus}</span>}
            </div>
          </Stack>
        </Modal>

        {midiPending && (
          <div className="midi-overlay">
            <div className="midi-dialog">
              <h4 className="midi-dialog-title">
                {midiPending.mode === "sound" ? "Añadir MIDI como sonido" : "Importar MIDI a melodía"}
              </h4>
              {midiPending.mode === "editor" && (
                <Select
                  id="midi-track"
                  labelText="Pista del MIDI"
                  value={String(selectedTrack)}
                  onChange={(e) => setSelectedTrack(Number(e.target.value))}
                >
                  {midiPending.tracks.map((t, i) => (
                    <SelectItem key={i} value={String(i)} text={`Pista ${i + 1} (${t.length} notas)`} />
                  ))}
                </Select>
              )}
              <MidiPreview
                notes={
                  midiPending.mode === "editor"
                    ? midiPending.tracks[selectedTrack] ?? []
                    : midiPending.notes
                }
                duration={midiPending.duration}
                from={midiFrom}
                to={midiTo}
                onChange={(f, t) => {
                  setMidiFrom(f);
                  setMidiTo(t);
                }}
              />
              <div className="midi-window-info">
                Desde {midiFrom.toFixed(1)}s · hasta {midiTo.toFixed(1)}s (ventana 1–10s)
              </div>
              <div className="midi-window-actions">
                <Button kind="secondary" size="sm" onClick={confirmMidi}>
                  {midiPending.mode === "sound" ? "Guardar sonido" : "Importar"}
                </Button>
                <Button
                  kind="ghost"
                  size="sm"
                  renderIcon={playing === "midi" ? StopFilled : Play}
                  onClick={toggleAudition}
                >
                  {playing === "midi" ? "Detener" : "Escuchar"}
                </Button>
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={() => {
                    setMidiPending(null);
                    stopAudio();
                    setPlaying(null);
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </div>
        )}

        {waveEditorOpen && (
          <div className="midi-overlay">
            <div className="midi-dialog">
              <h4 className="midi-dialog-title">Editor de onda personalizada</h4>
              <WaveEditor
                channels={config.customWave}
                onChange={(customWave) => save({ ...config, customWave })}
              />
              <div className="midi-window-actions">
                <Button kind="secondary" size="sm" onClick={() => setWaveEditorOpen(false)}>
                  Listo
                </Button>
                <Button kind="ghost" size="sm" renderIcon={VolumeUp} onClick={previewWave}>
                  Escuchar
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Theme>
  );
}

export default App;
