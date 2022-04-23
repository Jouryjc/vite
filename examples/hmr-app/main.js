import './style.css'
import { name } from './name'
import { documentName } from './document'

document.querySelector('#app').innerHTML = `
  <h1>Hello ${name}!</h1>
  <a href="https://vitejs.dev/guide/features.html" target="_blank">${documentName}</a>
`

if (import.meta.hot) {
  import.meta.hot.accept(
    ['./name', './document'],
    ([newNameModule, newDocModule]) => {
      const name = newNameModule?.name
      const documentName = newDocModule?.documentName
      console.log('热更后的name是：', name)
      console.log('热更后的documentName是：', documentName)

      // 模块更新后的结果渲染到页面上
      if (name) {
        document.querySelector('#app h1').textContent = name
      }
      if (documentName) {
        document.querySelector('#app a').textContent = documentName
      }
    }
  )
}
