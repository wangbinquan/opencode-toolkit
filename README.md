# opencode-toolkit

团队共享工具包，核心能力是 **subagent 任务完成度审查 + 自动续跑**。**一仓两宿主**——同一份审查逻辑（`src/core/`）既作 [opencode](https://opencode.ai) 插件、也作 [Claude Code](https://claude.com/claude-code) hook。跨平台支持 **Linux / macOS / Windows**：

- **opencode Plugin**：`tool.execute.after` 钩子上的 subagent 完成度审查 + 自动续跑
- **Claude Code Hook**：`SubagentStop` 上的同款审查 + 续跑（见下文「Claude Code 接入」）
- **Agents**（`agents/`）：审查员 agent `task-completion-checker`。opencode symlink 到 `.opencode/agent/`；Claude Code 翻译 frontmatter（含 `task→Agent` 权限映射）后装到 `.claude/agents/`
- **Skills**（`skills/`）：opencode 走 `config.skills.paths` 注入；Claude Code 拷贝到 `.claude/skills/`

> 两个宿主在进程层面从不共存（opencode 走 `exports["./server"]`，Claude 走 `.claude/settings.json` 的 command hook），磁盘上只共享 `src/core/` 与包元数据。详见 `src/index.ts` 顶部的目录约定说明。

## 团队成员接入（两步）

### 1. 在工程根 `opencode.json` 里声明插件

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-toolkit@github:wangbinquan/opencode-toolkit#v0.3.0"]
}
```

> ⚠️ **必须用 `<包名>@<spec>` 形式**，不能写成纯 `"github:wangbinquan/opencode-toolkit#v0.1.1"`。
> opencode 用 `npm-package-arg` 解析 spec 取 `name` 字段，github 简写形式 `name` 字段为 null，会让 opencode 把整段 spec 当包名去 `node_modules/<整段 spec>/` 里找入口，必然 ENOENT。
> 加上 `opencode-toolkit@` 前缀让 npa 正确解析，npm/arborist 仍按 github URL 拉代码并装到 `node_modules/opencode-toolkit/`。

也支持：

- 私有 git URL：`"opencode-toolkit@git+ssh://git@your.git/...#v0.3.0"`
- 私有 npm registry：`"@your-scope/opencode-toolkit"`（先在 `.npmrc` 配 scope registry）
- 本地路径（开发期）：`"file:///abs/path/to/opencode-toolkit"`

### 2. 启动两次 opencode（首次自动安装 agent，第二次开始可用）

第一次启动 opencode 会装 toolkit、把 agent symlink 写到 `<工程>/.opencode/agent/`，但因为 opencode 在 plugin load 之前就完成了 agent 扫描，本次启动 agent 还看不到。**第二次启动起就一切正常**。

如果你不想等两次启动，可以在配置插件之后、第一次启动之前手动跑一次（要求工程内已经有过任意一次 opencode 启动让 toolkit 进入 cache，否则 npx 找不到包）：

```bash
npx opencode-toolkit-install
```

接入完成后，新的 opencode 启动时若配置 spec 仍是相同字符串（同 tag）→ 走缓存，无操作；改成新 tag → 重装、agent symlink 自动指向新版本。

## 当前能力

### Plugin：subagent 完成度审查 + 自动续跑

每次 `task` 工具（subagent）调用结束后：

1. 收集子 session 全部消息、文件改动、最终输出、finish/error
2. `spawn` 一个独立 opencode 进程跑 `task-completion-checker` agent，拿到 JSON 判决
3. 若 incomplete，向**同一**子 session 注入续跑 prompt（含 reasons / missing / next_steps）
4. 重复直到 complete 或超过 `MAX_RETRIES`
5. 把最终结果改写回 task 工具 `output.output`，对父 agent 透明

### Agent：`task-completion-checker`

按 40+ 条审查清单（表层完成性 / 需求覆盖 / 文件改动一致性 / 质量信号 / 自终止幻觉 / 任务类型特异化 / 流程异常）严格判决。详见 `agents/task-completion-checker.md`。

`mode: all`，可被 `opencode run --agent task-completion-checker "..."` 直接拉起。

## Claude Code 接入（SubagentStop hook）

同一个包也能给 Claude Code 用——复用同一份审查员 rubric 与 `<task_completion_review>` 判决协议（`src/core/` + `agents/task-completion-checker.md`），只是把 opencode 的 `tool.execute.after` + `session.prompt` **同步循环**，换成 Claude Code 的 `SubagentStop` hook + `decision:block` **事件驱动循环**。

### 接入

> 前提：`node` 与 `claude` 都在 PATH 上——hook 是 `node` 脚本，审查员通过 spawn `claude -p` 跑。

**① 先把包装进目标工程**（这一步同时带来运行期依赖 `cross-spawn`；与 opencode 不同，Claude Code 没有自动装包机制，需显式装）：

```bash
cd /path/to/你的工程
# 发布后：从 npm 或 github 装
npm install opencode-toolkit          # 或 npm install github:wangbinquan/opencode-toolkit#vX.Y.Z
# 未发布 / 本地开发：用本地 checkout 路径装
npm install /abs/path/to/opencode-toolkit
```

**② 一条命令装齐 hook + agents + skills**（都幂等，不碰你已有的文件）：

```bash
npx opencode-toolkit-install --claude
```

写入内容（保留你的其它配置）：

```json
{
  "hooks": {
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "node \"<abs>/node_modules/opencode-toolkit/src/claude/hook.mjs\"", "timeout": 600 } ] }
    ]
  }
}
```

上面的 JSON 是它写入的 **hook** 部分。同一条命令还顺手装了：

- **agents** → 把 `agents/*.md` 翻译 frontmatter 后写到 `.claude/agents/`（详见下「agent / skill 翻译细节」）
- **skills** → 把 `skills/*/` 整目录拷到 `.claude/skills/`

生成的 agent/skill 都带末尾 marker：重装只覆盖自己生成的、**不碰你手写的同名文件**。

**③ 重启 Claude Code**（开新 session）让它读到新 hook 与 agents；用 `/hooks`、`/agents` 可确认。

卸载：`npx opencode-toolkit-install --claude --uninstall`（只删 toolkit 自己装的 hook/agents/skills，保留你手写的）。

> 纯本地调试、不想装进工程也行：先在 checkout 里 `npm install` 拉到 `cross-spawn`，再
> `node /abs/path/to/opencode-toolkit/bin/install.mjs --claude /path/to/你的工程`——hook 命令会指向 checkout 里的 `src/claude/hook.mjs`。

### agent / skill 翻译细节

`--claude` 把 opencode agent 的 frontmatter 翻成 Claude 的（实现见 `bin/claude-assets.mjs`）：

| opencode frontmatter | Claude frontmatter |
|---|---|
| `permission: task: allow` | `tools:` 含 `Agent` → 该 subagent **可再起 subagent**（≤5 层） |
| `permission: task: deny` | `tools:` 不含 `Agent` → 不能派生 |
| `read/edit/write/bash/glob/grep/webfetch/websearch: allow` | 对应 `Read / Edit+MultiEdit / Write / Bash / Glob / Grep / WebFetch / WebSearch` 进 `tools:` 白名单；`deny` 的不列 |
| 无 `permission:` 块 | 不写 `tools:` = Claude 继承全部工具 |
| `mode` / `temperature` | 无 Claude 对等，丢弃 |
| `description` | 直接搬（Claude 用它做自动委派） |

局限：opencode 的 bash 细粒度白名单（`"git diff*": allow` 之类）Claude 的 agent `tools` 表达不了，只要 bash 有任一 allow 就授予整个 `Bash`。skill 是整目录拷贝、不翻译（`SKILL.md` 规范两宿主同源）。

### 工作机制

每个 subagent（Task 工具）结束 → `SubagentStop` 触发 `src/claude/hook.mjs`：

1. 读 hook 的 stdin JSON（`agent_id` / `agent_type` / `transcript_path` / `cwd`）
2. 解析子 agent 的 transcript JSONL → 抽 `FINAL_OUTPUT` / `FILE_CHANGES` / `CONVERSATION_TAIL` / finish/error（`src/claude/transcript.mjs`）
3. spawn `claude -p`（注入递归哨兵 `CC_TOOLKIT_REVIEWING` 防自派生），把 `agents/task-completion-checker.md` 正文当 system prompt，拿 `<task_completion_review>` XML 判决
4. **complete** → exit 0 放行；**incomplete** → stdout 输出 `{"decision":"block","reason": 续跑指令}`，Claude 把 reason 喂回**同一** subagent，在原上下文续跑
5. 它续跑完再停 → 再次触发 hook → 再审；由 `agent_id` 维度的计数文件精确限制最多 `CC_TOOLKIT_MAX_RETRIES` 次

**与 opencode 的差异**：opencode 在单次 hook 里同步跑完整个循环、并改写 task 输出对父 agent 透明；Claude Code 的循环摊在多次 hook 调用里（故计数必须落盘），且无法改写 Task 返回值——但续跑发生在同一上下文内，subagent 自己的最终修正消息本就是回给父 agent 的结果，无需改写。

### 可调环境变量（Claude 侧）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CC_TOOLKIT_MAX_RETRIES` | `3` | 续跑次数上限 |
| `CC_TOOLKIT_REVIEW_AGENTS` | （全审） | 只审这些 `agent_type`，逗号分隔；空 = 全部 |
| `CC_TOOLKIT_REVIEWER_MODEL` | （claude 默认） | 审查员 `claude -p --model` 的值，建议便宜模型如 `claude-haiku-4-5-20251001` |
| `CC_TOOLKIT_CLAUDE_BIN` | `claude` | claude 可执行文件路径 |
| `CC_TOOLKIT_TIMEOUT_MS` | `180000` | 单次审查超时 |
| `CC_TOOLKIT_TAIL_MESSAGES` | `6` | 传给审查员的尾部消息条数 |
| `CC_TOOLKIT_TMP_DIR` | （自动选） | 计数文件目录覆盖（默认 `<工程>/.claude/.toolkit-tmp/`） |

