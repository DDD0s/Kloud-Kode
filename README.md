# Kloud Kode by Kosmolopic

用你自己的官方 Claude Code 订阅，给任何 OpenAI / Anthropic 兼容的开源客户端提供 API，
并且能让 Claude 通过 MCP 操作你家里的电脑。适合公司网络封锁、只能在别处用 AI 的情况。

## 它是什么，不是什么

- **是**：一个很薄的 HTTP 前端。每收到一条消息，就在「大脑」主机上调用一次**官方、未修改**的
  `claude` 命令行（`claude -p --resume <会话>`），把输出转成 OpenAI / Anthropic 格式返回。
- **不是** token 代理：它不读取、不转发、不伪造任何 Claude 登录凭据，所有请求都由真正的
  Claude Code 发出。这和 CLIProxyAPI 一类抽取 OAuth token 的工具有本质区别。
- **只给自己用**：每个人用自己的 Claude 账号、自己部署一套。把自己的 key 或地址给别人用，
  等于共享订阅，违反 Anthropic 条款。

## 架构

```
开源客户端（Open WebUI / LibreChat / Chatbox / …）
        │  OpenAI 或 Anthropic 协议，经 Tailscale
        ▼
大脑主机：agentvr-api/server.mjs → 官方 claude CLI（你自己的订阅）
        │  MCP，经 SSH 隧道
        ▼
身体主机（你的电脑）：cloudcode-body，Claude 在这里执行命令、读写文件
```

**怎么搭：看 [SETUP.md](SETUP.md)**，从零开始的中文步骤。

## 功能

- 逐字流式输出，显示思考过程和工具调用进度
- 每个聊天对应一个 Claude Code 会话，记得完整的工具上下文；不带聊天 id 的客户端自动走无状态模式
- 可选模型（opus / sonnet / haiku）和推理强度
- 图片、PDF 附件
- 识别「重新生成」和「编辑消息」
- Open WebUI 生成标题等后台请求自动用 haiku 快速处理，不混进对话
- 断线不白烧额度：回合照常跑完，重发同一条消息会接上同一次运行
- 出错返回真实 HTTP 状态码（登录过期 502、额度用完 429，带 Retry-After），客户端能自动重试

## 目录

| 路径 | 内容 |
|------|------|
| `agentvr-api/` | API 服务本体、测试、完整使用说明（各客户端怎么配都在这里） |
| `cloudcode-body/` | 跑在你电脑上的 MCP 服务，Claude 靠它操作这台机器 |
| `agentvr/` | 到身体主机的 SSH 隧道脚本 |
| `agentvr-session/` | Claude Code 的工作目录模板（`.mcp.json` 里的 token 已隐去） |
| `deploy/` | 一键部署脚本，带备份和自动回滚 |
| `ROADMAP.md` | 已完成和计划中的功能 |

## 开发

```bash
cd agentvr-api      && node --test test/server.test.mjs   # 假 claude，不消耗额度
cd cloudcode-body   && node --test test/body.test.mjs     # 真起一个 body 进程打 HTTP
```

需要 Node.js 20 以上、Claude Code 2.1 以上。

## 致谢

本项目与 [Claude](https://claude.com/claude-code) 协作开发。
