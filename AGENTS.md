# 仓库协作入口

Codex 与 Claude 共同遵循 [CLAUDE.md](CLAUDE.md) 的架构、代码、测试与 Git 约定；相关规范按其中链接按需阅读。

- 维护招聘业务规则时使用 [maintain-business-rules](src/skills/maintain-business-rules/SKILL.md)，七个主题入口为 [docs/business-rules](docs/business-rules/README.md)。运行时手册保留在 `src`，不引入数据库规则配置。
- 保留其他会话未提交改动、stash 和工作树，提交时只暂存本任务路径。
- PR 默认创建正式待审 PR，目标 `develop`；只有用户明确要求时才创建草稿。合并、部署范围以用户当前授权为准。
