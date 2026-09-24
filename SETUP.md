# 从零搭一套 Kloud Kode by Kosmolopic

面向「公司电脑上不了外网，但想在公司用 AI 客户端干活」的场景。
搭完之后，任何 OpenAI / Anthropic 兼容的开源客户端都能连上你自己的 Claude 订阅，
并且能让 Claude 操作你家里那台电脑。

**用你自己的 Claude 账号。** 这套东西不共享订阅、不传 token，每个人装自己的一套。

## 你需要什么

| 角色 | 是什么 | 要求 |
|------|--------|------|
| **大脑** | 一台能上外网、能常开的机器（云服务器、家里的小主机都行） | Linux 或 macOS，Node.js 20+，装好并登录了官方 Claude Code |
| **身体** | 你想让 AI 操作的那台电脑（通常是家里的主力机） | Node.js 20+ |
| **私有网络** | 让公司 / 外出的设备能找到大脑 | 推荐 [Tailscale](https://tailscale.com)，免费档够用 |

大脑和身体可以是同一台机器，那样更简单（见最后一节）。

---

## 第一步：身体（你家那台电脑）

装好 Node.js 20 以上，然后：

```bash
git clone <这个仓库> Kloud-Kode
cd Kloud-Kode/cloudcode-body
npm install
```

生成一个 token：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

新建配置文件。Windows 放在 `C:\Users\你的用户名\.cloudcode-body\config.json`，
Linux / macOS 放在 `~/.cloudcode-body/config.json`：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "token": "刚才生成的那串",
  "roots": { "home": "~" },
  "defaultRoot": "home"
}
```

`roots` 是文件工具能碰的目录，可以加几个，比如 `"code": "D:\\Github"`。
把 token 记下来，第三步要用。

启动：

```bash
node server.mjs http
```

看到 `cloudcode-body ... on http://127.0.0.1:8787/mcp/<token>` 就成了。
先别管开机自启，跑通全流程之后再设（见最后一节）。

## 第二步：让两台机器互相能找到

两台都装 Tailscale 并用同一个账号登录。装完在任意一台运行 `tailscale status`，
应该能看到对方。

**大脑要能 SSH 到身体。** 最省事的办法是在身体那台开 Tailscale SSH，或者身体是 Windows 就
打开 OpenSSH 服务器。验证一下，在大脑上执行（把 `body` 换成身体机器的 Tailscale 名字）：

```bash
ssh body echo ok
```

能输出 `ok` 就行。

## 第三步：大脑

同样 clone 这个仓库，然后：

```bash
cd Kloud-Kode/agentvr-api
```

**3.1 登录 Claude Code。** 这一步必须你本人做，在大脑机器上跑 `claude`，按提示用浏览器登录。
登录信息只存在这台机器上，这套服务从不读取它。

**3.2 准备 API key。** 这是你的客户端连过来时用的密码，和 Claude 账号无关：

```bash
echo "api-key: $(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > KEYS.txt
chmod 600 KEYS.txt
```

**3.3 告诉 Claude 怎么找到身体。** 编辑 `../agentvr-session/.mcp.json`，
把 `<token>` 换成第一步生成的那串：

```json
{ "mcpServers": { "workstation": { "type": "http", "url": "http://127.0.0.1:18787/mcp/<token>" } } }
```

**3.4 配置这台机器的环境：**

```bash
cp env.example env
```

编辑 `env`，一般只需要这几行（`BODY_SSH` 填身体机器在 SSH 里的名字）：

```bash
BODY_SSH=body
AGENTVR_BODY_NAME="我家的 Windows 台式机"
```

这个文件是被 shell 读取的，**带空格的值一定要加引号**，否则启动会报 `command not found`。

如果大脑需要走代理才能访问 Anthropic，再加上 `HTTPS_PROXY=http://127.0.0.1:7890`。
不需要就别加，填错了反而连不上。

