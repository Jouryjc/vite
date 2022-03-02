import { defineConfig } from 'vite'
import vitePluginB from './plugins/vite-plugin-B'
import Inspect from 'vite-plugin-inspect'

export default defineConfig({
  plugins: [
    Inspect(),
    {
      name: 'testA-plugin',

      enforce: 'post',

      config(config, configEnv) {
        console.log('插件A  --->  config', configEnv)
      },

      configResolved(resolvedConfigA) {
        console.log('插件A  --->  configResolved')
      }
    },
    vitePluginB()
  ]
})
