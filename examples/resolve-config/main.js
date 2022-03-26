import './style.css'
import { aliasA } from '@alias/alias-A'

aliasA()
document.querySelector('#app').innerHTML = `
  <h1>Hello Vite!</h1>
  <a href="https://vitejs.dev/guide/features.html" target="_blank">Documentation</a>
`

console.log(import.meta.env.VITE_HAHA)
