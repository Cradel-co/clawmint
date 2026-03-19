'use strict';

const fs = require('fs');
const path = require('path');

// Lee .env y lo convierte a objeto
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
  return env;
}

module.exports = {
  apps: [{
    name: 'clawmint',
    script: 'index.js',
    node_args: '--stack-size=65536',
    env: loadEnv(),
  }],
};
