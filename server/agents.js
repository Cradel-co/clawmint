'use strict';

const fs = require('fs');
const path = require('path');

const AGENTS_FILE = path.join(__dirname, 'agents.json');

// Agentes por defecto al inicializar
const DEFAULT_AGENTS = [
  { key: 'claude', command: 'claude', description: 'Claude CLI (IA)' },
  { key: 'bash',   command: null,     description: 'Bash shell' },
];

class AgentManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.agents = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(AGENTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')) || [];
        for (const a of data) this.agents.set(a.key, a);
        return;
      }
    } catch { /* ignorar */ }

    // Primera vez: cargar defaults
    for (const a of DEFAULT_AGENTS) this.agents.set(a.key, { ...a });
    this._save();
  }

  _save() {
    try {
      fs.writeFileSync(AGENTS_FILE, JSON.stringify([...this.agents.values()], null, 2), 'utf8');
    } catch (err) {
      console.error('[Agents] No se pudo guardar agents.json:', err.message);
    }
  }

  list() {
    return [...this.agents.values()];
  }

  get(key) {
    return this.agents.get(key);
  }

  add(key, command, description = '') {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('key inválida (solo letras, números, _ y -)');
    const agent = { key, command: command || null, description };
    this.agents.set(key, agent);
    this._save();
    return agent;
  }

  update(key, { command, description }) {
    const agent = this.agents.get(key);
    if (!agent) throw new Error(`Agente "${key}" no encontrado`);
    if (command !== undefined) agent.command = command || null;
    if (description !== undefined) agent.description = description;
    this._save();
    return agent;
  }

  remove(key) {
    if (!this.agents.has(key)) return false;
    this.agents.delete(key);
    this._save();
    return true;
  }
}

const manager = new AgentManager();

module.exports = {
  list:   ()                        => manager.list(),
  get:    (key)                     => manager.get(key),
  add:    (key, command, desc)      => manager.add(key, command, desc),
  update: (key, opts)               => manager.update(key, opts),
  remove: (key)                     => manager.remove(key),
};
