import { defineConfig } from 'vite'
import vitePluginB from './plugins/vite-plugin-B'

export default defineConfig({
  server: {
    port: 8888
  },

  resolve: {
    alias: [
      {
        find: '@alias',
        replacement: './alias-script'
      }
    ]
  },

  envDir: './.env',

  plugins: [
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
    vitePluginB(),
    () => {
      return {
        name: 'testC-plugin'
      }
    }
  ]
})
