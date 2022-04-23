import { createApp } from 'vue'
import App from './App.vue'
import { isArray } from 'lodash-es'

console.log(isArray([1, 2, 3, 4]))

createApp(App).mount('#app')
