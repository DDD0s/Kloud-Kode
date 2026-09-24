# Kloud Kode by Kosmolopic — API 服务

（内部代号 AgentVR：环境变量前缀、目录名和模型 id 沿用 `agentvr`，方便已有部署直接升级。）

OpenAI-compatible **client-facing** Kloud Kode API front for AgentVR.

- **Brain**: official, unmodified Claude Code on a always-on host, running in `agentvr-session/`
- **Body**: `cloudcode-body` on your workstation, reached through an SSH tunnel (`127.0.0.1:18787`)
- **Session model**: **本地对话 id（AAAAA）→ 永久映射 → Claude Code session（BBBB）**
- **并行任务**: 开多少个本地聊天都行；同时在跑的回合默认最多 4 个，多出的排队
- **Not this**: CLIProxyAPI OAuth 模拟、Anthropic 账号池、假客户端指纹

中文要点：你**不需要**复制、记忆任何长 UUID。本地开源客户端只要带上自己的 conversation / chat id（或把 `user` 设成每个聊天唯一的值），服务端会自动把它映射到 Claude Code 的 `--resume` session，并永久保存（直到你删除该聊天映射）。

## 会话模型（重要）— 用户不用碰 Claude UUID

| 概念 | 符号 | 谁持有 | 说明 |
|------|------|--------|------|
| 本地客户端 conversation / chat id | **AAAAA** | 客户端（你平时用的那个聊天） | 唯一需要稳定发送的 id |
| Claude Code session uuid | **BBBB** | 仅服务端内部 | `--session-id` / `--resume`；用户**永远不必**复制 |
| 映射 | AAAAA → BBBB | `sessions.json` | 永久，直到 `DELETE /v1/sessions/:AAAAA` |

机制：

1. 某本地聊天首次请求带着 AAAAA → 服务端生成 BBBB，写入映射，跑 `claude -p --session-id BBBB`
2. 同一本地聊天后续请求仍只带 AAAAA → 查映射得 BBBB，跑 `claude -p --resume BBBB`（记忆连续）
3. 另一个本地聊天 CCCCC → 另一条映射、另一段 Claude 记忆（隔离）
4. 空闲超时只释放 **live slot**；映射与 Claude 转录仍保留

> **不要**再把「复制 `X-AgentVR-Session` 长 UUID」当成主路径。该响应头现在回显的是 **AAAAA（客户端 key）**；内部 BBBB 仅在可选调试头 `X-AgentVR-Claude-Session` 中出现。

## Listen

- Default: `http://127.0.0.1:18888`
- 多个地址用逗号，每项可写 `地址` 或 `地址:端口`：`AGENTVR_API_HOST=127.0.0.1,127.0.0.1:8317`
  - 加第二个端口的用途：某些网络策略只放行特定端口，让服务同时听那个端口就能接上
- tailnet 里的其他设备（笔记本、手机）不用改配置，直接用 `http://<大脑的 Tailscale IP>:18888/v1`：大脑的 Tailscale 若是用户态模式，会把 tailnet 进来的连接转给本机 127.0.0.1。**不要**把 Tailscale IP 写进监听地址，用户态模式下绑不上。
- 客户端电脑如果开着 Clash 之类的代理，要把 `100.64.0.0/10` 加进直连 / 绕过列表，否则请求会被代理吞掉而超时。
- Base URL: `http://127.0.0.1:18888/v1`
- API key: 见 `KEYS.txt`（mode 600；文档勿贴完整密钥）

## 模型与推理强度

| 客户端里选的 model | 实际运行 |
|------|------|
| `agentvr-claude` | Claude Code 默认模型（可用 `AGENTVR_CLAUDE_MODEL` 改） |
| `agentvr-opus` / `agentvr-sonnet` / `agentvr-haiku` | `claude --model opus / sonnet / haiku` |
| `agentvr-<任意别名或全名>` | `claude --model <别名或全名>` |
| `claude-…` 全名，或 `opus` / `sonnet` / `haiku` | 原样传给 `--model` |
| 其他（客户端默认的 `gpt-4o` 之类） | 当作默认模型 |

推理强度：OpenAI 的 `reasoning_effort`（`low` / `medium` / `high`，`minimal` 当 `low`），或 `effort`，
或 Anthropic 的 `thinking.budget_tokens`，都会变成 `claude --effort`。同一个对话里可以随时换模型。

## 附件

