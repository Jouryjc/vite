import { sayHello } from './baz'

if (import.meta.hot) {
  import.meta.hot.accept((newBazModule) => {
    import.meta.hot.data = {
      a: 1
    }
    console.log(
      './baz updated module',
      newBazModule.sayHello('hotModuleReload')
    )
  })

  import.meta.hot.on('vite:beforeUpdate', (...args) => {
    console.log('vite:beforeUpdate', args)
  })

  import.meta.hot.on('vite:beforeFullReload', (...args) => {
    console.log('vite:beforeFullReload', args)
  })

  import.meta.hot.on('vite:beforePrune', (...args) => {
    console.log('vite:beforePrune', args)
  })
}

export const name = 'module graph'
export { sayHello }
