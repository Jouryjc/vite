import type { Plugin } from 'vite'

export default function PluginB(): Plugin {
  return {
    name: 'testB-plugin',

    enforce: 'pre',

    config(config, configEnv) {
      console.log('插件B  --->  config', configEnv)
    },

    configResolved(resolvedConfigB) {
      console.log('插件B  --->  configResolved')
    }
  }
}