**怎么设**：写进 `.claude/settings.json` 顶层 `env`（per-工程，Claude Code 注入给 hook），或在启动 `claude` 的 shell 里 `export`（hook 继承启动环境，保底）：

```json
{
  "env": {
    "CC_TOOLKIT_REVIEWER_MODEL": "claude-haiku-4-5-20251001",
    "CC_TOOLKIT_MAX_RETRIES": "2",
    "CC_TOOLKIT_REVIEW_AGENTS": "general-purpose,Explore"
  },
  "hooks": { "SubagentStop": [ "...上面 --claude 装好的..." ] }
}
```

### 确认生效 / 调试

装好后**无需额外操作**——照常让主 agent 派 subagent（Task 工具）即可。每个 subagent 结束时：判 complete 静默放行；判 incomplete 则在原上下文自动续跑，最多 `MAX_RETRIES` 次后才把结果交回主 agent。

- hook 诊断写在 stderr，形如 `[cc-toolkit] agent=… attempt=1/3 reasons: …`；`claude --debug` 能看到 hook 执行
- 快速验证：故意派一个容易半途而废的 subagent（如"实现 X 并写测试"但易漏测试），看是否被打回续跑
- **成本**：每次审查 = 一次 `claude -p` 调用，最多 `MAX_RETRIES` 次 / subagent。建议审查员用便宜模型 + `CC_TOOLKIT_REVIEW_AGENTS` 限定范围

