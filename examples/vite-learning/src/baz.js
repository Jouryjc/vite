export const sayHello = (msg) => {
  return `Hello! ${msg}`
}

if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    console.log('baz.js updated module', newModule)
  })
}
