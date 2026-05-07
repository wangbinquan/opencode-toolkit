# opencode-toolkit

团队共享的 [opencode](https://opencode.ai) 工具包。一个 npm 包同时分发三类资产，跨平台支持 **Linux / macOS / Windows**：

- **Plugin**：`tool.execute.after` 钩子上的 subagent 任务完成度审查 + 自动续跑
- **Agents**（`agents/`）：审查员 agent `task-completion-checker`
- **Skills**（`skills/`）：通过 `config.skills.paths` 注入到 opencode

## 团队成员接入（两步）

### 1. 在工程根 `opencode.json` 里声明插件

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-toolkit@github:wangbinquan/opencode-toolkit#v0.2.5"]
}
```

> ⚠️ **必须用 `<包名>@<spec>` 形式**，不能写成纯 `"github:wangbinquan/opencode-toolkit#v0.1.1"`。
> opencode 用 `npm-package-arg` 解析 spec 取 `name` 字段，github 简写形式 `name` 字段为 null，会让 opencode 把整段 spec 当包名去 `node_modules/<整段 spec>/` 里找入口，必然 ENOENT。
> 加上 `opencode-toolkit@` 前缀让 npa 正确解析，npm/arborist 仍按 github URL 拉代码并装到 `node_modules/opencode-toolkit/`。

也支持：

- 私有 git URL：`"opencode-toolkit@git+ssh://git@your.git/...#v0.2.5"`
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

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_TOOLKIT_MAX_RETRIES` | `3` | 续跑次数上限 |
| `OPENCODE_TOOLKIT_REVIEWER_AGENT` | `task-completion-checker` | 审查员 agent 名 |
| `OPENCODE_TOOLKIT_OPENCODE_BIN` | `opencode` | opencode 可执行文件路径 |
| `OPENCODE_TOOLKIT_TIMEOUT_MS` | `180000` | 单次审查超时 |
| `OPENCODE_TOOLKIT_TAIL_MESSAGES` | `6` | 传给审查员的会话尾部消息条数 |
| `OPENCODE_TOOLKIT_TMP_DIR` | （自动选） | 审查员 prompt 临时文件的目录。默认按 `<工程>/.opencode/.toolkit-tmp/` → `os.tmpdir()` → `~/.opencode-toolkit-tmp/` 顺序探测可写目录（项目内优先，避免审查员 read 触发 external_directory 权限询问）；只在特殊环境需要显式指定 |

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

## 故障排查

### Windows 用户报"插件不工作"

v0.2.0 之前的版本在 Windows 上跑 `opencode.cmd` 时 `child_process.spawn` 会被 Node 18.20+/20.12+ 的 CVE 修复拒绝；同时 symlink 默认在 Windows 上需要管理员/Developer Mode 权限。

升级到 v0.2.5+ 即可。spec 改成 `"opencode-toolkit@github:wangbinquan/opencode-toolkit#v0.2.5"`，重启 opencode。

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

**修法（v0.2.5）**：判决格式从 JSON 换成 XML 标签：

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

升级到 v0.2.5 即可。

### 报"无法写入临时文件"或 reviewer 拿不到判决（v0.2.3 及之前）

**实际症状**：插件**确实**写入了 `os.tmpdir()` 下的 prompt 文件，但审查员子进程的 `read` 工具读不到——opencode 的 `external_directory` 权限规则（默认 `ask`）把系统 tmp 视为外部目录、`opencode run` 非交互模式下要么自动 deny 要么挂起。失败的错误信息看起来像"prompt 写不出去"，其实是"审查员读不进来"。日志里能看到这种行：

```
service=permission permission=external_directory
  pattern=/var/folders/.../T/*
  action={"permission":"external_directory","action":"ask"} evaluated
```

v0.2.5 起把候选顺序里**项目内目录提到 `os.tmpdir()` 之前**：默认走 `<工程>/.opencode/.toolkit-tmp/`，read 走 within-project 路径直接命中 `read: *: allow`，不再触发 external_directory ask。同时自动写 `.gitignore` 避免污染 git，每次 plugin load 顺手清理超 1 小时的陈年残留。

升级到 v0.2.5 即可。

### 报错 "failed to write reviewer prompt to ..."（受限环境 / 只读 tmp）

v0.2.1 ~ v0.2.5 在 `os.tmpdir()` 单点不可写时直接放弃审查（受限的企业 Windows 把 `%TEMP%` 改到只读路径、只读容器 /tmp、用户 perm 错乱都可能触发）。

v0.2.5 起会按候选链探测可写目录：`OPENCODE_TOOLKIT_TMP_DIR` → `os.tmpdir()` → `<工程>/.opencode/.toolkit-tmp/` → `~/.opencode-toolkit-tmp/`，第一个能 mkdir + 写探针 + 删除的就用。基本不会再撞这个问题。

如果运行时仍然看到 `WARNING: no writable tmp dir found. Tried in order: ...` 的提示，意味着这四个候选都不可写。修法：

```bash
# 显式指定一个保证能写的绝对路径
export OPENCODE_TOOLKIT_TMP_DIR="$HOME/some/dir"   # Linux/macOS
setx OPENCODE_TOOLKIT_TMP_DIR "C:\path\to\dir"     # Windows（永久）
```

升级到 v0.2.5 即可。

### 审查员揪着"中间过程错过一次"判 incomplete，即便最终结果是对的

v0.2.5 之前的审查员 prompt 写"疑罪从有：只要任意一条审查清单触发就判 incomplete"，且 G 段把"工具反复重试 / 同一文件多次 patch"视为风险信号。结果：subagent 中途出过 tool 错误后自己纠正、改错过文件再重写、retry 几次终于成功 —— 这些**健康行为**被惩罚，verdict 变成 incomplete + reasons 引用历史污点，触发不必要的续跑。

v0.2.5 起 agent prompt 引入"判定基础"元原则：**只看终态**，明确把"中间失败但后续恢复"列为**非** incomplete 信号，并在决策原则里要求 reasons 必须基于终态而非过程。

升级到 v0.2.5 即可。

### Windows 上审查员只看到默认 system prompt（看不到 ORIGINAL_REQUEST/FILE_CHANGES 等）

v0.2.0 的具体表现：每次 task 工具结束时审查员被拉起，但 LLM 像没收到任何 user message 一样直接按 system prompt 回应；review 内容跟你的真实 subagent 任务毫无关系，verdict 经常是 incomplete 但 reasons 都是空泛的。

根因：Windows `cmd.exe` 包装 `.cmd` 时——
1. argv 里的 `\n` 会被当成命令终止符，多行 markdown 的第一行之后全部丢失；
2. 命令行长度上限 8191 字符容易被长 markdown 报告爆掉；
3. `< > & | ^` 等 markdown 里常见字符与 cmd 元字符冲突。

v0.2.5 起把 markdown 报告写到操作系统临时目录，argv 仅传 `INPUT_FILE <绝对路径>` 两个 ASCII token，审查员 agent 用 `read` 工具读文件——三平台一致行为。

升级到 v0.2.5 即可，无其它操作。

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

v0.2.5 起完整支持 **Linux / macOS / Windows**：

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
