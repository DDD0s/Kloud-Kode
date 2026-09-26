# Kloud Kode by Kosmolopic

工程目录：`Komputer/`；内部命名统一为 `komputer`。
两个目标：尽可能接近原生电脑的使用体验，同时尽可能让模型只接触它要操作的那台电脑。
这是一项持续收紧的设计要求，不因为做不到百分之百就放弃，也不把改名当作完整隔离。

已有安装升级到 0.8.0 前，请先读 [命名迁移说明](docs/komputer-migration.md)。

在本地电脑上的 harness 中发指令，通过 Komputer API 交给远端官方 Claude Code 决策，
再由本地执行器完成工具操作。harness 是本地交互入口，不是远端必须另装的一套软件。

## 它是什么，不是什么

- **是**：连接本地 harness 与**官方、未修改**的 Claude Code 的 API 前端。
  工具结果可继续同一个 Claude 进程；不带客户端工具时保留原有会话续接和 Body 模式。
- **不是** token 代理：它不读取、不转发、不伪造任何 Claude 登录凭据，所有请求都由真正的
  Claude Code 发出。这和 CLIProxyAPI 一类抽取 OAuth token 的工具有本质区别。
- **单用户部署**：使用自己的 Claude 登录；所有 API key 都代表同一部署所有者，不提供多租户隔离。

## 架构

```
本地电脑 B：你 → 本地 harness（执行工具）
        ⇅  HTTPS + API Key：对话、工具调用、执行结果（公网或私网）
远端主机 A：komputer-api/server.mjs → 官方 Claude Code CLI（你自己的订阅）
```

提供 `tools` 时，调用返回本地 harness 执行。不提供客户端工具时，仍可通过 MCP 使用
`kloud-kode-body`，这条路径需要后台隧道或私网。详见 [harness 接口](docs/harness-api.md)
与 [公网 API](docs/public-api.md)。

**日常主用法是本地 harness 经 API 接入。** SSH 直接进入远端官方 CLI 也是可选用法，
但不是日常操作的必需步骤；使用该方式时仍需配置指向本地执行器的工具路由。
链路里的 SSH 隧道是后台传输，不等于要求你手动 SSH 发命令。

Open WebUI、LibreChat、Chatbox 等只是可选聊天界面的例子，不是必须再安装的软件。
0.9.0 已实现 `tools/tool_calls`、`tool_use/tool_result` 往返、流式调用、重试与取消。
具体 harness 留到安装后联调；这不是所有模型 API 参数的完整替代品。

**怎么搭：看 [SETUP.md](SETUP.md)**，从零开始的中文步骤。

## 功能

- 小岛模式：默认关掉大脑全部本地工具，模型只认识要操作的那一台电脑
- 本地 harness 工具往返；等待本地工具时释放推理名额，支持嵌套任务
- 公网 HTTPS、API Key、失败鉴权限流与精确来源 CORS
- 逐字流式输出，显示思考过程和工具调用进度
- 每个聊天对应一个 Claude Code 会话，记得完整的工具上下文；不带聊天 id 的客户端自动走无状态模式
- 可选模型（opus / sonnet / haiku / fable）和推理强度
- 图片、PDF 附件
- 识别「重新生成」和「编辑消息」
- Open WebUI 生成标题等后台请求自动用 haiku 快速处理，不混进对话
- 断线不白烧额度：回合照常跑完，重发同一条消息会接上同一次运行
- 出错返回真实 HTTP 状态码（登录过期 502、额度用完 429，带 Retry-After），客户端能自动重试

## 目录

| 路径 | 内容 |
|------|------|
| `komputer-api/` | API 服务本体、测试、完整使用说明（各客户端怎么配都在这里） |
| `kloud-kode-body/` | 跑在你电脑上的 MCP 服务，Claude 靠它操作这台机器 |
| `komputer/` | 到身体主机的 SSH 隧道脚本 |
| `komputer-session/` | Claude Code 的 MCP 配置模板（`.mcp.json` 里的 token 已隐去） |
| `deploy/` | 一键部署：大脑从共享库拉取 main 并重启，起不来就自动退回上一个提交 |
| `ROADMAP.md` | 已完成和计划中的功能 |

## 开发

```bash
cd komputer-api      && npm ci && npm test               # 假 claude，不消耗额度
cd kloud-kode-body   && node --test test/body.test.mjs     # 真起一个 body 进程打 HTTP
```

需要 Node.js 20 以上、Claude Code 2.1 以上。

## 致谢

本项目与 [Claude](https://claude.com/claude-code) 协作开发。
