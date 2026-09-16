import { useEffect } from 'react';
import { VIEWS } from '../scene/CameraRig';
import { useVizStore, TIME_SCALES, type SourceMode } from '../store';

/**
 * Keyboard control.
 *
 * Someone demonstrating this is talking while they drive it, and reaching for
 * a slider mid-sentence is worse than pressing a key. Every control that gets
 * used during an explanation has a single-key binding.
 *
 * Bindings are skipped while a form control has focus, so typing into a field
 * does not also scrub the timeline.
 */

export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Space', action: 'Pause / resume' },
  { keys: '1 – 4', action: 'Overview / junction / sensor ring / outlet view' },
  { keys: 'Q W E R', action: 'Normal / drift / disturbance / manual' },
  { keys: '← →', action: 'Step 2 s back / forward' },
  { keys: '[ ]', action: 'Slower / faster playback' },
  { keys: 'P S V L', action: 'Tracers / streamlines / vortex / labels' },
  { keys: 'M F H', action: 'Metrics / dial / history panels' },
  { keys: '?', action: 'This list' },
];

const MODE_KEYS: Record<string, SourceMode> = {
  q: 'NORMAL',
  w: 'DRIFT',
  e: 'DISTURBANCE',
  r: 'MANUAL',
};

const LAYER_KEYS = {
  p: 'particles',
  s: 'streamlines',
  v: 'vortexCore',
  l: 'labels',
} as const;

const PANEL_KEYS = {
  m: 'metrics',
  f: 'fingerprint',
  h: 'waterfall',
} as const;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  );
}

export function useKeyboard(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      const store = useVizStore.getState();
      const key = e.key.toLowerCase();
      let handled = true;

      // Camera presets on the number row.
      const viewIndex = Number(e.key) - 1;
      if (Number.isInteger(viewIndex) && viewIndex >= 0 && viewIndex < VIEWS.length) {
        store.setView(VIEWS[viewIndex].id);
      } else if (key in MODE_KEYS) {
        store.setMode(MODE_KEYS[key]);
      } else if (key in LAYER_KEYS) {
        store.toggleLayer(LAYER_KEYS[key as keyof typeof LAYER_KEYS]);
      } else if (key in PANEL_KEYS) {
        store.togglePanel(PANEL_KEYS[key as keyof typeof PANEL_KEYS]);
      } else if (e.key === ' ') {
        store.togglePaused();
      } else if (e.key === 'ArrowLeft') {
        store.requestSeek(Math.max(0, store.readout.elapsed - 2));
      } else if (e.key === 'ArrowRight') {
        store.requestSeek(store.readout.elapsed + 2);
      } else if (e.key === '[' || e.key === ']') {
        const scales = TIME_SCALES as readonly number[];
        const i = scales.indexOf(store.timeScale);
        const next = e.key === '[' ? Math.max(0, i - 1) : Math.min(scales.length - 1, i + 1);
        store.setTimeScale(scales[next === -1 ? 0 : next]);
      } else if (e.key === '?' || e.key === '/') {
        store.togglePanel('help');
      } else {
        handled = false;
      }

      if (handled) e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
