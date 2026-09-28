# Body 的 SSH 隧道

仅 Body 模式需要这个脚本。客户端自己执行工具时，不需要建立这条隧道。

`tunnel-up.sh` 在远端主机运行，把远端的本机端口转发到 Body：

```text
远端 127.0.0.1:18787 ── SSH ──> 本地电脑 127.0.0.1:8787
```

前提是远端能通过 SSH 连接本地电脑，而且不需要交互输入密码。
先按 [安装步骤](../SETUP.md) 配置 SSH、Body token 和 MCP 文件。

## 配置

写在 `komputer-api/env` 中：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `BODY_SSH` | `body` | 本地电脑在远端 SSH 配置中的名字 |
| `LOCAL_PORT` | `18787` | 远端转发端口 |
| `BODY_PORT` | `8787` | 本地 Body 监听端口 |

如果改了 `LOCAL_PORT`，也要修改 MCP 配置中的 URL 和 API 的 `KOMPUTER_HEALTH_URL`。
如果改了 `BODY_PORT`，要和 Body 自身的配置一致。

API 的启动脚本会读取 `env` 并尝试建立隧道；Body 请求也会检查连接并在必要时重建。
成功探测缓存 15 秒，失败后默认等 30 秒才再试，不是实时连接保证。

要手动运行，请在远端的 `Komputer/` 目录执行：

```bash
BODY_SSH=body LOCAL_PORT=18787 BODY_PORT=8787 bash komputer/tunnel-up.sh
```

直接运行隧道脚本不会自动读取 `komputer-api/env`。日志默认在 `/tmp/komputer-tunnel.log`。
