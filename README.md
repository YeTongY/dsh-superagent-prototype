# dsh-superagent

> **本仓库基于研究原型扩展，供研究参考，不是 DeepSeek 官方产品。** 上游代码来自团队的日常开发实践，大量工程工作由编码 Agent 完成。研究代码仍可能存在缺陷，使用前需要结合自己的环境审查和适配。
>
> 上游发布版本经过整理，与其内部版本及《Exploring Super-agent Design: Towards a More Autonomous Agent System》描述的实现并不完全相同，文章中的部分设计仍属于未来方向。

dsh-superagent 是基于 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的主动编码智能体，可在一个运行时接管多个 GitHub 与内网 GitLab 项目，并可选接收飞书消息。每个项目独立保存来源身份、状态、账号和执行配置；GitLab 通过 `glab` 访问，VPN 由宿主负责。授权请求会生成工单，在独立会话与目录中执行，并向原讨论交付结果。本地 Reporter 可直接测试编排行为，减少平台消息与模型调用成本。

本项目遵循的工作原则是：**尽量少占用人的注意力，尽量多提供价值。** Agent 只在收到授权请求或团队规则允许时行动，在需要人处理或交付结果时沟通。具体原则见[设计理念](docs/000-philosophy.md)。

## 安装与接入

多项目和内网 GitLab 的接入、独立 CLI 认证及宿主 VPN/CA 前置条件见[部署文档](docs/006-deployment.md)。也可以请编码 Agent 协助：

> 阅读本仓库 SETUP.md，按我的 GitHub/GitLab 项目和宿主网络环境协助部署 dsh-superagent。

部署指引见 [SETUP.md](SETUP.md)。认证信息在宿主终端配置，不放入聊天、项目设置或 Prompt。

## 文档

基础文档按编号组织；多项目迁移和本地测试分别见 009、010。

- [000 设计理念](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 管理面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md)：安装、配置、升级和排障
- [007 架构](docs/007-architecture.md)
- [008 扩展指南](docs/008-cookbook.md)：新增 Source
- [009 多项目与旧 GitHub 状态迁移](docs/009-multi-project-migration.md)
- [010 本地 Reporter 与行为测试](docs/010-local-reporter.md)

## 开发

运行 `pnpm check` 完成类型检查、测试和构建。真实 VPN/GitLab 测试需要按文档显式启用，默认跳过。

## 许可证

[MIT](LICENSE)
