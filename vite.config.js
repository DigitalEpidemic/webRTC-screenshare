import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'public/app',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    cors: true,
  },
  define: {
    // Make environment variables available to client
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  }
}); 