import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: { manualChunks: { three: ['three'], charts: ['recharts'], react: ['react', 'react-dom'] } },
    },
  },
});
