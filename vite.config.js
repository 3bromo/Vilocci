import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';

// ---------------------------------------------------------------------------
// Static site layout
//
// The site is served as plain static files by Vercel (see vercel.json):
//   public/  -> Vercel static output root (index.html, css/, js/, img/)
//   dist/    -> vite build output (kept in sync with the same static files)
//
// IMPORTANT: data/ (the JSON database) is NEVER copied into a deployable
// directory — it is only bundled into the serverless function via require().
// ---------------------------------------------------------------------------

function copyDir(src, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry);
    const destPath = resolve(dest, entry);
    if (statSync(srcPath).isDirectory()) copyDir(srcPath, destPath);
    else copyFileSync(srcPath, destPath);
  }
}

function copyFileTo(src, dest) {
  mkdirSync(resolve('.', dest, '..'), { recursive: true });
  copyFileSync(src, dest);
}

function copyStaticAssets() {
  return {
    name: 'copy-static-assets',
    writeBundle() {
      // --- dist/ (vite build output) ---
      if (existsSync('css')) copyDir('css', 'dist/css');
      if (existsSync('js')) copyDir('js', 'dist/js');
      if (existsSync('img')) copyDir('img', 'dist/img');
      if (existsSync('admin.html')) copyFileTo('admin.html', 'dist/admin.html');

      // --- public/ (Vercel static root) — kept in sync with the source files ---
      if (existsSync('index.html')) copyFileTo('index.html', 'public/index.html');
      if (existsSync('admin.html')) copyFileTo('admin.html', 'public/admin.html');
      if (existsSync('css')) copyDir('css', 'public/css');
      if (existsSync('js')) copyDir('js', 'public/js');
      if (existsSync('img')) copyDir('img', 'public/img');
    }
  };
}

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
