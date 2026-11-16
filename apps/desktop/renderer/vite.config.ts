// The renderer's own build settings. packages/dev-host loads this file and adds the server,
// the `/core` relay and the dev routes, so nothing here names a host, port or backend URL.

import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
})
