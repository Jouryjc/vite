// src/main.js
import { createApp } from "vue";

// local-script:/Users/yjcjour/Documents/code/vite/examples/vue-demo/src/components/HelloWorld.vue
import { ref } from "vue";
defineProps({
  msg: String
});
var count = ref(0);

// local-script:/Users/yjcjour/Documents/code/vite/examples/vue-demo/src/App.vue
import _ from "lodash-es";
console.log(_.trim("   hello "));

// html:/Users/yjcjour/Documents/code/vite/examples/vue-demo/src/App.vue
var App_default = {};

// lib/foo.js
function sayHello() {
  console.log("hello vite prebundling");
}

// lib/index.js
sayHello();

// src/main.js
createApp(App_default).mount("#app");

// html:/Users/yjcjour/Documents/code/vite/examples/vue-demo/index.html
var vue_demo_default = {};
export {
  vue_demo_default as default
};
