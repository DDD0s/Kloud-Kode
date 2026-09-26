# 云端公网 API（0.9.0）

“公网 API”指你自己的 **Komputer HTTPS 接口**，不是模型服务商 API Key 直连后端。
本地 harness 填写 `KEYS.txt` 中的 Komputer key，不填写 Claude 登录凭据。

## 直接 HTTPS

云端 `komputer-api/env` 配置示例（不会自动部署）：

```bash
KOMPUTER_PUBLIC_API=1
KOMPUTER_API_HOST=0.0.0.0
KOMPUTER_API_PORT=18888
KOMPUTER_TLS_CERT_FILE=/etc/komputer/tls/fullchain.pem
KOMPUTER_TLS_KEY_FILE=/etc/komputer/tls/privkey.pem
KOMPUTER_DEPLOY_HEALTH_URL=https://api.example.com:18888/healthz
```

Chat Completions 基础地址示例：`https://api.example.com:18888/v1`。
Messages 端点为 `https://api.example.com:18888/v1/messages`；按客户端是否追加 `/v1` 设置基础地址。
证书须与域名匹配并通过客户端验证，缺失/无效则启动失败，最低 TLS 1.2。
公网/TLS 模式拒绝少于 32 字符的 key，实际应使用密码学安全随机值。

不强制 Tailscale。harness 工具调用和结果都由本地主动发起 HTTPS 请求，
云端不必主动连接本地，也不需要公开本地执行器端口。原 Body 模式仍需其 MCP 通道。

## TLS 代理后端

已有 HTTPS 代理时，可保持 API 监听 `127.0.0.1`，设置 `KOMPUTER_PUBLIC_API=1`。
容器必须监听通配 HTTP 后端时，需显式设置 `KOMPUTER_ALLOW_INSECURE_HTTP=1`，
并保证该后端只能由受保护的 TLS 代理访问。此开关不提供加密，不能用于裸公网 HTTP。
默认不会在公共/通配地址上静默启动明文服务。

不自动获取证书、修改 DNS、防火墙、systemd 或安装代理；这些与一键安装留到后续。
部署脚本安装锁定依赖；直接 TLS 部署要给出证书域名匹配的健康检查 URL，不会用 `curl -k`。
等待执行中的回合超时会中止部署。

## 访问控制

- 原生 harness 不需要 CORS。浏览器直连可设置精确来源：
  `KOMPUTER_CORS_ORIGINS=https://harness.example.com,http://localhost:3000`。
  不接受通配来源，不使用 cookie 认证，预检放行不代表免除 API key。
- 错误 key 按实际连接地址限流，默认每分钟 20 次，`X-Forwarded-For` 不能绕过；正确 key 不会被错误尝试锁死。
- `KOMPUTER_AUTH_FAILURE_LIMIT` 调整阈值，`KOMPUTER_MAX_CONNECTIONS` 默认 512。
  TLS 握手/HTTP 头超时 15 秒，请求体接收超时 30 秒；回复流另有回合超时和心跳。
- 代理后的地址是代理本身，不盲目信任转发头。更细的入口限流由现有代理配置。
- 匿名 health 只返回基础存活信息。模型、会话、工具运行及调用接口均需 key。
- 单用户部署，所有 key 代表同一所有者，不提供多租户隔离。

## 验证边界

测试覆盖严格证书验证的 HTTPS 鉴权及工具往返、CORS、弱 key、限流和异常请求。
开发电脑的 Avast HTTPS 扫描替换临时测试证书，导致证书固定测试失败；没有关闭校验或修改系统信任。
GitHub Linux CI 在 Node 22/24 上执行同一完整测试，以 CI 结果为准。
真实公网域名、实际 Claude 登录与具体 harness 尚未部署联调。
