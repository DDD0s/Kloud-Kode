# 从公网连接 API

这里配置的是你自己部署的 Komputer API。客户端用 Komputer 的 API key 连接，
Claude Code 仍在远端使用自己的登录配置。

本地 harness 自己执行工具时，只需要从本地发起 HTTPS 请求，云端不用连回本地电脑。
使用 Body 时，云端到 Body 的 MCP 连接仍要另外配置。

以下命令在远端 `Komputer/komputer-api` 目录执行。先完成 [基本安装](../SETUP.md)，
再选择下面一种 HTTPS 接法。

## API 直接提供 HTTPS

先准备域名、证书和私钥。域名应指向服务器，证书应覆盖这个域名；
服务用户需要能读取证书文件，但不要因此把私钥设成所有人可读。
项目不会自动申请证书、修改 DNS 或开放防火墙。

在 `env` 中设置，替换域名和证书路径：

```bash
KOMPUTER_PUBLIC_API=1
KOMPUTER_API_HOST=0.0.0.0
KOMPUTER_API_PORT=18888
KOMPUTER_TLS_CERT_FILE=/etc/komputer/tls/fullchain.pem
KOMPUTER_TLS_KEY_FILE=/etc/komputer/tls/privkey.pem
KOMPUTER_DEPLOY_HEALTH_URL=https://api.example.com:18888/healthz
```

`KOMPUTER_DEPLOY_HEALTH_URL` 给部署脚本做健康检查用，不能代替监听和 TLS 配置。
公网/TLS 配置要求 API key 至少 32 个字符；请使用安装步骤生成的随机 key。
TLS 最低版本为 1.2。

重启 API 后检查：

```bash
./stop.sh
./start.sh
KEY=$(awk -F': ' '/^api-key:/{print $2; exit}' KEYS.txt)
curl -fsS https://api.example.com:18888/v1/models \
  -H "Authorization: Bearer $KEY"
```

服务实际监听协议以 `logs/komputer-api.log` 为准；当前启动脚本的提示仍可能显示 `http://`。
配置好云端防火墙后，再在本地电脑用自己的客户端测试同一地址。
Chat Completions 的 Base URL 是 `https://api.example.com:18888/v1`。
Messages 的完整端点是 `https://api.example.com:18888/v1/messages`，注意客户端是否自动追加 `/v1`。

如果证书报错，检查域名、有效期和证书链，不要通过关闭证书验证来解决。
证书在启动时读取，续期后需要重启 API。

## 已经有 HTTPS 反向代理

如果代理和 API 在同一台主机上，API 可以保持：

```bash
KOMPUTER_PUBLIC_API=1
KOMPUTER_API_HOST=127.0.0.1
KOMPUTER_API_PORT=18888
```

这时不设置 API 自身的 `KOMPUTER_TLS_CERT_FILE` 和 `KOMPUTER_TLS_KEY_FILE`。
由代理接收 HTTPS，并转发到 `http://127.0.0.1:18888`。客户端填代理的 HTTPS 地址，
不要填后端的 HTTP 地址。代理需要保留鉴权头，并允许 SSE 流式回复和较长的请求时间。

容器等环境可能需要 API 监听 `0.0.0.0`。如果后端确实只对受保护的代理可达，
可以显式设置 `KOMPUTER_ALLOW_INSECURE_HTTP=1` 允许明文后端。
这个开关不会加密流量，也不能用来把 HTTP 直接暴露到公网。

不要同时照抄两种配置。是否由 API 还是代理处理 TLS，要先选清楚。

## 浏览器与限流

原生客户端不需要 CORS 设置。浏览器页面直接请求 API 时，需要列出页面的准确来源：

```bash
KOMPUTER_CORS_ORIGINS=https://harness.example.com,http://localhost:3000
```

不支持 `*`，来源不带路径或结尾斜杠。CORS 放行后仍需要 API key，不使用 cookie 登录。
不要把 key 放进对公众开放的网页或前端代码。

错误 key 默认按实际连接地址限流，每分钟允许 20 次失败；可用 `KOMPUTER_AUTH_FAILURE_LIMIT` 调整。
服务不会信任 `X-Forwarded-For` 来绕过这一限制，代理后看到的地址可能都是代理本身。
正确 key 不会被错误尝试锁死。更细的用户/IP 限流需要在入口代理处理。

所有 key 都代表同一个部署所有者，没有不同用户之间的权限隔离。
匿名 `/healthz` 只说明进程还在响应，不能证明 Claude 登录和本地工具都正常。

## 目前验证过什么

自动测试覆盖 HTTPS 证书验证、鉴权、工具往返、CORS、弱 key 和限流。
Linux CI 在 Node.js 22 和 24 上执行这些测试；真实公网域名、真实 Claude 和具体客户端仍需要部署后联调。

如果本机安全软件拦截 HTTPS 并替换测试证书，严格证书测试会失败。
应检查证书实际签发者和网络路径，不要修改测试去接受错误证书。
