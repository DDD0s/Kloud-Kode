# Kloud Kode Body

跑在**你想操作的那台电脑**上的 MCP 服务。远端的 Claude Code（大脑）通过它在这台机器上
执行命令、读写文件、维持长时间运行的进程。

## 为什么自己写

原先用的是 `@daodao97/localmcp`。它是给 ChatGPT 做的桥：ChatGPT 没有文件工具，所以它要
提供一整套去补。我们的大脑是 Claude Code，本来就有自己的工具循环，重复的部分是白带的，
它捆的 Cloudflare Worker 中继、skills 系统也用不上。自己写之后少了一层不可控的依赖，
也顺手修掉了几个对我们影响很直接的问题：

| 问题 | 这里的做法 |
|------|-----------|
| 命令输出一律按 UTF-8 解码，日文（cp932）/ 中文（gbk）系统上原生命令输出乱码 | 先按 UTF-8 严格解码，失败再用实际控制台代码页，并在结果里写明用了哪种 |
| stdout 和 stderr 混在一起，分不清哪句是报错 | 分开返回，另给 `exitCode` 和 `durationMs` |
| 只保留前 256KB，构建日志的结尾（最关键的部分）被丢掉 | 同时保留开头和结尾，中间省略并注明丢了多少字节 |
| 只传 6 个环境变量，Windows 下 `PATHEXT`、`APPDATA`、`TEMP` 丢失，`npm` 这类 `.cmd` 命令找不到 | 完整传递环境，只摘掉本服务自己的密钥 |

## 安装

需要 Node.js 20 以上。

```bash
cd cloudcode-body
npm install
```

生成一个 token，写进配置文件：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

配置放在 `~/.cloudcode-body/config.json`（Windows 是 `C:\Users\你\.cloudcode-body\config.json`），
可参考 `config.example.json`：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "token": "上一步生成的那串",
  "roots": { "home": "~", "code": "D:\\Github" },
  "defaultRoot": "home"
}
```

启动：

```bash
node server.mjs http
```

用 `CLOUDCODE_BODY_CONFIG` 指定别的配置文件，用 `CLOUDCODE_BODY_TOKEN` 覆盖 token。
`node server.mjs stdio` 是 stdio 模式，给本机直接挂载用。

## 大脑那边怎么连

在大脑主机把端口转发过来（例如 Tailscale SSH），然后写进 Claude Code 的 `.mcp.json`：

```json
{ "mcpServers": { "body": { "type": "http", "url": "http://127.0.0.1:18787/mcp/<token>" } } }
```

token 放在路径里，是因为有些客户端只能填一个 URL、加不了请求头。也支持
`Authorization: Bearer <token>`，能加头就用头。

## 工具

| 工具 | 说明 |
|------|------|
| `body_info` | 这台机器是什么、开了哪些能力、根目录和各项上限 |
| `run_command` | 跑一条命令并等它结束，分开返回 stdout / stderr / 退出码 |
| `start_process` / `read_process` / `write_process` / `stop_process` / `list_processes` | 开发服务器、watcher 这类需要跨回合活着的进程；`read_process` 用游标续读 |
| `read_file` / `write_file` / `edit_file` | 读写文件；`read_file` 可按行窗口读大文件；`edit_file` 要求 `oldText` 唯一匹配 |
| `list_directory` / `find_files` / `search_files` / `stat_path` | 列目录、按名字找、按内容搜 |
| `create_directory` / `delete_path` / `move_path` | 建目录、删除、移动 |
| `list_mcp_servers` / `list_mcp_tools` / `call_mcp_tool` | 转发这台机器上装的其他 stdio MCP（见下） |

## 挂载这台机器上的其他 MCP

装在**这台电脑**上的 MCP，写进配置的 `mcpServers`，云端就能通过 `call_mcp_tool` 调用，
不用在大脑那边再装一份：

```json
"mcpServers": {
  "office": { "command": "npx", "args": ["-y", "@neuraforge/office-mcp", "--pptx"] }
}
```

用 `list_mcp_servers` 确认挂上了，`list_mcp_tools` 看它有哪些工具和参数，再用 `call_mcp_tool` 调用。

## 安全

- **默认只监听 127.0.0.1。** 请通过 Tailscale 或 SSH 转发访问，不要直接暴露到公网。
  拿到 token 的人等于拿到这台电脑的命令执行权限。
- **`roots` 是防手滑，不是安全边界。** 文件工具不能跳出 `roots`，但 `run_command` 本来就能
  跑任何命令。不想给 shell 就在配置里把 `shell` 设成 `false`。
- token 至少 32 个字符，比较时用的是定长比较，失败会延迟一秒再回。
- `/healthz` 不需要 token，但只回服务名和版本。

## 测试

```bash
npm test
```

会真的起一个服务进程，用 HTTP 打进去，覆盖鉴权、编码回退、输出截断、路径越界、
进程游标读取等行为。
