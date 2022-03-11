// count.js
export let count = import.meta.hot.data?.getCount?.() || 1

const timer = setInterval(() => {
  console.log(count++)

  if (count > 10) {
    import.meta.hot.decline()
  }
}, 1000)

if (import.meta.hot) {
  import.meta.hot.data.getCount = () => {
    return count
  }

  import.meta.hot.dispose(() => {
    // 清理副作用
    clearInterval(timer)
  })
}
