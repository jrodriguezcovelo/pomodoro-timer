// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::Instant,
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Mode {
    Focus,
    ShortBreak,
    LongBreak,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    text: String,
    done: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    freq: f64,
    beats: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SavedMelody {
    id: String,
    name: String,
    tempo: f64,
    wave: String,
    #[serde(default)]
    custom_wave: Vec<WaveChannel>,
    melody: Vec<Note>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MidiSound {
    id: String,
    name: String,
    data: String,
    #[serde(default)]
    from: f64,
    #[serde(default)]
    to: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WaveChannel {
    enabled: bool,
    points: Vec<f64>,
    #[serde(default = "default_gain")]
    gain: f64,
    #[serde(default)]
    detune: f64,
    #[serde(default)]
    phase: f64,
    #[serde(default)]
    is3d: bool,
}

fn default_gain() -> f64 {
    1.0
}

fn default_wave_channels() -> Vec<WaveChannel> {
    const N: usize = 32;
    (0..4)
        .map(|c| WaveChannel {
            enabled: c == 0,
            points: (0..N)
                .map(|i| (2.0 * std::f64::consts::PI * i as f64 / N as f64).sin())
                .collect(),
            gain: 1.0,
            detune: 0.0,
            phase: 0.0,
            is3d: false,
        })
        .collect()
}

fn default_tempo() -> f64 {
    120.0
}

fn default_wave() -> String {
    "sine".into()
}

fn default_melody() -> Vec<Note> {
    vec![
        Note { id: "1".into(), freq: 261.63, beats: 1.0 },
        Note { id: "2".into(), freq: 293.66, beats: 1.0 },
        Note { id: "3".into(), freq: 329.63, beats: 1.0 },
        Note { id: "4".into(), freq: 392.00, beats: 2.0 },
    ]
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Config {
    focus_min: u64,
    short_break_min: u64,
    long_break_min: u64,
    pomodoros_until_long: u32,
    theme: String,
    font: String,
    bg_focus: String,
    bg_short: String,
    bg_long: String,
    sound: String,
    #[serde(default = "default_tempo")]
    tempo: f64,
    #[serde(default = "default_wave")]
    wave: String,
    #[serde(default = "default_wave_channels")]
    custom_wave: Vec<WaveChannel>,
    #[serde(default = "default_melody")]
    melody: Vec<Note>,
    #[serde(default)]
    saved_melodies: Vec<SavedMelody>,
    #[serde(default)]
    midi_sounds: Vec<MidiSound>,
    tasks: Vec<Task>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            focus_min: 25,
            short_break_min: 5,
            long_break_min: 15,
            pomodoros_until_long: 3,
            theme: "g100".into(),
            font: "default".into(),
            bg_focus: "#0f62fe".into(),
            bg_short: "#198038".into(),
            bg_long: "#8a3ffc".into(),
            sound: "beep".into(),
            tempo: default_tempo(),
            wave: default_wave(),
            custom_wave: default_wave_channels(),
            melody: default_melody(),
            saved_melodies: vec![],
            midi_sounds: vec![],
            tasks: vec![],
        }
    }
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct TimerState {
    mode: Mode,
    running: bool,
    remaining_secs: u64,
    pomodoros_completed: u32,
}

struct TimerRuntime {
    mode: Mode,
    running: bool,
    /// Remaining seconds at the start of the current run (or current value when paused).
    remaining_secs: u64,
    started_at: Option<Instant>,
    pomodoros_completed: u32,
}

impl TimerRuntime {
    fn remaining(&self) -> u64 {
        if self.running {
            let elapsed = self.started_at.map(|s| s.elapsed().as_secs()).unwrap_or(0);
            self.remaining_secs.saturating_sub(elapsed)
        } else {
            self.remaining_secs
        }
    }
}

struct Inner {
    config: Config,
    timer: TimerRuntime,
}

impl Inner {
    /// Advance the timer if the current session has elapsed; auto-starts the next mode.
    fn tick(&mut self) {
        let t = &mut self.timer;
        if !t.running {
            return;
        }
        let elapsed = t.started_at.map(|s| s.elapsed().as_secs()).unwrap_or(0);
        if elapsed < t.remaining_secs {
            return;
        }
        let finished = t.mode;
        if finished == Mode::Focus {
            t.pomodoros_completed += 1;
        }
        t.mode = match finished {
            Mode::Focus => {
                if t.pomodoros_completed % self.config.pomodoros_until_long.max(1) == 0 {
                    Mode::LongBreak
                } else {
                    Mode::ShortBreak
                }
            }
            _ => Mode::Focus,
        };
        t.remaining_secs = duration_of(&self.config, t.mode);
        t.started_at = Some(Instant::now());
    }

    fn snapshot(&self) -> TimerState {
        TimerState {
            mode: self.timer.mode,
            running: self.timer.running,
            remaining_secs: self.timer.remaining(),
            pomodoros_completed: self.timer.pomodoros_completed,
        }
    }
}

fn duration_of(config: &Config, mode: Mode) -> u64 {
    match mode {
        Mode::Focus => config.focus_min * 60,
        Mode::ShortBreak => config.short_break_min * 60,
        Mode::LongBreak => config.long_break_min * 60,
    }
}

struct AppState(Mutex<Inner>);

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("config.json"))
        .map_err(|e| e.to_string())
}

fn load_config(app: &tauri::AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn persist_config(app: &tauri::AppHandle, config: &Config) {
    if let Ok(path) = config_path(app) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(config) {
            let _ = fs::write(path, json);
        }
    }
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.0.lock().unwrap().config.clone()
}

#[tauri::command]
fn save_config(state: State<AppState>, app: tauri::AppHandle, config: Config) -> Config {
    {
        let mut inner = state.0.lock().unwrap();
        inner.config = config.clone();
    }
    persist_config(&app, &config);
    config
}

#[tauri::command]
fn get_timer(state: State<AppState>) -> TimerState {
    state.0.lock().unwrap().snapshot()
}

#[tauri::command]
fn start_timer(state: State<AppState>, mode: Mode) -> TimerState {
    let mut inner = state.0.lock().unwrap();
    let dur = duration_of(&inner.config, mode);
    {
        let t = &mut inner.timer;
        t.mode = mode;
        t.running = true;
        t.remaining_secs = dur;
        t.started_at = Some(Instant::now());
    }
    inner.snapshot()
}

#[tauri::command]
fn pause_timer(state: State<AppState>) -> TimerState {
    let mut inner = state.0.lock().unwrap();
    let t = &mut inner.timer;
    if t.running {
        t.remaining_secs = t.remaining();
        t.running = false;
        t.started_at = None;
    }
    inner.snapshot()
}

#[tauri::command]
fn resume_timer(state: State<AppState>) -> TimerState {
    let mut inner = state.0.lock().unwrap();
    let t = &mut inner.timer;
    if !t.running {
        t.running = true;
        t.started_at = Some(Instant::now());
    }
    inner.snapshot()
}

#[tauri::command]
fn reset_timer(state: State<AppState>) -> TimerState {
    let mut inner = state.0.lock().unwrap();
    let dur = duration_of(&inner.config, inner.timer.mode);
    {
        let t = &mut inner.timer;
        t.running = false;
        t.started_at = None;
        t.remaining_secs = dur;
    }
    inner.snapshot()
}

#[tauri::command]
fn tick(state: State<AppState>) -> TimerState {
    let mut inner = state.0.lock().unwrap();
    inner.tick();
    inner.snapshot()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let config = load_config(app.handle());
            app.manage(AppState(Mutex::new(Inner {
                timer: TimerRuntime {
                    mode: Mode::Focus,
                    running: false,
                    remaining_secs: duration_of(&config, Mode::Focus),
                    started_at: None,
                    pomodoros_completed: 0,
                },
                config,
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_timer,
            start_timer,
            pause_timer,
            resume_timer,
            reset_timer,
            tick
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
