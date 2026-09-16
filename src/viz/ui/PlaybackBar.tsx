import { useVizStore, TIME_SCALES } from '../store';

/**
 * Transport for the dataset.
 *
 * A scenario that only plays forwards in real time makes its own argument hard
 * to check: the interesting twenty seconds of the disturbance are surrounded
 * by ten that look like normal. Being able to scrub to the moment the core
 * breaks down, slow it to a quarter speed and watch the ring pattern come
 * apart is the difference between showing a claim and demonstrating it.
 *
 * Hidden when the source is open-ended, because a live feed has no timeline
 * to scrub.
 */
export function PlaybackBar() {
  const paused = useVizStore((s) => s.paused);
  const togglePaused = useVizStore((s) => s.togglePaused);
  const timeScale = useVizStore((s) => s.timeScale);
  const setTimeScale = useVizStore((s) => s.setTimeScale);
  const requestSeek = useVizStore((s) => s.requestSeek);
  const { elapsed, duration } = useVizStore((s) => s.readout);

  // A duration of zero means an open-ended source, and a range input with a
  // zero max and a zero step is an uncontrolled input waiting to happen.
  const scrubbable = Number.isFinite(duration) && duration > 0;
  const progress = scrubbable ? Math.min(elapsed / duration, 1) : 0;

  return (
    <div className="playback">
      <button
        className="transport"
        onClick={togglePaused}
        aria-label={paused ? 'Resume' : 'Pause'}
        title={paused ? 'Resume (space)' : 'Pause (space)'}
      >
        {paused ? '▶' : '❚❚'}
      </button>

      {scrubbable ? (
        <>
          <input
            className="scrub"
            type="range"
            min={0}
            max={duration}
            step={duration / 400}
            value={Math.min(elapsed, duration)}
            onChange={(e) => requestSeek(Number(e.target.value))}
            aria-label="Position in scenario"
          />
          <span className="clock">
            {elapsed.toFixed(1)}
            <em>/{duration.toFixed(0)}s</em>
          </span>
        </>
      ) : (
        <span className="live-note">
          live feed · {elapsed.toFixed(0)}s
          <span className="live-dot" />
        </span>
      )}

      <div className="speeds" role="group" aria-label="Playback speed">
        {TIME_SCALES.map((s) => (
          <button
            key={s}
            className={s === timeScale ? 'speed active' : 'speed'}
            onClick={() => setTimeScale(s)}
            title={`${s}x speed`}
          >
            {s}×
          </button>
        ))}
      </div>

      {/* Progress underline: redundant with the scrub handle, but it reads at a
          glance from across a room, which the handle does not. */}
      {scrubbable && (
        <span className="playback-progress" style={{ width: `${progress * 100}%` }} />
      )}
    </div>
  );
}
