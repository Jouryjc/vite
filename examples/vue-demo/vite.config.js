import { defineConfig } from 'vite'
import path from 'path'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],

  optimizeDeps: {
    include: [
      path.resolve(process.cwd(), './lib/index.js')
    ]
  }
})
