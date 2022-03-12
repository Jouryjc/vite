import './style.css'

await import('./foo')

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log(1)
  })
}
