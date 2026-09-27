---
handoff_version: 3
handoff_revision: 1
project_id:
task_id:
task:
task_type: code
created_at:
updated_at:
owner: ChatGPT
status: DRAFT
project_root:
project_rules:
handoff_dir:
codex_worktree:
branch:
base_commit:
spec_hash:
root_rules_hash:
project_rules_hash:
allow_real_system_write: false
allow_bulk_write: false
allow_final_submit: false
allow_git_push: false
allow_external_upload: false
---

# Current Handoff

## Goal

<!-- 一句话写清最终目标 -->

## State Machine / Intended Flow

<!-- 代码任务写执行/验证流；非代码任务写交付流 -->

## Confirmed Facts

<!-- 只写有证据支持的事实；大日志只引用路径和时间段 -->
-

## Unknowns to Diagnose

-

## Evidence References

- Logs:
- DOM / network / screenshot:
- Relevant files / sources:

## Delegated Scope

Codex may:
- inspect:
- modify / produce:
- add tests / evidence:

Codex may NOT:
- change unrelated business rules
- exceed the side-effect policy
- merge/push formal branch unless explicitly allowed

## Codex Technical Acceptance

### For code tasks
- [ ] 根因有充分证据
- [ ] 最小修复完成
- [ ] targeted tests 通过
- [ ] regression / safety tests 通过
- [ ] 独立 commit 完成

### For non-code tasks
- [ ] 交付物已生成
- [ ] 验收证据已记录
- [ ] 剩余风险已列明

## ChatGPT Business Acceptance

- [ ]

## Deliverables

<!-- 非代码任务必须明确交付物路径/格式；代码任务可写 commit/文件范围 -->
-

## Side-effect Notes

<!-- 说明真实系统是否允许保存、提交、上传；front matter 布尔值是机器校验依据 -->

## Stop Conditions

- 证据不足时停止，不为“复现”而对真实数据做额外写入。
- 已实施假设与真实结果冲突时停止修改，回到只读证据。
- 需求/验收标准变化时，不在 IN_PROGRESS handoff 上直接改；创建新 revision。
