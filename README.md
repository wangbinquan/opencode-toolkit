# opencode-toolkit

团队共享的 [opencode](https://opencode.ai) 工具包。一个 npm 包同时分发三类资产：

- **Plugin**：`tool.execute.after` 钩子上的 subagent 任务完成度审查 + 自动续跑
- **Agents**（`agents/`）：审查员 agent `task-completion-checker`
- **Skills**（`skills/`）：通过 `config.skills.paths` 注入到 opencode

## 团队成员接入（两步）

### 1. 在工程根 `opencode.json` 里声明插件

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:wangbinquan/opencode-toolkit"]
}
```

也支持：

- 私有 git URL：`"git+ssh://git@your.git/...#v0.1.0"`
- 私有 npm registry：`"@your-scope/opencode-toolkit"`（先在 `.npmrc` 配 scope registry）
- 本地路径（开发期）：`"file:///abs/path/to/opencode-toolkit"`

### 2. 第一次跑前手动安装一次 agent

```bash
npx opencode-toolkit-install
```

**为什么需要这一步**：opencode 在配置启动期就扫描 `.opencode/agent/`，**早于** plugin 加载。所以插件第一次 load 时写出来的 agent symlink 对**当次启动看不见**，要下次启动才能用。这条命令把 agent 提前铺好，免得团队成员被"为什么 reviewer 找不到"困扰。

如果嫌麻烦不跑，启动两次 opencode 也行——首次启动插件会写 symlink、第二次启动 opencode 才扫到。

接入完成后，`pnpm install` / `npm install` / 启动 opencode 时的后台 install 会拉最新 toolkit；agent 内容因为是 symlink，**自动跟新**。

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

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_TOOLKIT_MAX_RETRIES` | `3` | 续跑次数上限 |
| `OPENCODE_TOOLKIT_REVIEWER_AGENT` | `task-completion-checker` | 审查员 agent 名 |
| `OPENCODE_TOOLKIT_OPENCODE_BIN` | `opencode` | opencode 可执行文件路径 |
| `OPENCODE_TOOLKIT_TIMEOUT_MS` | `180000` | 单次审查超时 |
| `OPENCODE_TOOLKIT_TAIL_MESSAGES` | `6` | 传给审查员的会话尾部消息条数 |

兼容旧名 `SUBAGENT_RESUMER_*`。

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

## Windows 注意

普通用户没建 symlink 权限，`installer.ts` 会自动降级为 copy。代价：toolkit 升级后**需要再跑一次** `npx opencode-toolkit-install` 才能更新 agent 内容。Linux/macOS 无此问题。

## 维护者：怎么加新 agent / skill

- 新 agent：直接放 `agents/<name>.md`，frontmatter 带 `mode: all`（CLI 可调）。下个版本团队成员升级后自动可用。
- 新 skill：放 `skills/<name>/SKILL.md`，结构按 opencode skill 规范。无需改 plugin 代码。
- 调整插件钩子行为：改 `src/index.ts`。
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
│   ├── index.ts              # Plugin 工厂 + 钩子
│   └── installer.ts          # agent symlink 安装逻辑（plugin 内调用）
├── bin/
│   └── install.mjs           # 命令行 installer（npx 入口，纯 ESM）
├── agents/
│   └── task-completion-checker.md
└── skills/
    └── (放新 skill 在这里)
```