- 图片：OpenAI `image_url`（data URL 或 http 链接）、Anthropic `image` 块，直接交给 Claude 看。
- PDF：OpenAI `file`（`file_data` 为 PDF）或 Anthropic `document` 块。
- 文本类文件：解码后作为文字附上。
- 只有最新一条用户消息里的附件会真正发送；更早消息里的附件在历史里显示成 `[image]` / `[file: 名字]`。

## 三种运行方式

| 情况 | 方式 |
|------|------|
| 请求带对话 id | 会话模式：映射到 Claude Code 会话，`--resume` 续接，记得工具调用的全部上下文 |
| 请求没有任何对话 id | 无状态模式：每次带客户端发来的完整历史跑一次，不建映射，不占会话 |
| 最新消息以 `### Task:` 开头（Open WebUI 生成标题 / 标签 / 追问建议） | 后台任务：用 `AGENTVR_TASK_MODEL`（默认 haiku）快速跑，不加载工具和 MCP，不写进你的对话 |

请求头 `X-AgentVR-Ephemeral: 1`（或 body `agentvr_ephemeral: true`）可以强制单次无状态。
响应头 `X-AgentVR-Mode` 会告诉你走的是哪种。

## 重新生成 / 编辑消息

会话模式下，服务端会记住上一轮回复的结尾。客户端下次发来的历史里，如果「上一条助手消息」
和它对不上（点了重新生成、改了之前的消息、请求重试），就判定为分叉：新开一个 Claude 会话，
把客户端当前看到的历史作为上下文带进去。旧会话的转录仍留在磁盘上。
只发最新一条消息、不带历史的客户端不受影响，照常续接。
`AGENTVR_DETECT_REGENERATE=0` 可以关掉这个行为。

## Auth

```
Authorization: Bearer <api-key>
# or
x-api-key: <api-key>
```

## 客户端如何提供 AAAAA（解析顺序，先命中先用）

服务端按下列顺序找「本地对话 key」——**任意非空稳定字符串均可**（不必是 UUID）：

1. **Headers**（推荐，适合 Open WebUI / LibreChat 模板头）
   - `X-Conversation-Id`
   - `X-Chat-Id`
   - `X-OpenWebUI-Chat-Id`
   - `X-LibreChat-Conversation-Id`
   - 兼容：`X-AgentVR-Session` / `X-Session-Id`（现在当作 **AAAAA**，不再要求 UUID）
2. **Body 字段**
   - `conversation_id` / `chat_id` / `thread_id`
   - `metadata.chat_id` / `metadata.conversation_id`
   - 兼容：`session_id` / `agentvr_session`
3. **OpenAI 标准 `user` 字段**（很多 UI 可配置；详见下方客户端设置）
4. **都没有** → 默认走无状态模式（见下文），不建映射；想恢复旧行为（自动生成 `auto-<uuid>`）设 `AGENTVR_NO_KEY_MODE=auto-session`

响应始终回显 **AAAAA**：

| 位置 | 字段 |
|------|------|
| Header | `X-Conversation-Id`, `X-Chat-Id`, `X-AgentVR-Session`（= AAAAA） |
| Header（调试可选） | `X-AgentVR-Claude-Session`（= BBBB，可忽略） |
| JSON | `conversation_id`, `chat_id`, `agentvr_conversation_id`, `agentvr_session`（均 = AAAAA） |

## 各客户端点击设置（让每个本地聊天有稳定 AAAAA）

### Open WebUI（推荐）

目标：每个聊天的 `chat_id` 自动变成上游请求里的稳定 key。

**方式 A — 自定义连接头（最简单，需较新版本支持 `{{chat_id}}`）**

1. Admin Panel → **Settings** → **Connections**（或 External Connections）
2. 编辑 AgentVR 这条 OpenAI 兼容连接
3. **API Base URL**: `http://127.0.0.1:18888/v1`（或你的可达地址）
4. **API Key**: 填 `KEYS.txt` 里的 key
5. 在 **Custom Headers / 额外请求头** 增加：
   ```json
   {
     "X-Conversation-Id": "{{chat_id}}"
   }
   ```
   （若 UI 是键值表：Name=`X-Conversation-Id`，Value=`{{chat_id}}`）
6. 保存 → 每个本地聊天窗口会自动带上自己的 chat UUID 作为 AAAAA

**方式 B — Filter 把 chat_id 写入 OpenAI `user` 字段**

