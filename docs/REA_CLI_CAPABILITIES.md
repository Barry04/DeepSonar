# REA CLI 深度二进制解析能力（#718）

> **状态：进行中（PR1 接线）**。镜像矩阵见 [`RUNTIME_ROLE_IMAGE_MATRIX.md`](RUNTIME_ROLE_IMAGE_MATRIX.md)；通用 CLI 包见 [`CLI_CAPABILITIES.md`](CLI_CAPABILITIES.md)；工具手册契约见 [`RUNTIME_TOOL_MANUALS.md`](RUNTIME_TOOL_MANUALS.md)。

## 目标

按需为 DeepSonar 增加 **CLI-only** 的深度原生二进制解析：通过钉死的 [REA](https://github.com/morluto/rea)（`rea-agents@6.4.0`）驱动 Ghidra 12.1.4，对 ELF / `.so` / PE 获取函数伪代码、汇编、调用关系、交叉引用与有界静态值流，并接入现有 Evidence 链。

## 架构约束

- **平台是控制面**：allowlist / 准入 / 镜像 digest；AI 运行时选型。不引入固定角色、MCP、常驻 REA 服务或第二执行通道。
- **项目 opt-in 镜像** `deepsonar-reverse`：从 `deepsonar-base` 派生；**不改变全局默认镜像**；**不把 Ghidra 塞进 `deepsonar-mobile`**。
- 硬控制沿用 Job 沙箱 CPU/内存/PIDs、网络策略、deadline、取消与 Reaper。薄 CLI launcher **不**提供不可绕过的累计调用计数器。

## 钉死基线（PR1）

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

Hub 通过 Intent `cli_capability_ids` 提案；Scheduler `admitCliCapabilities` 校验后冻结。结果 schema 仍为 `deepsonar.cli-capability-result/v1`（`is_finding: false`）。

## 受治理 Skill

- 路径：`skills/deepsonar-rea-cli/SKILL.md`
- 内容哈希：见 `agent-harness/reverse-runtime.json` → `skill.content_hash`（静态门禁校验）
- 用途：指导 Agent 在 `deepsonar-reverse` 内按 CLI/证据边界调用 REA；**不是** MCP 注册说明书

## PR1 已接线 / 未验收

**已接线**：Dockerfile / runtime manifest / tool manifest / 离线手册 / fingerprint / registry（`versions: []`）/ Image Admission 一致性门禁 / CLI 目录 / Skill / Hub 能力表 / Scheduler 专项边界 / 文档索引。

**本 PR 未包含** `.github/workflows/reverse-runtime.yml` 与 release 发布 job（推送需 GitHub `workflow` scope）；须在首次发布 `deepsonar-reverse` digest 前的 follow-up 中补齐。

**尚未用真实样本验收（跟进 PR）**：amd64/arm64 native decompiler 实跑、镜像体积与冷启动测量、Job 端到端 Evidence 闭环、超时/取消/截断行为门禁、项目显式启用前的准入放行。

## 测试

```bash
pnpm ci:unit:cli-capability
node agent-harness/test-reverse-runtime.mjs
pnpm ci:images
```
