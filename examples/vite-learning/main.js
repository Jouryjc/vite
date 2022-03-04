import './style.css'
import { text } from './foo'

document.querySelector('#app').innerHTML = `
  <h1>Hello ${text}</h1>
  <a href="https://vitejs.dev/guide/features.html" target="_blank">Documentation</a>
`
