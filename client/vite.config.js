import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      host: env.VITE_HOST || '100.64.0.1',
      port: parseInt(env.VITE_PORT || '5173'),
    },
  };
});