1. Workspace → **Functions** → 新建 Filter
2. Inlet 示例：

```python
class Filter:
    def inlet(self, body: dict, __user__: dict = None, __metadata__: dict = None) -> dict:
        meta = __metadata__ or body.get("metadata") or {}
        chat_id = meta.get("chat_id") or body.get("chat_id")
        if chat_id:
            body["user"] = str(chat_id)
        return body
```

3. 对该模型/连接启用 Filter → 每个聊天的 `user` = 该聊天 id → 服务端当 AAAAA

**方式 C — 环境变量转发头（部分版本）**

若已开启用户/会话转发，可能出现 `X-OpenWebUI-Chat-Id`；本 API 已识别该头。仍建议方式 A 显式设 `X-Conversation-Id`。

### LibreChat

1. 编辑 `librechat.yaml` 中 AgentVR 自定义 endpoint
2. 增加动态头（官方占位符）：

```yaml
endpoints:
  custom:
    - name: "AgentVR"
      apiKey: "${AGENTVR_KEY}"
      baseURL: "http://127.0.0.1:18888/v1"
      models:
        default: ["agentvr-claude"]
        fetch: false
      headers:
        X-Conversation-Id: "{{LIBRECHAT_BODY_CONVERSATIONID}}"
```

3. 重启 LibreChat。每个 conversation 的 id 即 AAAAA。

### LobeChat

1. 设置 → **语言模型** → **添加 OpenAI 兼容** 服务商
2. 接口地址：`http://127.0.0.1:18888/v1`，模型：`agentvr-claude`，填 API Key
3. 若版本支持 **自定义请求头**：加 `X-Conversation-Id` = 会话 id（部分版本可用变量；否则见下）
4. **稳妥替代**：在「应用设置 / Agent」里若能配置 OpenAI `user`，设为**每个助手或每个会话唯一**的字符串（例如会话标题旁的 id）。同一会话始终同一 `user` → AAAAA；换会话请换不同 `user`，否则会粘到同一 Claude 记忆
5. 若完全无法传 per-chat id：每开一个本地新话题就当新映射不可靠——请改用 Open WebUI / LibreChat，或在前面加一层小代理注入头

### Chatbox

1. 设置 → **模型服务商** → **添加** → 选 **OpenAI API 兼容**
2. API Host：`http://127.0.0.1:18888/v1`（有的版本填 Host 不含 `/v1`，按其说明）
3. API Key：填 `KEYS.txt`；添加模型 id `agentvr-claude`
4. Chatbox 桌面版**通常不能**在 UI 里配动态自定义头 / per-chat `user`
5. 直接用就行：不带对话 id 时服务端走无状态模式，每次带着 Chatbox 发来的完整历史回答，
   多轮对话照常连贯。区别只是 Claude 不记得上一轮工具调用的细节（只看得到文字历史）。
   需要跨轮保留工具上下文的长任务，用 Open WebUI / LibreChat 这类能带 per-chat id 的客户端。

### NextChat / ChatGPT-Next-Web

1. 设置里填 OpenAI 接口地址 `http://127.0.0.1:18888/v1` + Key + 模型 `agentvr-claude`
2. 多数构建**不传** per-chat header；若你有改过的 fork 能加请求头，设 `X-Conversation-Id` 为当前 `sessionId` / `topic id`
3. 否则同样建议前面加网关，或换 LibreChat / Open WebUI

### Continue（VS Code / JetBrains）

1. `~/.continue/config.json` 里加 OpenAI 兼容模型，`apiBase: http://127.0.0.1:18888/v1`
2. Continue 的 session 与 IDE 聊天绑定；可在 `requestOptions.headers` 里写死一个工作区级 AAAAA，或按工作区用不同 header：

```json
{
  "models": [{
    "title": "AgentVR",
    "provider": "openai",
    "model": "agentvr-claude",
    "apiBase": "http://127.0.0.1:18888/v1",
    "apiKey": "<from KEYS.txt>",
    "requestOptions": {
      "headers": {
        "X-Conversation-Id": "continue-workspace-main"
      }
    }
  }]
}
```

换项目记忆就换不同的 `X-Conversation-Id` 值。

### SillyTavern

1. API 选 Chat Completion → OpenAI Compatible
2. Reverse Proxy：`http://127.0.0.1:18888/v1`，模型 `agentvr-claude`
3. 在 **Additional Parameters / Custom Headers**（视版本）加：
   - Header `X-Conversation-Id: <当前角色卡或聊天的稳定 id>`
