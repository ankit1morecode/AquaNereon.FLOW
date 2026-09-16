import { findScenario } from '../data/SyntheticFlowSource';
import { QUALITY_LEVELS, type QualityLevel } from '../sim/SimulationEngine';
import { useVizStore, type SourceMode } from '../store';
import { PlaybackBar } from './PlaybackBar';

/**
 * Scenario selection, manual branch control and playback.
 *
 * Kept to the smallest set of controls that lets someone test the claim the
 * scene is making: pick a condition, or set the two branch flows yourself and
 * watch what the ring does about it.
 */

const MODES: { id: SourceMode; label: string; key: string }[] = [
  { id: 'NORMAL', label: 'Normal', key: 'Q' },
  { id: 'DRIFT', label: 'Flow drift', key: 'W' },
  { id: 'DISTURBANCE', label: 'Disturbance', key: 'E' },
  { id: 'MANUAL', label: 'Manual', key: 'R' },
];

const QUALITIES: QualityLevel[] = ['low', 'medium', 'high'];

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  accent,
  decimals = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  accent?: string;
  decimals?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider" style={accent ? { ['--accent' as string]: accent } : undefined}>
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">
        {value.toFixed(decimals)}
        <em>{unit}</em>
      </span>
    </label>
  );
}

export function ControlBar({ externalLabel }: { externalLabel?: string }) {
  const mode = useVizStore((s) => s.mode);
  const setMode = useVizStore((s) => s.setMode);
  const manual = useVizStore((s) => s.manual);
  const setManual = useVizStore((s) => s.setManual);
  const quality = useVizStore((s) => s.quality);
  const setQuality = useVizStore((s) => s.setQuality);
  const recording = useVizStore((s) => s.recording);
  const setRecording = useVizStore((s) => s.setRecording);

  const external = Boolean(externalLabel);
  const caption = external
    ? `Driven by an external source: ${externalLabel}. Scenario selection is disabled while a live feed is attached.`
    : mode === 'MANUAL'
      ? null
      : findScenario(mode).caption;

  return (
    <div className="control-bar">
      <div className="mode-row">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={!external && m.id === mode ? 'mode active' : 'mode'}
            onClick={() => setMode(m.id)}
            disabled={external}
            title={`${m.label}  (${m.key})`}
          >
            {m.label}
          </button>
        ))}
        <span className="spacer" />
        <button
          className={recording.active ? 'ghost recording' : 'ghost'}
          onClick={() =>
            setRecording({ active: !recording.active, frames: 0, seconds: 0 })
          }
          title="Capture the condition stream to a JSON file that can be replayed later"
        >
          {recording.active
            ? `Recording ${recording.seconds.toFixed(0)}s`
            : 'Record'}
        </button>
      </div>

      {caption && <p className="caption">{caption}</p>}

      {mode === 'MANUAL' && !external && (
        <div className="slider-row">
          <Slider
            label="Inlet A"
            value={manual.flowA}
            min={0}
            max={24}
            step={0.5}
            unit="L/s"
            accent="#2fd8ff"
            onChange={(v) => setManual({ flowA: v })}
          />
          <Slider
            label="Inlet B"
            value={manual.flowB}
            min={0}
            max={24}
            step={0.5}
            unit="L/s"
            accent="#ff9a4d"
            onChange={(v) => setManual({ flowB: v })}
          />
          <Slider
            label="Restriction"
            value={manual.restriction}
            min={0}
            max={0.8}
            step={0.05}
            unit=""
            decimals={2}
            accent="#ff5f7a"
            onChange={(v) => setManual({ restriction: v })}
          />
          <Slider
            label="Sensor noise"
            value={manual.noiseLevel}
            min={0}
            max={1}
            step={0.02}
            unit=""
            decimals={2}
            accent="#9aa7b4"
            onChange={(v) => setManual({ noiseLevel: v })}
          />
        </div>
      )}

      <PlaybackBar />

      <div className="quality-row">
        <span className="quality-label">Tracers</span>
        {QUALITIES.map((q) => (
          <button
            key={q}
            className={q === quality ? 'chip active' : 'chip'}
            onClick={() => setQuality(q)}
            title={`${QUALITY_LEVELS[q].toLocaleString()} particles`}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