### 两个建议实测坐实的点

1. **`agent_id` 跨续跑是否稳定**：block→续跑→再停 周期里 `agent_id` 是否不变（决定它能否当计数 key；若不稳定，退化为只靠平台的 `stop_hook_active` 限次）。
2. **`decision:block` 是否带上下文续跑**：`SubagentStop` 的 reason 是否确实喂回同一 subagent 的既有上下文（官方文档明确 "prevents the subagent from stopping"，对称于 `Stop` 的续跑语义，置信度高，仍建议一个最小复现坐实）。

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_TOOLKIT_MAX_RETRIES` | `3` | 续跑次数上限 |
| `OPENCODE_TOOLKIT_REVIEWER_AGENT` | `task-completion-checker` | 审查员 agent 名 |
| `OPENCODE_TOOLKIT_OPENCODE_BIN` | `opencode` | opencode 可执行文件路径 |
| `OPENCODE_TOOLKIT_TIMEOUT_MS` | `180000` | 单次审查超时 |
| `OPENCODE_TOOLKIT_TAIL_MESSAGES` | `6` | 传给审查员的会话尾部消息条数 |
| `OPENCODE_TOOLKIT_TMP_DIR` | （自动选） | 审查员 prompt 临时文件的目录。默认按 `<工程>/.opencode/.toolkit-tmp/` → `os.tmpdir()` → `~/.opencode-toolkit-tmp/` 顺序探测可写目录（项目内优先，避免审查员 read 触发 external_directory 权限询问）；只在特殊环境需要显式指定 |
| `OPENCODE_TOOLKIT_REVIEWER_MODEL` | （继承 opencode 默认） | 审查员调用 `opencode run --agent` 时附加 `--model <value>`，格式 `provider/model`，例如 `anthropic/claude-haiku-4-5-20251001`。优先级高于 `opencode.json` 的 plugin options |
| `OPENCODE_TOOLKIT_REVIEWER_VARIANT` | （继承 opencode 默认） | 附加 `--variant <value>`（reasoning 努力度，常见值 `high` / `medium` / `low` / `minimal`） |

兼容旧名 `SUBAGENT_RESUMER_*`。

## 自定义审查员模型

审查员 agent 默认走 opencode 全局 `model` 配置。你大概率希望"主 agent 用强模型干活、审查员用便宜模型审"，省钱且对结论质量影响很小。三种方式按推荐顺序：

### 1. opencode.json plugin options（团队共享，推荐）

把插件声明改成元组形式：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-6",
  "plugin": [
    ["opencode-toolkit@github:wangbinquan/opencode-toolkit#v0.3.0", {
      "reviewerModel": "anthropic/claude-haiku-4-5-20251001",
      "reviewerVariant": "minimal"
    }]
  ]
}
```

