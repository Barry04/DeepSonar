# REA CLI 深度二进制解析能力（#718）

> **状态：进行中（PR3 已完成项目目录种子与 Job 路径门禁；PR2 已完成 amd64 实跑与行为门禁）**。镜像矩阵见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)；通用 CLI 包见 [`CLI_CAPABILITIES.md`](CLI_CAPABILITIES.md)；工具手册契约见 [`RUNTIME_TOOL_MANUALS.md`](RUNTIME_TOOL_MANUALS.md)。

## 目标

按需为 DeepSonar 增加 **CLI-only** 的深度原生二进制解析：通过钉死的 [REA](https://github.com/morluto/rea)（`rea-agents@6.4.0`）驱动 Ghidra 12.1.4，对 ELF / `.so` / PE 获取函数伪代码、汇编、调用关系、交叉引用与有界静态值流，并接入现有 Evidence 链。

## 架构约束

- **平台是控制面**：allowlist / 准入 / 镜像 digest；AI 运行时选型。不引入固定角色、MCP、常驻 REA 服务或第二执行通道。
- **项目 opt-in 镜像** `deepsonar-reverse`：从 `deepsonar-base` 派生；**不改变全局默认镜像**；**不把 Ghidra 塞进 `deepsonar-mobile`**。
- 硬控制沿用 Job 沙箱 CPU/内存/PIDs、网络策略、deadline、取消与 Reaper。薄 CLI launcher **不**提供不可绕过的累计调用计数器。

## 钉死基线

| 组件 | 版本 / 完整性 |
| --- | --- |
| rea-agents | `6.4.0`，gitHead `a56f7bb668ab23fec8d33f7af353ac7ed2fe1895`，npm integrity 构建期校验 |
| Ghidra | `12.1.4` PUBLIC zip，SHA-256 `ddac49f9…d4db` |
| JDK | 完整 64 位 Temurin 21（`JAVA_HOME=/opt/deepsonar/jdks/21`） |
| Node | ≥ `22.19.0`（继承 base，构建期校验） |

## 受治理能力

| 能力 ID | 工具 | 兼容镜像 | 说明 |
| --- | --- | --- | --- |
| `binary.rea.cli` | `rea` / `rea-agents` | `deepsonar-reverse` | analyze / search / function / decompile / instructions / xrefs / trace-native-values / inspect-analysis-view |

Hub 通过 Intent `cli_capability_ids` 提案；Scheduler `admitCliCapabilities` 校验后冻结。结果 schema 仍为 `deepsonar.cli-capability-result/v1`（`is_finding: false`）。缺失能力 / 非 `deepsonar-reverse` 镜像 → `capability_unavailable`。

## 受治理 Skill

- 路径：`skills/deepsonar-rea-cli/SKILL.md`
- 内容哈希：见 `agent-harness/reverse-runtime.json` → `skill.content_hash`（静态门禁校验）
- 用途：指导 Agent 在 `deepsonar-reverse` 内按 CLI/证据边界调用 REA；**不是** MCP 注册说明书

## amd64 实测（PR2）

验证方式：validation host 无 docker，在 scratch 目录安装与镜像相同的钉死工具链（Node 22.20 / Temurin 21 / Ghidra 12.1.4 / rea-agents@6.4.0），对公开样本 `agent-harness/fixtures/reverse-sample/sample.c` 实跑。完整数字见 [`agent-harness/reverse-amd64-measurements.json`](../agent-harness/reverse-amd64-measurements.json)。

| 指标 | 结果 |
| --- | --- |
| 冷启动 `analyze` | ≈ 12.8 s；峰值 RSS ≈ 3.3 GiB |
| 重复 `analyze`（`--snapshot`） | ≈ 1.6 s |
| `function` / `decompile` / `xrefs` / `search` / `instructions` | ≈ 12–13 s |
| 有界 `trace-native-values` | ≈ 18 s（不支持 `--snapshot`） |
| `inspect-analysis-view` | ≈ 1.3 s（需 inline Evidence + native facet） |
| 取消（SIGTERM） | ≈ 4.3 s 返回 `cancelled`；无残留 `java` |
| 组件解压体积（jdk+ghidra+rea） | ≈ 1285 MiB |
| 镜像压缩预算 | **暂定 2800 MiB**（待首次 OCI `docker save`） |
| Job 资源建议 | memory ≥ **4096 MiB**，CPU ≥ 2，timeout 600 s |
| arm64 | **pending** |

### 已知限制

- `--snapshot` 是精确查询缓存，不是持久 Ghidra 工程；`function`/`decompile` 等仍可能重新导入。
- `trace-native-values` / `inspect-analysis-view` 不接受 `--snapshot`。
- `inspect-analysis-view` 输入必须是 `{source:{kind:"inline"|"retained-evidence"}, view:{...}}`。
- 伪代码 / 静态值流 ≠ 原始源码 / 动态证明 / 已验证漏洞。
- 完整镜像内冷启动与 OCI 压缩体积仍待首次 reverse 镜像构建。

## 项目启用（PR3）

- `database/schema.sql` 官方目录种子包含 `deepsonar-reverse`：`official=true`、`project_opt_in=true`、`enabled=true`，描述与 `deploy/runtime-image-registry.json` 一致；`db:rebuild` 回填同一条种子。`DEFAULT_RUNTIME_IMAGE_BY_ROLE` 不变（Test→kali-minimal、Audit→audit、其余→base），reverse 永不成为角色默认。
- 按 #691 当前模型，`project_opt_in` 是元数据：启动 warmup 跳过（`isStartupRequiredRuntimeImage=false`），全局作用域 real 预检返回 `RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED`，必须在具体项目内评估。
- 项目作用域内官方镜像缺行即默认可用；项目可经 `PUT /projects/:id/runtime-images/:imageId` 显式排除，排除后预检返回 `RUNTIME_IMAGE_PROJECT_NOT_ENABLED`，Job 创建 `resolveRuntimeImageForJob` 同样拒绝。
- 真正可执行仍取决于平台目录中存在 trusted digest；首个 reverse digest 发布前 registry `versions: []`，预检会如实报告镜像不可用。

## 受治理 Job 路径（PR3）

无 docker 时用真实契约 + 夹具覆盖整条路径（`apps/scheduler/src/domains/cli-capability/rea-cli-job-e2e.test.ts`）：

1. **Skill 发现/拉取**：按受信 Skill 源同步方式扫描 `skills/`，`list_available_skills` / `search_skills` 返回 `deepsonar-rea-cli` 的 selector 与 content hash；`pull_skill` 只在 hash 匹配时返回文件，拉到的 `SKILL.md` 字节哈希必须等于 `reverse-runtime.json` 的 `skill.content_hash`；过期 hash、宽 selector、未知模块一律拒绝。
2. **能力发现与准入**：`search_capabilities` / `describe_capability` 能找到 `binary.rea.cli`；`admitCliCapabilities` 只在 `deepsonar-reverse` 冻结，manifest 的 `tool_version` / timeout 与 `reverse-runtime.json` 一致；mobile/base 等镜像返回 `incompatible_image`，安装请求返回 `install_forbidden`。
3. **Evidence 归一化**：成功 / 非零 / 截断 / 部分 JSON / 超时 / 取消逐一贯穿到 Fact，不完整结果在描述与 Artifact 扩展中保持 `inconclusive`；清理前保留 `evidence_ref`，删除 Ghidra 临时工程。
4. **Fact/Artifact 提交**：`buildReaCliFactProposal` 把一次观察映射为 `emit_fact` 提案：不带 `verification`，claim/evidence 一律 `unknown`，原始 stdout 不进 Fact（只引用留存的 evidence），元数据进 Artifact 扩展 `binary.rea-cli`（能力 id、工具版本、exit、截断、样本 SHA-256、镜像 digest、argv）。
5. **Verify 独立**：原始 `CliCapabilityResult` 不能当作 `emit_fact` / `emit_finding` 载荷；REA 观察 Fact 不满足结构化验证 Fact，Fact-first confirm 门返回 `insufficient`；`exit_code=0` 本身也不是 runtime proof。

项目启用门禁见 `apps/scheduler/src/reverse-runtime-project-opt-in.test.ts`（种子、回填、warmup、#691 排除、预检作用域、Hub 目录投影）。

## 行为门禁（CI）

Scheduler 单元测试覆盖 Evidence 归一化路径：成功、非零退出、截断、部分 JSON、超时、取消、清理计划，以及缺失能力 / 未准入镜像拒绝；PR3 增加上面的 Job 路径与项目启用门禁（分别接入 `ci:unit:capability-pack` / `ci:unit:cli-capability` 与 `ci:unit:runtime-images`）。

```bash
pnpm ci:unit:cli-capability
pnpm ci:unit:runtime-images
node agent-harness/test-reverse-runtime.mjs
pnpm ci:images
```

## 仍待 follow-up

- `.github/workflows/reverse-runtime.yml` 与 `release.yml` reverse 发布 job（需 GitHub `workflow` scope）
- 首次发布 `deepsonar-reverse` digest 后回填 registry `versions` 并用 `docker save` 校准 `maxSizeMiB`
- arm64 native decompiler 对等实测
- 首个 digest 发布后在真实沙箱跑一次 Job（契约门禁已由 PR3 覆盖，真实镜像内实跑仍待 OCI 镜像）
