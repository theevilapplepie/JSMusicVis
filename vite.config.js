import { defineConfig } from 'vite';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'

export default defineConfig({
  base: '',
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'music-metadata-browser': ['music-metadata-browser'],
          'vendor': ['notyf', 'stats.js'],
          'ionicons': ['ionicons/icons', 'ionicons'],
          'webgpu': ['./webgpu-renderer.js']
        }
      }
    }
  },
  optimizeDeps: {
    esbuildOptions: {
      // Node.js global to browser globalThis
      define: {
        global: 'globalThis'
      },
      // Enable esbuild polyfill plugins
      plugins: [
        NodeGlobalsPolyfillPlugin({
          buffer: true
        })
      ]
    }
  }  
});
