import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const banner = `/*
 * Pixel Agents for Obsidian — bundled build, do not edit.
 * Source: https://github.com/DK-SIVA/obsidian-pixel-agents
 */`;

/**
 * The ported UI uses ESM-style specifiers with a ".js" suffix ("./App.js"),
 * which is what the original Vite/tsc setup expected. esbuild does not remap
 * those to the TypeScript sources on its own, so do it here instead of
 * touching 40 import statements.
 */
const typescriptExtensions = {
  name: 'resolve-js-to-ts',
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const base = resolve(args.resolveDir, args.path);
      for (const candidate of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]) {
        if (existsSync(candidate)) return { path: candidate };
      }
      return null;
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  jsx: 'automatic',
  logLevel: 'info',
  treeShaking: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  banner: { js: banner },
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
  // Obsidian and Electron provide these at runtime; Node builtins come from
  // the desktop app's Node integration (hence isDesktopOnly in the manifest).
  external: [
    'obsidian',
    'electron',
    '@codemirror/state',
    '@codemirror/view',
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  plugins: [typescriptExtensions],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