4. 或把 OpenAI `user` 设成角色/聊天唯一名 → 即 AAAAA

## Routes

| Method | Path | Notes |
|--------|------|--------|
| GET | `/healthz` | 无 key 只回 `{ok,service}`；带 key 才返回映射池状态 |
| GET | `/v1/models` | requires key |
| POST | `/v1/sessions` | 可选 `{ "conversation_id": "AAAAA", "label": "…" }` 预创建映射 |
| GET | `/v1/sessions` | 列表（含 `client_key` / `claude_session_id`） |
| GET | `/v1/sessions/:id` | `:id` = AAAAA（或调试用 BBBB） |
| DELETE | `/v1/sessions/:id` | 删映射；Claude 磁盘转录仍在 |
| POST | `/v1/chat/completions` | OpenAI chat；靠上面的 AAAAA 解析粘会话；`stream:true` 为逐字流式 |
| POST | `/v1/messages` | Anthropic 兼容；`stream:true` 输出标准 Anthropic SSE 事件（含 thinking 块） |
| POST | `/v1/messages/count_tokens` | 粗略估算（字符数 ÷ 3.5） |

## Start / stop

```bash
./start.sh
./stop.sh
# logs: logs/agentvr-api.log
```

环境变量：

| Var | Default | Meaning |
|-----|---------|---------|
| `AGENTVR_API_HOST` | `127.0.0.1` | 监听地址，可逗号分隔多个 |
| `AGENTVR_MAX_SESSIONS` | `0`（不限） | 同时 live 映射上限；映射本身不占资源，所以默认不限 |
| `AGENTVR_MAX_IN_FLIGHT` | `4` | 同时在跑的 Claude 回合上限，超出的排队 |
| `AGENTVR_MODELS` | `agentvr-opus,agentvr-sonnet,agentvr-haiku` | `/v1/models` 里额外列出的模型 |
| `AGENTVR_CLAUDE_MODEL` | 空 | `agentvr-claude` 对应的模型，空 = Claude Code 默认 |
| `AGENTVR_EFFORT` | 空 | 客户端没指定时的默认推理强度 |
| `AGENTVR_NO_KEY_MODE` | `stateless` | 没有对话 id 时：`stateless` 或 `auto-session` |
| `AGENTVR_DETECT_REGENERATE` | `1` | 重新生成 / 编辑检测 |
| `AGENTVR_TASK_DETECT` | `1` | 识别 Open WebUI 后台任务 |
| `AGENTVR_TASK_MODEL` | `haiku` | 后台任务用的模型 |
| `AGENTVR_STREAM_THINKING` | `1` | 把 Claude 的思考过程流给客户端 |
| `AGENTVR_MAX_BODY_BYTES` | `50000000` | 单个请求体上限（放得下图片和 PDF） |
| `AGENTVR_TURN_CACHE_MS` | `600000` (10m) | 掉线的回合跑完后，答案缓存多久等客户端重发来取 |
| `AGENTVR_SSE_OPEN_MS` | `25000` | 流式响应最多憋多久才发 200（在此之前出错会返回真实状态码） |
| `AGENTVR_IDLE_TIMEOUT_MS` | `2700000` (45m) | 超过未用则不算 live（映射仍可 resume） |
| `AGENTVR_CLAUDE_TIMEOUT_MS` | `600000` | 单回合超时 |
| `HTTP(S)_PROXY` | `http://127.0.0.1:7890` | Anthropic 出网 |
| `NO_PROXY` | localhost / Tailscale 等 | MCP / 隧道不走代理 |
| `AGENTVR_BUILTIN_TOOLS` | `default` | brain 上 Claude Code 的内置工具。`default` = 全部照常；也可以写成 `WebSearch,WebFetch` 这类列表来收窄，空串 = 全关 |
| `AGENTVR_HEARTBEAT_MS` | `15000` | 流式响应的 keepalive 间隔，防止隧道 / 反代因空闲断开 |
| `AGENTVR_STREAM_TOOL_NOTES` | `1` | 流式时把 `[tool] 工具名` 放进 `reasoning_content`，客户端的「思考」区能看到进度 |
| `AGENTVR_AUTH_FAIL_DELAY_MS` | `1000` | key 错误时延迟回复，拖慢在线猜 key |
| `AGENTVR_MAX_HISTORY_CHARS` | `60000` | 新会话首轮最多带入多少字符的客户端历史 |
| `AGENTVR_SKIP_TUNNEL` | 空 | 设为 `1` 时不探测 body 隧道（brain 和 body 在同一台机器时用） |

