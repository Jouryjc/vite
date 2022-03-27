import './style.css'
import { sayHello, name } from './src/foo'

document.querySelector('#app').innerHTML = `
  <h1>${sayHello(name)}</h1>
  <a href="https://vitejs.dev/guide/features.html" target="_blank">1Documentation</a>
`
