import { useEffect, useRef } from 'react';
import { useVizStore } from '../store';

/**
 * The flow fingerprint, drawn exactly as the ring reports it.
 *
 * Sixteen radial bars, one per channel, against the dashed baseline ring. This
 * is not a chart of a derived metric — it is the distribution vector itself,
 * which is the thing the whole assembly exists to produce. A balanced junction
 * draws a circle; a displaced core draws a lobe; a broken-down one draws
 * something that will not sit still.
 */

const SIZE = 168;

export function FingerprintDial() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readout = useVizStore((s) => s.readout);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== SIZE * dpr) {
      canvas.width = SIZE * dpr;
      canvas.height = SIZE * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const rBase = 46;
    const rScale = 30;

    const dist = readout.distribution;
    const base = readout.baselineDistribution;
    if (!dist.length) return;
    const n = dist.length;

    // Baseline ring.
    ctx.strokeStyle = 'rgba(140,170,190,0.4)';
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const a = (k / n) * Math.PI * 2 - Math.PI / 2;
      const r = rBase + ((base[k] ?? 1) - 1) * rScale;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Live channel bars.
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const v = dist[i];
      const r = rBase + (v - 1) * rScale;
      const inner = 14;

      const above = v >= (base[i] ?? 1);
      ctx.strokeStyle = above ? 'rgba(255,209,102,0.95)' : 'rgba(55,208,240,0.85)';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
      ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      ctx.stroke();
    }

    // Live outline, so the shape of the pattern reads as one figure.
    ctx.strokeStyle = 'rgba(230,248,255,0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const a = (k / n) * Math.PI * 2 - Math.PI / 2;
      const r = rBase + (dist[k] - 1) * rScale;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    // Asymmetry vector: which way the pattern leans, and how hard.
    if (readout.asymmetry > 0.004) {
      const a = readout.mode1Phase - Math.PI / 2;
      const len = Math.min(readout.asymmetry * 260, 56);
      ctx.strokeStyle = 'rgba(255,95,122,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + len * Math.cos(a), cy + len * Math.sin(a));
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,95,122,0.95)';
      ctx.beginPath();
      ctx.arc(cx + len * Math.cos(a), cy + len * Math.sin(a), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(160,190,208,0.75)';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }, [readout]);

  return (
    <div className="dial">
      <canvas ref={canvasRef} style={{ width: SIZE, height: SIZE }} />
      <div className="dial-caption">
        <span>FLOW FINGERPRINT</span>
        <small>16 circumferential channels vs. baseline</small>
      </div>
    </div>
  );
}
