import { useEffect, useRef } from 'react';
import type { SimulationEngine } from '../sim/SimulationEngine';
import { HISTORY_SECONDS } from '../sim/SignatureHistory';

/**
 * The fingerprint over time.
 *
 * Channels run vertically, time runs left to right, and each cell is one
 * channel's reading relative to the ring mean. It is the raw sensor record,
 * not a derived statistic — the same 16 numbers the dial shows, stacked into
 * the past.
 *
 * This is what makes drift legible. A single frame of a drifting junction
 * looks almost like a healthy one; thirty seconds of frames show a band
 * walking steadily around the ring, which is unmistakable and is exactly the
 * evidence the software dossier asks an event to carry. A disturbance instead
 * shows the pattern shearing and tearing as the core precesses.
 *
 * Drawn on a canvas from the engine's history ring, outside React, because it
 * updates continuously and nothing about it needs reconciliation.
 */

const WIDTH = 236;
const HEIGHT = 96;
/** Redraws per second. The history itself is sampled at HISTORY_HZ. */
const REDRAW_HZ = 12;

/** Cold -> neutral -> hot, matching the sensor pods and the dial. */
function rampColor(v: number, out: [number, number, number]): void {
  // v is the channel value relative to the ring mean, so 1.0 is "even".
  const t = Math.max(0, Math.min(1, (v - 0.7) / 0.6));
  if (t < 0.5) {
    const k = t * 2;
    out[0] = 18 + (55 - 18) * k;
    out[1] = 58 + (208 - 58) * k;
    out[2] = 82 + (240 - 82) * k;
  } else {
    const k = (t - 0.5) * 2;
    out[0] = 55 + (255 - 55) * k;
    out[1] = 208 + (209 - 208) * k;
    out[2] = 240 + (102 - 240) * k;
  }
}

export function FingerprintWaterfall({ engine }: { engine: SimulationEngine }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // This lives outside the Canvas, so it drives itself rather than riding
  // r3f's frame loop. One pixel per (sample, channel), scaled up by CSS, which
  // keeps the per-frame work proportional to the data and not to the display
  // size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const history = engine.history;
    const cols = history.capacity;
    const rows = history.channels;

    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const image = ctx.createImageData(cols, rows);
    const data = image.data;
    const rgb: [number, number, number] = [0, 0, 0];
    let frame = 0;
    let last = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < 1000 / REDRAW_HZ) return;
      last = now;

      const n = history.length;
      // Oldest sample on the left, newest on the right, with the unfilled part
      // of the buffer left dark so a short run reads as a short run.
      const offset = cols - n;

      for (let x = 0; x < cols; x++) {
        const index = x - offset;
        for (let y = 0; y < rows; y++) {
          const p = (y * cols + x) * 4;
          if (index < 0) {
            data[p] = 8;
            data[p + 1] = 14;
            data[p + 2] = 20;
            data[p + 3] = 255;
            continue;
          }
          rampColor(history.channelAt(index, y), rgb);
          data[p] = rgb[0];
          data[p + 1] = rgb[1];
          data[p + 2] = rgb[2];
          data[p + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [engine]);

  return (
    <div className="waterfall">
      <canvas
        ref={canvasRef}
        style={{ width: WIDTH, height: HEIGHT }}
        aria-label="Circumferential channel readings over time"
      />
      <div className="waterfall-axes">
        <span>CH 1</span>
        <span>CH 16</span>
      </div>
      <div className="waterfall-caption">
        <span>FINGERPRINT · LAST {HISTORY_SECONDS}s</span>
        <small>channel vs. time · older left</small>
      </div>
    </div>
  );
}
