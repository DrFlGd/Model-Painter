import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // manifold-3d loads its own WebAssembly; leave it out of the dependency pre-bundle
  optimizeDeps: { exclude: ['manifold-3d'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // a fixed port, so the desktop shell's dev mode finds the page
  server: { port: 5174, strictPort: true },
});