字段：

- `reviewerModel` — `provider/model` 字符串。插件内部把它作为 `--model` 透传给 `opencode run`
- `reviewerVariant` — `--variant` 透传，provider 相关，常见 `minimal` / `low` / `medium` / `high`

不传 = 不透传 = opencode 走自己的默认（agent frontmatter > config.model > opencode 内置默认）。

### 2. 环境变量（per-shell 临时覆盖）

```bash
export OPENCODE_TOOLKIT_REVIEWER_MODEL="anthropic/claude-haiku-4-5-20251001"
export OPENCODE_TOOLKIT_REVIEWER_VARIANT="minimal"
```

优先级**高于** plugin options，适合临时实验、A/B 成本对比。

### 3. fork agent 文件（完全控制，不推荐做团队默认）

复制 `node_modules/opencode-toolkit/agents/task-completion-checker.md` 到 `<工程>/.opencode/agent/`，删除 toolkit 创建的 symlink，用你的拷贝替代，frontmatter 自己改：

```yaml
---
mode: all
model: anthropic/claude-haiku-4-5-20251001
temperature: 0
permission:
  ...
---
```

代价：你的 agent 文件被插件标记为"用户拥有"（marker 跟踪），**toolkit 后续升级不再自动同步该 agent 内容**——只会用 plugin 钩子层的修复。仅在你需要改其它 agent 字段（permission / system prompt 等）时用这条路径。

