# 链路

```
开源客户端
   │  OpenAI / Anthropic 协议（经 Tailscale）
   ▼
大脑：agentvr-api  ──spawn──>  官方 claude CLI ──> Anthropic
   │
   │  MCP over HTTP（经 ssh -L 隧道）
   ▼
身体：cloudcode-body ──> 你这台电脑的 shell、文件、进程
```

- **大脑**不持有任何 Claude 凭据：每一轮都是真正的 `claude` 自己发请求。
- **身体**只认一个 token，默认只监听 `127.0.0.1`，靠隧道或 Tailscale 暴露。
- 身体上还能挂载本机其他 stdio MCP，云端通过 `call_mcp_tool` 调用，
  不必在大脑那边再装一份。见 `cloudcode-body/README.md`。
