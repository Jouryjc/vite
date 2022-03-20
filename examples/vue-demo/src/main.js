import { createApp } from 'vue'
import * as fsExtra from 'fs-extra'
import App from './App.vue'
import '../lib/index'

createApp(App).mount('#app')
console.log(fsExtra)