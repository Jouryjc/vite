import { name } from './bar'

export function sayName() {
  console.log(name)
  return name
}

if (import.meta.hot) {
  import.meta.hot.accept('./bar.js')
}
