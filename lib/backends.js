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
  return { octop }
}
