# Komputer · Kloud Kode by Kosmolopic

完整工程在 [Komputer/](Komputer/README.md)。

- [安装与使用](Komputer/SETUP.md)
- [API 文档](Komputer/komputer-api/README.md)
- [本地 harness 工具协议](Komputer/docs/harness-api.md)
- [云端公网 HTTPS API](Komputer/docs/public-api.md)
- [命名迁移](Komputer/docs/komputer-migration.md)
- [设计目标与开发说明](Komputer/DEVELOPING.md)

目标：尽可能接近原生电脑的使用体验，同时尽可能限制模型接触工作站以外的环境信息。
日常入口：本地 harness → Komputer API → 远端官方 Claude Code → 本地 `kloud-kode-body` 执行操作；SSH 直连是备选。
运行代码、配置模板、测试与部署脚本都在 `Komputer/`；外层的 Git 元数据及本地工具/依赖缓存不属于工程交付内容。
