import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, cpSync } from 'fs';

// Custom plugin to copy static assets (js, img) to dist/
function copyStaticAssets() {
  return {
    name: 'copy-static-assets',
    writeBundle() {
      const copyDir = (src, dest) => {
        if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
        const entries = readdirSync(src);
        for (const entry of entries) {
          const srcPath = resolve(src, entry);
          const destPath = resolve(dest, entry);
          if (statSync(srcPath).isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            copyFileSync(srcPath, destPath);
          }
        }
      };

      // Copy js/ directory
      if (existsSync('js')) copyDir('js', 'dist/js');
      // Copy img/ directory
      if (existsSync('img')) copyDir('img', 'dist/img');
      // Copy admin.html
      if (existsSync('admin.html')) copyFileSync('admin.html', 'dist/admin.html');
      // Copy admin.css
      if (existsSync('css/admin.css')) {
        if (!existsSync('dist/css')) mkdirSync('dist/css', { recursive: true });
        copyFileSync('css/admin.css', 'dist/css/admin.css');
      }
      // Copy data/ directory
      if (existsSync('data')) copyDir('data', 'dist/data');
      // Copy lib/ directory
      if (existsSync('lib')) copyDir('lib', 'dist/lib');
    }
  };
}

// Vite config for VELOCCI - builds static assets while preserving Express server
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      },
      output: {
        entryFileNames: 'js/[name].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: '[ext]/[name].[ext]'
      }
    }
  },
  plugins: [copyStaticAssets()]
});
