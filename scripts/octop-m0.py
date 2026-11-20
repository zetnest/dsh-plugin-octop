#!/usr/bin/env python3
"""Octop 侧冒烟验证（M0）：不需要在 DSH 里装插件就能跑，用来钉死接口契约。

它按插件将要走的顺序打一遍真实 Octop：
  1. GET  /api/health                      —— 网络 + 版本
  2. POST /api/auth/login                  —— 账号密码换 JWT
  3. GET  /api/agents                      —— 专家列表字段形状
  4. POST /api/mcp/agents  initialize      —— Agent MCP 是否可用、会话头
  5. POST /api/mcp/agents  tools/list      —— 三个工具的真实 inputSchema（关键！）
  6. （可选 --prompt）tools/call call_octop_expert  —— 真跑一轮专家对话
  7. （可选）GET threads / GET history     —— 线程与审批字段形状

用法：
  python3 octop-m0.py --base http://192.168.1.10:8088 --user admin --pass 'xxx'
  python3 octop-m0.py --config ~/.octop-m0.json
  OCTOP_BASE=... OCTOP_USER=... OCTOP_PASS=... python3 octop-m0.py --prompt '用一句话介绍你自己'

配置文件（避免密码进 shell 历史）：
  {"base": "http://192.168.1.10:8088", "user": "admin", "pass": "xxx"}

只依赖标准库。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

TIMEOUT = 60


def clip(value, limit=1200):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + f"...（截断，共 {len(text)} 字符）"


def req(method, url, token=None, body=None, headers=None, timeout=TIMEOUT, raw=False):
    data = None
    hdrs = {"accept": "application/json"}
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["content-type"] = "application/json"
    if token:
        hdrs["authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", "replace")
            return resp.status, dict(resp.headers), text
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - 冒烟脚本要报告根因
        return 0, {}, f"{type(exc).__name__}: {exc}"


def parse_json(text):
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        return None


def pick_sse(text, wanted_id=None):
    """从 SSE 文本里挑 JSON-RPC 响应（只认 dict）。"""
    messages = []
    for event in text.split("\n\n"):
        data = "\n".join(
            line[5:].lstrip(" ") for line in event.splitlines() if line.startswith("data:")
        ).strip()
        if not data:
            continue
        parsed = parse_json(data)
        if isinstance(parsed, dict):
            messages.append(parsed)
    if wanted_id is not None:
        for message in messages:
            if message.get("id") == wanted_id:
                return message
    return messages[-1] if messages else None


class Mcp:
    def __init__(self, base, token):
        self.url = base.rstrip("/") + "/api/mcp/agents"
        self.token = token
        self.session = ""
        self.version = ""
        self.next_id = 1

    def post(self, payload, timeout=TIMEOUT):
        headers = {
            "accept": "application/json, text/event-stream",
            "content-type": "application/json",
        }
        if self.session:
            headers["mcp-session-id"] = self.session
        if self.version:
            headers["mcp-protocol-version"] = self.version
        status, resp_headers, text = req(
            "POST", self.url, token=self.token, body=payload, headers=headers, timeout=timeout
        )
        sid = resp_headers.get("mcp-session-id") or resp_headers.get("Mcp-Session-Id")
        if sid:
            self.session = sid
        return status, resp_headers, text

    def initialize(self):
        last = None
        for version in ("2025-06-18", "2025-03-26", "2024-11-05"):
            payload = {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": version,
                    "capabilities": {},
                    "clientInfo": {"name": "octop-m0", "version": "0.1.0"},
                },
            }
            self.next_id += 1
            status, headers, text = self.post(payload)
            message = pick_sse(text, payload["id"]) if "event-stream" in (headers.get("content-type") or "") else parse_json(text)
            if not isinstance(message, dict):
                message = None
            print(f"[4] initialize({version}) -> HTTP {status} session={self.session or '-'}")
            if status == 200 and message and message.get("result"):
                self.version = message["result"].get("protocolVersion") or version
                print("    protocolVersion:", self.version)
                print("    serverInfo:", clip(message["result"].get("serverInfo")))
                self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})
                return True
            last = message or text
            print("    ->", clip(last, 300))
        print("!! Agent MCP 握手失败，最后一个响应：", clip(last, 500))
        return False

    def rpc(self, method, params, timeout=TIMEOUT):
        payload = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}
        self.next_id += 1
        status, headers, text = self.post(payload, timeout=timeout)
        if "event-stream" in (headers.get("content-type") or ""):
            return status, pick_sse(text, payload["id"])
        return status, parse_json(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=os.environ.get("OCTOP_BASE", "http://127.0.0.1:8088"))
    parser.add_argument("--user", default=os.environ.get("OCTOP_USER", ""))
    parser.add_argument("--pass", dest="password", default=os.environ.get("OCTOP_PASS", ""))
    parser.add_argument("--config", default="", help="JSON 文件：{base,user,pass}")
    parser.add_argument("--prompt", default="", help="给了就跑一轮真实专家对话")
    parser.add_argument("--expert", default="", help="指定专家 id，默认用列表第一个")
    parser.add_argument("--timeout", type=int, default=600, help="专家对话超时秒数")
    args = parser.parse_args()

    if args.config:
        with open(os.path.expanduser(args.config), "r", encoding="utf-8") as handle:
            cfg = json.load(handle)
        args.base = cfg.get("base", args.base)
        args.user = cfg.get("user", args.user)
        args.password = cfg.get("pass", args.password)

    base = args.base.rstrip("/")
    print(f"Octop M0 冒烟：{base}")

    status, _, text = req("GET", base + "/api/health", timeout=10)
    print(f"[1] health -> HTTP {status} {clip(text, 200)}")
    if status == 0:
        print("!! 连不上。检查：Octop 是否在跑、手机与主机是否同网段、baseUrl 端口（默认 8088）。")
        return 2
    if status != 200:
        print("!! health 非 200，后面的步骤大概率也会失败。")

    if not args.user or not args.password:
        print("!! 缺 --user/--pass（或 --config / 环境变量），无法继续登录。")
        return 2
    status, _, text = req("POST", base + "/api/auth/login", body={"username": args.user, "password": args.password}, timeout=20)
    print(f"[2] login -> HTTP {status} {clip(text, 200)}")
    if status != 200:
        print("!! 登录失败：看上面 body 里的 error code（AUTH_FAILED / LOGIN_LOCKED）。")
        return 2
    token = (parse_json(text) or {}).get("access_token", "")
    if not token:
        print("!! 登录响应里没有 access_token。")
        return 2

    status, _, text = req("GET", base + "/api/agents", token=token)
    agents = parse_json(text)
    print(f"[3] GET /api/agents -> HTTP {status} 类型={type(agents).__name__}")
    if isinstance(agents, list):
        print("   条数:", len(agents))
        if agents:
            print("   首条字段:", sorted(agents[0].keys()) if isinstance(agents[0], dict) else clip(agents[0]))
            print("   首条:", clip(agents[0], 500))
        first = agents[0] if agents else {}
        expert_id = args.expert or (first.get("agent_id") or first.get("id") if isinstance(first, dict) else "")
    elif isinstance(agents, dict):
        print("   字段:", sorted(agents.keys()))
        items = agents.get("agents") or agents.get("items") or []
        print("   条数:", len(items) if isinstance(items, list) else "?")
        if items and isinstance(items[0], dict):
            print("   首条字段:", sorted(items[0].keys()))
            print("   首条:", clip(items[0], 500))
        expert_id = args.expert or (items[0].get("agent_id") or items[0].get("id") if items and isinstance(items[0], dict) else "")
    else:
        expert_id = args.expert
        print("   !! 意外响应:", clip(text, 300))

    mcp = Mcp(base, token)
    if not mcp.initialize():
        return 3

    status, message = mcp.rpc("tools/list", {})
    if not isinstance(message, dict):
        print(f"!! tools/list 没有返回 JSON-RPC 对象：{clip(message, 300)}")
        return 3
    tools = (message.get("result") or {}).get("tools", []) if isinstance(message.get("result"), dict) else []
    print(f"[5] tools/list -> HTTP {status} 工具数={len(tools)}")
    for tool in tools:
        schema = tool.get("inputSchema") or {}
        props = schema.get("properties") or {}
        summary = ", ".join(
            f"{name}:{prop.get('type', '?')}" for name, prop in props.items()
        ) or "（无参数）"
        print(f"   - {tool.get('name')}: {clip(tool.get('description', ''), 120)}")
        print(f"     参数: {summary}")
        if schema.get("required"):
            print(f"     必填: {schema['required']}")

    if not args.prompt:
        print("\n（没给 --prompt，跳过真实对话。契约已打印完毕。）")
        return 0

    call_tool = next((tool.get("name") for tool in tools if "call" in (tool.get("name") or "")), "call_octop_expert")
    schema = next((tool.get("inputSchema") or {} for tool in tools if tool.get("name") == call_tool), {})
    props = schema.get("properties") or {}

    def pick(*candidates):
        for candidate in candidates:
            if candidate in props:
                return candidate
        return None

    arg_expert = pick("expert_id", "agent_id", "expert", "agent", "id")
    arg_message = pick("message", "prompt", "content", "text", "query", "input")
    arg_thread = pick("thread_id", "threadId", "thread", "conversation_id")
    call_args = {}
    if arg_expert and expert_id != "":
        call_args[arg_expert] = int(expert_id) if str(expert_id).isdigit() and props[arg_expert].get("type") == "integer" else expert_id
    if arg_message:
        call_args[arg_message] = args.prompt
    if not arg_expert or not arg_message:
        print(f"!! 无法从 schema 推断 {call_tool} 的参数名，请人工看一下上面的 inputSchema。")
        return 4
    print(f"\n[6] {call_tool} {json.dumps(call_args, ensure_ascii=False)}")
    status, message = mcp.rpc("tools/call", {"name": call_tool, "arguments": call_args}, timeout=args.timeout)
    print(f"    -> HTTP {status}")
    result = message.get("result") if isinstance(message, dict) else message
    print("   ", clip(result, 2000))

    payload = {}
    if isinstance(result, dict):
        if isinstance(result.get("structuredContent"), dict):
            payload = result["structuredContent"]
        else:
            chunk = "\n".join(
                block.get("text", "") for block in result.get("content", []) if block.get("type") == "text"
            ).strip()
            parsed = parse_json(chunk)
            payload = parsed if isinstance(parsed, dict) else {"reply": chunk}
    thread_id = payload.get("thread_id") or payload.get("threadId") or ""
    print("    status:", payload.get("status"), " thread_id:", thread_id or "-")

    if thread_id and expert_id != "":
        status, _, text = req("GET", f"{base}/api/agents/{expert_id}/threads/{thread_id}/history?limit=5&offset=0", token=token)
        data = parse_json(text) or {}
        print(f"[7] history -> HTTP {status} 顶层字段: {sorted(data.keys()) if isinstance(data, dict) else type(data).__name__}")
        if isinstance(data, dict):
            messages = data.get("messages") or []
            print("    turn_active:", data.get("turn_active"), " hitl_pending:", clip(data.get("hitl_pending"), 300))
            if messages:
                print("    首条消息字段:", sorted(messages[0].keys()) if isinstance(messages[0], dict) else type(messages[0]).__name__)

    print("\n完成。把上面 [5] 的 inputSchema 与 [6]/[7] 的字段名贴回来，我据此收紧参数映射。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