## 加载机制（实现细节）

| 资产 | 机制 | 何时生效 |
|---|---|---|
| Plugin | opencode `Npm.add` 安装包，按 `exports["./server"]` 加载 | 当次启动 |
| Skill | 插件 `config` 钩子把包内 `skills/` 注入 `config.skills.paths`；opencode 的 skill 服务惰性扫描该列表 | 当次启动 |
| Agent | 插件 factory 把 `agents/*.md` symlink 到 `<工程>/.opencode/agent/`；opencode 配置启动期扫描该目录 | **下次**启动（或先跑 `npx opencode-toolkit-install`） |

## 自动更新

- Plugin 代码：`pnpm update` 或 opencode 启动时 `npmSvc.install` 后台拉最新
- Skill 内容：路径常驻，包升级文件就升级（symlink 也行，directly path 也行）
- Agent 内容：symlink 永远指向 `node_modules/opencode-toolkit/agents/<file>.md`，包升级 → symlink 指向的真实文件升级 → 内容自动跟新（symlink 落地在工程不需重建）

工程的 `.opencode/agent/<name>.md` 已经存在为**普通文件**（不是 symlink）→ 视为团队成员自己写的同名 agent，**不覆盖**，并 warn 报告冲突。

## 卸载

```bash
npx opencode-toolkit-install --uninstall   # 仅删 toolkit 自己创建的 symlink
```

之后从 `opencode.json` 里去掉 `plugin` 项即可。

## 故障排查

### Windows 用户报"插件不工作"

v0.2.0 之前的版本在 Windows 上跑 `opencode.cmd` 时 `child_process.spawn` 会被 Node 18.20+/20.12+ 的 CVE 修复拒绝；同时 symlink 默认在 Windows 上需要管理员/Developer Mode 权限。

升级到 v0.2.6+ 即可。spec 改成 `"opencode-toolkit@github:wangbinquan/opencode-toolkit#v0.2.6"`，重启 opencode。

### 报错 "no parseable JSON verdict"（v0.2.4 及之前）

**症状**：reviewer 子进程跑完了、生成了完整内容（log 里能看到正常的 message.part.delta 和 step-finish），但插件主进程 stderr 报：

```
[opencode-toolkit] reviewer exit=0, no parseable JSON verdict
  stdout tail: ...
```

**根因**：reviewer LLM（特别是中文模型如 GLM、DeepSeek、Qwen）在 JSON 字符串值里写自然语言时，**经常忘记转义内嵌引号**：

```json
"reasons": [
  "subagent 在最后明确说了"做完了"，符合任务要求"
                       ↑       ↑ 这两个未转义的 " 让 JSON.parse 直接挂掉
]
```

`extractVerdictJson` 的 `JSON.parse` 失败 → verdict 为 null → 续跑循环停。reviewer 实际判得对，结果被引号问题吞了。

**修法（v0.2.6）**：判决格式从 JSON 换成 XML 标签：

```xml
<task_completion_review>
<verdict>complete</verdict>
<confidence>high</confidence>
<reasons>
- subagent 在最后明确说了"做完了"，符合任务要求    ← 引号、换行、单引号、中文标点全部宽容
</reasons>
...
</task_completion_review>
```

XML 标签内文本是字面量，零转义负担。Plugin 优先解析 XML，老 JSON 格式作为 fallback 仍然支持（仅当 LLM hallucinate 回退时触发）。

升级到 v0.2.6 即可。

### 报"无法写入临时文件"或 reviewer 拿不到判决（v0.2.3 及之前）

**实际症状**：插件**确实**写入了 `os.tmpdir()` 下的 prompt 文件，但审查员子进程的 `read` 工具读不到——opencode 的 `external_directory` 权限规则（默认 `ask`）把系统 tmp 视为外部目录、`opencode run` 非交互模式下要么自动 deny 要么挂起。失败的错误信息看起来像"prompt 写不出去"，其实是"审查员读不进来"。日志里能看到这种行：

