import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = parseInt(env.VITE_PORT || '5173');
  return {
    plugins: [react()],
    server: {
      host: env.VITE_HOST || '0.0.0.0',
      port,
    },
    preview: {
      host: env.VITE_HOST || '0.0.0.0',
      port,
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
            'markdown': ['react-markdown', 'remark-gfm', 'rehype-raw', 'rehype-sanitize'],
          },
        },
      },
    },
  };
});
