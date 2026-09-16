import { useEffect, useRef } from 'react';
import type { CircumferentialFeatures } from '../../types';

/**
 * The circumferential distribution, as a polar plot.
 *
 * This is the platform's view of the same object the 3D module draws around
 * the pipe: the 16 channel readings normalised to unit mean, against the
 * stored baseline. It is the flow fingerprint, and it is deliberately shown
 * raw rather than reduced to a score — the dossier's first architectural rule
 * is that the ring must not be collapsed to one scalar too early (§2).
 *
 * Drawn on a canvas because it redraws continuously and nothing about it
 * benefits from being in the React tree.
 */

export interface CircumferentialProfileProps {
  features: CircumferentialFeatures;
  baseline?: number[];
  size?: number;
  /** Show the mode-1 vector: which way the pattern leans, and how hard. */
  showAsymmetryVector?: boolean;
  caption?: string;
}

export function CircumferentialProfile({
  features,
  baseline,
  size = 196,
  showAsymmetryVector = true,
  caption,
}: CircumferentialProfileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const rBase = size * 0.27;
    const rScale = size * 0.17;
    const inner = size * 0.08;

    const dist = features.distribution_vector;
    const n = dist.length;
    if (n === 0) return;

    // Reference circle at unit mean, so "even" has a shape to be compared to.
    ctx.strokeStyle = 'rgba(120,160,185,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rBase, 0, Math.PI * 2);
    ctx.stroke();

    // Stored baseline outline.
    if (baseline && baseline.length === n) {
      ctx.strokeStyle = 'rgba(150,180,200,0.45)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const k = i % n;
        const a = (k / n) * Math.PI * 2 - Math.PI / 2;
        const r = rBase + (baseline[k] - 1) * rScale;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Channel bars, coloured by which side of the baseline they fall.
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const v = dist[i];
      const r = rBase + (v - 1) * rScale;
      const ref = baseline?.[i] ?? 1;
      ctx.strokeStyle = v >= ref ? 'rgba(255,209,102,0.95)' : 'rgba(55,208,240,0.85)';
      ctx.lineWidth = Math.max(3, size * 0.026);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
      ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      ctx.stroke();
    }

    // Outline, so the pattern reads as one figure rather than 16 sticks.
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

    if (showAsymmetryVector && features.asymmetry > 0.004) {
      const a = features.mode1_phase - Math.PI / 2;
      const len = Math.min(features.asymmetry * size * 1.5, size * 0.33);
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

    // Channel 1 marker, so the plot can be tied back to a pod on the hardware.
    ctx.fillStyle = 'rgba(140,175,195,0.8)';
    ctx.font = `${Math.round(size * 0.05)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('01', cx, cy - rBase - rScale - 4);
  }, [features, baseline, size, showAsymmetryVector]);

  return (
    <div className="circ-profile">
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
        aria-label="Circumferential channel distribution against baseline"
      />
      <dl className="circ-stats">
        <div>
          <dt>Asymmetry</dt>
          <dd>{features.asymmetry.toFixed(3)}</dd>
        </div>
        <div>
          <dt>Sector imbalance</dt>
          <dd>{features.sector_imbalance.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Mode 1</dt>
          <dd>{features.modes[0].toFixed(3)}</dd>
        </div>
        <div>
          <dt>Mode 2</dt>
          <dd>{features.modes[1].toFixed(3)}</dd>
        </div>
        <div>
          <dt>Mode 3</dt>
          <dd>{features.modes[2].toFixed(3)}</dd>
        </div>
        <div>
          <dt>Spatial gradient</dt>
          <dd>{features.spatial_gradient.toFixed(3)}</dd>
        </div>
      </dl>
      {caption && <p className="circ-caption">{caption}</p>}
    </div>
  );
}
