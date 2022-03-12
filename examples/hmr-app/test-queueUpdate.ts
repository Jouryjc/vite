let pending = false
let queued: Promise<(() => void) | undefined>[] = []

async function queueUpdate(p: Promise<(() => void) | undefined>) {
  console.log('Enter queueUpdate')
  queued.push(p)
  if (!pending) {
    pending = true
    console.log('Before queueUpdate resolve')
    await Promise.resolve()
    console.log('After queueUpdate resolve')
    pending = false
    const loading = [...queued]
    queued = []
    await Promise.all(loading)
    console.log('success')
  }
}

for (let i = 0; i < 10; i++) {
  if (i > 8) {
    setTimeout(() => Promise.resolve(() => {}), 1000)
  } else {
    queueUpdate(Promise.resolve(() => {}))
  }
}