**3.5 启动：**

```bash
./start.sh
```

它会先拉起到身体的隧道，再启动 API。验证：

```bash
KEY=$(awk -F': ' '/^api-key:/{print $2; exit}' KEYS.txt)
curl -s -H "Authorization: Bearer $KEY" localhost:18888/healthz
```

## 第四步：试一下

```bash
curl -sS localhost:18888/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-Conversation-Id: test-1" \
  -d '{"model":"agentvr-claude","messages":[{"role":"user","content":"在工作站上执行 hostname，把输出告诉我"}]}'
```

如果返回的是你家那台电脑的名字，整条链路就通了。

## 第五步：客户端

在任何 OpenAI 兼容客户端里加一个服务商：

| 项目 | 填什么 |
|------|--------|
| 接口地址 | `http://<大脑的 Tailscale IP>:18888/v1` |
| API Key | `KEYS.txt` 里那串 |
| 模型 | `agentvr-claude`，或 `agentvr-opus` / `agentvr-sonnet` / `agentvr-haiku` |

Claude 原生格式的客户端地址不带 `/v1`。

**两点容易踩的坑：**

- 客户端那台机器如果开着 Clash 之类的代理，要把 `100.64.0.0/10` 加进直连列表，
  否则请求会被代理吞掉。
- 大脑的 Tailscale 如果是用户态模式（`--tun=userspace-networking`），
  服务监听 `127.0.0.1` 就够了，tailnet 进来的连接会自动转发过去，
  不要把 Tailscale IP 写进监听地址，那样反而绑不上。

推荐用 Open WebUI 或 LibreChat，它们能把每个聊天的 id 传过来，Claude 会完整记住
每一轮的工具调用。具体配置见 `agentvr-api/README.md`。

---

## 开机自启

**身体（Windows）：** 建一个计划任务，触发器选「登录时」，操作填
`node`，参数 `C:\路径\cloudcode-body\server.mjs http`，勾上「不管用户是否登录都要运行」。

**身体（Linux / macOS）：** 用 systemd user unit 或 launchd。

**大脑：** 把 `agentvr-api/start.sh` 加进 crontab 的 `@reboot`，或写个 systemd unit。
隧道断了会在下一次请求时自动拉起，不用单独守护。

## 大脑和身体是同一台机器

那就不需要 SSH 隧道了。在 `env` 里设：

```bash
AGENTVR_SKIP_TUNNEL=1
AGENTVR_HEALTH_URL=http://127.0.0.1:8787/healthz
```

`.mcp.json` 直接指向 `http://127.0.0.1:8787/mcp/<token>`。

## 安全

拿到 API key 的人，就能通过这套服务在你的身体机器上执行命令。所以：

- **不要把 18888 直接暴露到公网。** 走 Tailscale，或者前面套一层带鉴权的反向代理。
- **只给自己用。** 把 key 给别人，等于共享你的 Claude 订阅，违反 Anthropic 条款。
  你朋友想用就让他照这份文档装自己的一套。
- 不要把 `KEYS.txt`、`config.json`、`.mcp.json` 提交到仓库，`.gitignore` 已经挡了大部分。

## 出问题时

| 现象 | 原因 |
|------|------|
| `502 upstream_auth_error` | 大脑上的 Claude Code 登录过期了，去那台机器跑 `claude` 重新登录 |
| `503 body tunnel unavailable` | 身体那台没开机，或者隧道断了。检查 `ssh body echo ok` |
| `429` | Claude 订阅额度用完了，响应头 `Retry-After` 会说多久后再试 |
| 客户端超时但服务端日志正常 | 多半是客户端那边的代理，见第五步的坑 |
| 中文 / 日文输出乱码 | 身体那边会自动按控制台代码页解码。还乱就把 `body_info` 的 `consoleEncoding` 发出来 |

日志在 `agentvr-api/logs/agentvr-api.log`。
