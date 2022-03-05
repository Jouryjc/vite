import { Plugin } from 'vite'

export const VitePluginBaz = (): Plugin => {
  return {
    name: 'baz',

    buildStart(ctx) {
      console.log('baz')
    }
  }
}
