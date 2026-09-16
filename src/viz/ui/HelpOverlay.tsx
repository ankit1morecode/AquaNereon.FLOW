import { useVizStore } from '../store';
import { SHORTCUTS } from './useKeyboard';

/**
 * Shortcut list and a one-paragraph statement of what the scene is arguing.
 *
 * The second half matters more than the first. Someone arriving at this
 * without context sees a pretty pipe; the point is the causal chain, and it
 * should be readable from inside the tool rather than only from the README.
 */
export function HelpOverlay() {
  const open = useVizStore((s) => s.panels.help);
  const togglePanel = useVizStore((s) => s.togglePanel);
  if (!open) return null;

  return (
    <div className="help-backdrop" onClick={() => togglePanel('help')}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>What you are looking at</h2>
          <button className="ghost" onClick={() => togglePanel('help')}>
            Close
          </button>
        </header>

        <p>
          Two inlet streams enter the junction off-axis, so their interaction
          sets the water in the chamber rotating. The resulting vortex sits
          centred only while the branches are balanced. Unbalance them and the
          surplus sideways momentum pushes the core off-centre and leans the
          whole velocity profile — which the circumferential ring reads as an
          uneven pattern around the bore. That pattern is the flow fingerprint.
        </p>

        <div className="help-chain">
          <span>two flows interact</span>
          <i>→</i>
          <span>the interaction leaves a flow-field pattern</span>
          <i>→</i>
          <span>the ring observes it</span>
          <i>→</i>
          <span>the pattern is the fingerprint</span>
        </div>

        <h3>Reading the scene</h3>
        <ul className="help-legend">
          <li>
            <span className="swatch swatch-a" /> water that entered through inlet A
          </li>
          <li>
            <span className="swatch swatch-b" /> water that entered through inlet B
          </li>
          <li>
            <span className="swatch swatch-len" /> streak length is local speed
          </li>
          <li>
            <span className="swatch swatch-core" /> the vortex core line and its
            rotating envelope
          </li>
          <li>
            <span className="swatch swatch-break" /> recirculation, where the core has
            broken down and the water is moving backwards
          </li>
        </ul>

        <h3>Keyboard</h3>
        <table className="help-keys">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys}>
                <th>{s.keys}</th>
                <td>{s.action}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="help-caveat">
          The velocity field is a phenomenological model built from named fluid
          mechanics terms, not a CFD solution. It responds to an inlet change
          the way the hardware would, but it does not solve Navier-Stokes and
          should not be presented as if it does.
        </p>
      </div>
    </div>
  );
}
