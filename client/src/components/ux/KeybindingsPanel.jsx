import { useState } from 'react';
import { DEFAULT_BINDINGS, useKeybindings, formatCombo, recordNextKey } from '../../hooks/useKeybindings';
import styles from '../admin/AdminPanel.module.css';

/**
 * KeybindingsPanel (Fase D.2) — listar y editar shortcuts.
 *
 * Persistencia via /api/user-preferences/keybindings con el hook useKeybindings.
 */
export default function KeybindingsPanel({ accessToken }) {
  const { overrides, saveOverride, resetAll } = useKeybindings(accessToken, {});
  const [recording, setRecording] = useState(null); // actionName

  const startRecord = async (actionName) => {
    setRecording(actionName);
    try {
      const combo = await recordNextKey();
      await saveOverride(actionName, combo);
    } finally {
      setRecording(null);
    }
  };

  const reset = async (actionName) => {
    await saveOverride(actionName, null);
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Keybindings</h1>
          <p className={styles.subtitle}>Shortcuts customizables. Persisten por usuario en <code>user_preferences</code>.</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={resetAll}>Reset all</button>
        </div>
      </header>

      <section className={styles.card}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Acción</th>
              <th>Descripción</th>
              <th>Shortcut</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(DEFAULT_BINDINGS).map(([action, def]) => {
              const current = overrides[action] || def.combo;
              const isOverridden = !!overrides[action];
              return (
                <tr key={action}>
                  <td className={styles.mono}>{action}</td>
                  <td>{def.description}</td>
                  <td>
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      padding: '2px 8px',
                      background: 'var(--oc2-surface-base)',
                      border: '1px solid var(--oc2-border-weak)',
                      borderRadius: 4,
                    }}>
                      {recording === action ? 'presioná tu combo…' : formatCombo(current)}
                    </span>
                    {isOverridden && <span className={styles.tag} style={{ marginLeft: 6 }}>custom</span>}
                  </td>
                  <td>
                    <button className={styles.btn} onClick={() => startRecord(action)} disabled={recording !== null}>
                      {recording === action ? 'Esperando…' : 'Cambiar'}
                    </button>
                    {isOverridden && (
                      <>
                        {' '}
                        <button className={`${styles.btn}`} onClick={() => reset(action)}>Reset</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p style={{ fontSize: 12, color: 'var(--oc2-text-weak)', marginTop: 8 }}>
        Tip: <code>mod</code> = <kbd>⌘</kbd> en Mac / <kbd>Ctrl</kbd> en Windows/Linux.
      </p>
    </div>
  );
}
