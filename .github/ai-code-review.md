# AI Code Review 配置

GitHub Actions 的 `AI Code Review` 在 PR 指向 `develop` 时执行，也支持手动填写
PR 编号补跑。同一 PR 的新提交会取消旧评审；每次只运行一个模型。

## 启用 GPT

在仓库 **Settings → Secrets and variables → Actions** 配置：

| 类型             | 名称                     | 值 / 作用                                                                                       |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| Secret           | `OPENAI_API_KEY`         | OpenAI API Key；不要粘贴到 PR、聊天或配置文件                                                   |
| Variable         | `AI_REVIEW_PROVIDER`     | `gpt`（留空时也默认 GPT）                                                                       |
| Variable（可选） | `AI_REVIEW_GPT_MODEL`    | 指定模型 ID；留空使用 Codex CLI 默认模型                                                        |
| Variable（可选） | `AI_REVIEW_GPT_ENDPOINT` | 支持 Responses API 的完整 HTTPS 地址，例如 `https://example.com/v1/responses`；留空使用官方接口 |

官方 API Key 通过 [OpenAI 平台](https://platform.openai.com/api-keys) 管理。
ChatGPT 订阅登录不会自动为此工作流提供 API 凭据。
使用代理时，把代理的 API Key 放入 `OPENAI_API_KEY`，同时填写 endpoint 和代理支持的
模型 ID；仅支持 Chat Completions 的代理不可用。API Key 只会交给配置的 endpoint，
请使用经过确认的服务。不要直接复制业务运行时的全部环境变量。

## Claude 恢复后切回

1. 确认仓库 Secret `CLAUDE_CODE_OAUTH_TOKEN` 有效；账户恢复后如果旧 token 已失效，更新它。
2. 把仓库 Variable `AI_REVIEW_PROVIDER` 改成 `claude`。
3. 在 Actions 中手动运行 `AI Code Review`，填写需要重审的 PR 编号。

无需再改 workflow 或业务代码。保留 GPT Secret 便于以后切回。切换只影响后续运行，
不会改写已经产生的评审；需要重审时手动触发。选中的服务失败时不自动切换到另一个服务。

## 评审与发布边界

两种模型共用 `review-rules.md` 和 `ai-review.schema.json`。模型只分析代码并输出
JSON，`scripts/ai-code-review.js` 校验结论、确认 PR 仍处于同一 HEAD 后再发布。
失败、空输出、非法 JSON 或自相矛盾的结论会保留阻塞评审并使任务失败；不会当作批准。
有效结论产生后，只撤销本工作流历史故障留下的占位评审，不撤销人工评审或真实问题。

GPT 使用官方 [Codex Action](https://developers.openai.com/codex/github-action/) 的
只读权限与 `drop-sudo`；checkout 不持久化 GitHub 写入凭据。
修改评审 workflow、规则、schema 或发布脚本的 PR 跳过自动评审并要求人工评审，不能让新规则批准自身。
因此本配置 PR 的检查通过不代表已完成真实模型评审。完成凭据配置并合入后，
应对普通业务 PR 补跑一次，确认所选提供方执行成功且 GitHub 上有绑定当前 HEAD 的结论。

本功能不新增数据库、业务运行时环境变量或部署步骤。回退时切换提供方即可；
若两种服务均不可用，保留失败检查并修复服务或走仓库正常人工评审流程。
