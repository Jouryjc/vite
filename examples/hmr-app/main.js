import './style.css'

const fooModule = await import('./foo')
console.log(fooModule)

if (import.meta.hot) {
  import.meta.hot.accept()
}