改 `KEYS.txt` 后不用重启：`kill -HUP $(cat agentvr-api.pid)` 重新加载 key。

## 部署（从 Windows 仓库 `C:\agentvr`）

```bash
bash deploy/deploy.sh            # 本地测试 → 上传 → 等在跑的回合结束 → 重启 → 健康检查，失败自动回滚
bash deploy/deploy.sh rollback   # 手动回滚到最近一次备份
```

## Sample curl（只带本地 chat id，不碰 Claude UUID）

```bash
KEY=$(awk -F': ' '/^api-key:/{print $2; exit}' KEYS.txt)

# 模拟客户端本地对话 id = local-AAAAA（用 OpenAI user 字段；也可用 -H "X-Conversation-Id: local-AAAAA"）
# 第一轮：设定秘密词
curl -sS http://127.0.0.1:18888/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agentvr-claude","user":"local-AAAAA","messages":[{"role":"user","content":"Remember the secret word is MANGO99. Reply OK."}]}' \
  | jq '{content:.choices[0].message.content, conversation_id, headers_note:"also see X-Conversation-Id"}'

# 第二轮：同一 local-AAAAA，不传任何 AgentVR/Claude uuid → 应仍记得
curl -sS http://127.0.0.1:18888/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agentvr-claude","user":"local-AAAAA","messages":[{"role":"user","content":"What is the secret word? Reply with only the word."}]}' \
  | jq -r '.choices[0].message.content'

# 另一个本地聊天 local-CCCCC → 隔离，不应知道 MANGO99
curl -sS http://127.0.0.1:18888/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agentvr-claude","user":"local-CCCCC","messages":[{"role":"user","content":"What is the secret word? If unknown say UNKNOWN."}]}' \
  | jq -r '.choices[0].message.content'
```

等价 header 写法（Open WebUI / LibreChat 风格）：

```bash
-H "X-Conversation-Id: local-AAAAA"
# 或
-H "X-OpenWebUI-Chat-Id: local-AAAAA"
```

## Limits / 限制

- 真实 Claude Code OAuth 客户端；非 CPA。本进程不读取、不转发、不伪造任何 Claude 凭据
- Streaming：逐字流式（`--include-partial-messages`），每 15 秒发一次 keepalive 注释
- 延迟：Claude Code + MCP 往返（常达数十秒）
- 客户端断开不会中断已经在跑的回合：内容照常生成并缓存，重发同一条消息会接上同一次运行，不重复消耗额度
- 新会话如果客户端带着历史消息过来（例如映射被删），首轮会把历史作为上下文带给 Claude
- 客户端自己定义的函数调用（OpenAI `tools` / function calling）不支持：工具由 Claude Code 自己执行，请求里的 `tools` 会被忽略
- 永远只给自己用：把 key 或地址给别人，就等于把自己的 Claude 订阅共享出去，这违反 Anthropic 条款
- 需要 Claude Code ≥ 2.1（用到 `--append-system-prompt-file`、`--include-partial-messages`、`--input-format stream-json`、`--effort`）
- 同 AAAAA 内回合串行；跨聊天可并行（受 `MAX_IN_FLIGHT`）
- 若客户端把全局用户名塞进 `user` 且所有聊天共用 → 会粘成同一 Claude 记忆；**per-chat 请用每聊天唯一的 user / header**
- Secrets：勿记录 KEYS 或 MCP URL token

## Related paths

- Session cwd / MCP：`agentvr-session/`（`.mcp.json`）
- 映射登记：`agentvr-api/sessions.json`（`client_key` → `claude_session_id`）
- Tunnel：`agentvr/tunnel-up.sh`
- Claude：`CLAUDE_BIN`，默认在 PATH 上找
- Claude 转录：`~/.claude/projects/…/<BBBB>.jsonl`

## Nested MCP（PC 工具 → 云端）

需要操作你电脑的 MCP（比如 Office / PowerPoint），装在**你的工作站**上，写进 body 配置的
`mcpServers`，云端就能通过 `list_mcp_servers` / `list_mcp_tools` / `call_mcp_tool` 调用，
不用在大脑那边再装一份。写法见 `cloudcode-body/README.md`。