```
service=permission permission=external_directory
  pattern=/var/folders/.../T/*
  action={"permission":"external_directory","action":"ask"} evaluated
```

v0.2.6 起把候选顺序里**项目内目录提到 `os.tmpdir()` 之前**：默认走 `<工程>/.opencode/.toolkit-tmp/`，read 走 within-project 路径直接命中 `read: *: allow`，不再触发 external_directory ask。同时自动写 `.gitignore` 避免污染 git，每次 plugin load 顺手清理超 1 小时的陈年残留。

升级到 v0.2.6 即可。

### 报错 "failed to write reviewer prompt to ..."（受限环境 / 只读 tmp）

v0.2.1 ~ v0.2.6 在 `os.tmpdir()` 单点不可写时直接放弃审查（受限的企业 Windows 把 `%TEMP%` 改到只读路径、只读容器 /tmp、用户 perm 错乱都可能触发）。

v0.2.6 起会按候选链探测可写目录：`OPENCODE_TOOLKIT_TMP_DIR` → `os.tmpdir()` → `<工程>/.opencode/.toolkit-tmp/` → `~/.opencode-toolkit-tmp/`，第一个能 mkdir + 写探针 + 删除的就用。基本不会再撞这个问题。

如果运行时仍然看到 `WARNING: no writable tmp dir found. Tried in order: ...` 的提示，意味着这四个候选都不可写。修法：

```bash
# 显式指定一个保证能写的绝对路径
export OPENCODE_TOOLKIT_TMP_DIR="$HOME/some/dir"   # Linux/macOS
setx OPENCODE_TOOLKIT_TMP_DIR "C:\path\to\dir"     # Windows（永久）
```

升级到 v0.2.6 即可。

### 审查员揪着"中间过程错过一次"判 incomplete，即便最终结果是对的

v0.2.6 之前的审查员 prompt 写"疑罪从有：只要任意一条审查清单触发就判 incomplete"，且 G 段把"工具反复重试 / 同一文件多次 patch"视为风险信号。结果：subagent 中途出过 tool 错误后自己纠正、改错过文件再重写、retry 几次终于成功 —— 这些**健康行为**被惩罚，verdict 变成 incomplete + reasons 引用历史污点，触发不必要的续跑。

v0.2.6 起 agent prompt 引入"判定基础"元原则：**只看终态**，明确把"中间失败但后续恢复"列为**非** incomplete 信号，并在决策原则里要求 reasons 必须基于终态而非过程。

升级到 v0.2.6 即可。

### Windows 上审查员只看到默认 system prompt（看不到 ORIGINAL_REQUEST/FILE_CHANGES 等）

v0.2.0 的具体表现：每次 task 工具结束时审查员被拉起，但 LLM 像没收到任何 user message 一样直接按 system prompt 回应；review 内容跟你的真实 subagent 任务毫无关系，verdict 经常是 incomplete 但 reasons 都是空泛的。

根因：Windows `cmd.exe` 包装 `.cmd` 时——
1. argv 里的 `\n` 会被当成命令终止符，多行 markdown 的第一行之后全部丢失；
2. 命令行长度上限 8191 字符容易被长 markdown 报告爆掉；
3. `< > & | ^` 等 markdown 里常见字符与 cmd 元字符冲突。

v0.2.6 起把 markdown 报告写到操作系统临时目录，argv 仅传 `INPUT_FILE <绝对路径>` 两个 ASCII token，审查员 agent 用 `read` 工具读文件——三平台一致行为。

升级到 v0.2.6 即可，无其它操作。

### 启动后 agent 没出现 / hook 完全不生效

最常见原因：`opencode.json` 里的 plugin spec 写成了纯 `"github:user/repo#tag"`。

opencode 用 `npm-package-arg` 解析 spec、取 `.name` 字段去 `node_modules/<name>/` 找入口；github 简写形式 `.name` 为 null，opencode 退化为把整段 spec 当 name，于是去 `node_modules/github:user/repo#tag/` 找 → ENOENT，**整个 plugin 加载失败**，hook 一个都不会注册。

