import { defineConfig } from 'vite'
import { VitePluginBaz } from './plugins/vite-plugin-baz'

export default defineConfig({
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
