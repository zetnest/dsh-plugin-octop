/**
 * Octop 对话 WebSocket 通道：/api/agents/{id}/chat/ws?token=<jwt>
 *
 * 用它续「非 MCP 创建」的线程（Agent MCP 网关不认那些线程）。
 * 帧：发 {type:'user_turn', content, thread_id?}，收 {type:'chunk', content} 与 {type:'done'}。
 */
export function wsTurn({ baseUrl, token, agentId, threadId, text, timeoutMs = 900000, onChunk }) {
  return new Promise((resolve, reject) => {
    const wsUrl = String(baseUrl).replace(/^http/, 'ws')
      + '/api/agents/' + encodeURIComponent(agentId) + '/chat/ws?token=' + encodeURIComponent(token)
    let socket
    try { socket = new WebSocket(wsUrl) } catch (error) { reject(new Error('WS 创建失败：' + error.message)); return }

    let reply = ''
    let settled = false
    const timer = setTimeout(() => finish(() => reject(new Error('WS 超时（' + timeoutMs + 'ms）'))), timeoutMs)
    function finish(action) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch (error) { /* 忽略 */ }
      action()
    }

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'user_turn', content: text, ...(threadId ? { thread_id: threadId } : {}) }))
    })
    socket.addEventListener('message', event => {
      let frame
      try { frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch (error) { return }
      if (!frame || typeof frame !== 'object') return
      if (frame.type === 'chunk' && typeof frame.content === 'string') { reply += frame.content; if (onChunk) onChunk(frame.content) }
      else if (frame.type === 'done') finish(() => resolve({ reply }))
      else if (frame.type === 'error') finish(() => reject(new Error('WS 错误：' + (frame.message || 'unknown'))))
    })
    socket.addEventListener('error', () => finish(() => reject(new Error('WS 连接失败（检查 baseUrl 是否为 ws 可达）'))))
    socket.addEventListener('close', () => finish(() => resolve({ reply })))
  })
}