排查：

```bash
# 看最新一次 opencode 启动的日志，搜 "failed to resolve plugin server entry"
ls -t ~/.local/share/opencode/log/ | head -1 \
  | xargs -I{} grep -E "plugin|toolkit" ~/.local/share/opencode/log/{}
```

修复：把 spec 改成 `"opencode-toolkit@github:user/repo#tag"`，然后清掉错装的缓存：

```bash
rm -rf "$HOME/.cache/opencode/packages/github:"*opencode-toolkit*
rm -rf "$HOME/.cache/opencode/packages/opencode-toolkit"*  # 同时清理可能存在的命名版本残留
# 工程里若有错版残留也一并清掉：
rm -rf <工程>/.opencode/{node_modules,package-lock.json,package.json}
rm -f <工程>/.opencode/agent/task-completion-checker.md  # 旧 symlink 指向已删的 cache
```

下次启动会重装，再下次启动 agent + hook 全部就位。

### 启动了一次 agent 还是没出现

预期行为，见上面"启动两次"的说明。第二次启动起就有了。

## 跨平台支持

v0.2.6 起完整支持 **Linux / macOS / Windows**：

| 关键点 | Linux/macOS | Windows |
|---|---|---|
| spawn 审查员子进程 | `child_process.spawn` 直接执行 `opencode` | 通过 `cross-spawn` 正确处理 `opencode.cmd` |
| agent 文件分发 | symlink（toolkit 升级即文件升级） | 普通用户无 symlink 权限时自动降级为 copy |
| copy 模式下的升级 | 不涉及 | marker 文件记 `srcHash`，下次安装用 hash 判定"是 toolkit 上次写的" vs "用户改过的"，前者自动覆盖、后者保留 |

Windows 用户也能像 Linux/macOS 一样**自动获得 toolkit 升级**——不再需要每次 toolkit bump 后手动重跑 `npx opencode-toolkit-install`（plugin factory 启动时会自动检测并刷新 copy）。

如果 Windows 用户开启了 Developer Mode（`Settings → Update & Security → For developers`），`fs.symlinkSync` 也能成功，会走和 Linux/macOS 一样的 symlink 路径，体验完全一致。

## 维护者：怎么加新 agent / skill

- 新 agent：直接放 `agents/<name>.md`，frontmatter 带 `mode: all`（CLI 可调）。下个版本团队成员升级后自动可用。
- 新 skill：放 `skills/<name>/SKILL.md`，结构按 opencode skill 规范。无需改 plugin 代码。
- 调整 subagent-resumer 插件行为：改 `src/subagent-resumer.ts`。
- 加新插件：新建 `src/<feature>.ts`，然后在 `src/index.ts` 里把所有子插件的 hooks 合并到一个 Plugin 工厂一并返回（`src/index.ts` 头部注释里有合并模板）。
- 调整 agent 安装逻辑：改 `src/installer.ts` 同时同步 `bin/install.mjs`。

## 发版流程

```bash
# 1. 打 tag
git tag v0.1.1
git push --tags

# 2. （如发 npm）
npm publish --access public

# 3. 团队成员升级
# 私有 git URL 写法：bump opencode.json 里的 #vX.Y.Z
# npm 写法：opencode 启动时 npmSvc 自动拉 latest
```

## 目录结构

```
opencode-toolkit/
├── package.json              # exports."./server" + bin
├── README.md
├── src/
│   ├── index.ts              # Toolkit 总入口（barrel）；多插件合并点
│   ├── subagent-resumer.ts   # 当前插件：subagent 完成度审查 + 自动续跑
│   └── installer.ts          # agent symlink 安装逻辑（plugin 内调用）
├── bin/
│   └── install.mjs           # 命令行 installer（npx 入口，纯 ESM）
├── agents/
│   └── task-completion-checker.md
└── skills/
    └── (放新 skill 在这里)
```
