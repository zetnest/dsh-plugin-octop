/**
 * 多源 backend 注册表。每个源实现统一 5 方法，面板/桥只认接口。
 * 目前只有 octop；下一步加 dsh(本进程 subagent)、acp、各 CLI。
 */
export function createBackends({ client, mcp }) {
  const octop = {
    id: 'octop',
    label: 'Octop',
    async status() { return { id: 'octop', label: 'Octop', available: Boolean(client.token), detail: client.baseUrl } },
    async listAgents() { return (await mcp.listExperts()).map(e => ({ id: e.id, name: e.name, description: e.description })) },
    async listThreads(agentId) { return await client.listThreads(String(agentId), 30) },
    async history(agentId, threadId) { return await client.history(String(agentId), String(threadId), 50) },
    async send() { throw new Error('octop.send 由 bridge 直接实现') },
  }
  // dsh 源：本进程 subagent。先占位（available:false），下一步接 ctx.subagent 真实调用。
  const dsh = {
    id: 'dsh',
    label: 'DSH',
    async status() { return { id: 'dsh', label: 'DSH', available: false, detail: '待接入 ctx.subagent' } },
    async listAgents() { return [] },
    async listThreads() { return [] },
    async history() { return [] },
    async send() { throw new Error('dsh 源尚未接入') },
  }
  return { octop, dsh }
}
