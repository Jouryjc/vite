import { defineConfig } from 'vite'
import { VitePluginBaz } from './plugins/vite-plugin-baz'

export default defineConfig({
  build: {
    rollupOptions: {
      options() {
        return null
      }
    }
  },

  plugins: [
    VitePluginBaz(),

    {
      name: 'foo',

      buildStart(ctx) {
        console.log('foo')
      }
    },
    async () => {
      return {
        name: 'bar',

        buildStart(ctx) {
          console.log(ctx.name)
          console.log('bar plugin')
        }
      }
    }
  ]
})
