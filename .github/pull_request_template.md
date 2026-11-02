## 变更类型 (Type)
<!-- 请勾选适用的类型 -->
- [ ] `feat`: 新增功能
- [ ] `fix`: 缺陷修复
- [ ] `style`: 样式、布局与视觉优化（不影响业务逻辑）
- [ ] `chore`: 构建配置、依赖、工作流或发布相关调整
- [ ] `docs`: 文档、规范或发布日志更新
- [ ] `test`: 增加或修改测试用例
- [ ] `refactor`: 重构（既无新功能也不修复 bug）

## 目标分支 (Target)
<!-- 功能与修复分支一律合入 develop；只有发布或阶段交付才由 develop 合入 main -->
- [ ] 合入 `develop`
- [ ] 由 `develop` 合入 `main`（发布 / 阶段交付，需说明原因）

## 变更说明 (Description)
<!-- 简要说明本次 PR 的修改内容及原因，避免堆砌内部实现细节 -->
- 

## 本地验证情况 (Verification)
<!-- 提交 PR 前必须在本地执行与改动相关的验证，并记录实际结果（如测试通过数） -->
- [ ] `npm test` 前端测试: 
- [ ] `npm run build` TypeScript 与 Vite 构建: 
- [ ] `npm run test:platform` 平台契约测试: 
- [ ] 其他专项验证（如 `npm run test:kernel` / `npm run test:sandbox` / `npm run upstream:check`）: 

## 关联 Issue / PR
<!-- 例如: Fixes #123, Relates to #456 -->
- 

## 发布提醒 (Release Checklist)
<!-- 若本次 PR 涉及版本发布 (chore: 发布轻作 vX.Y.Z)，请确认以下项已完成 -->
- [ ] `package.json` 与 `package-lock.json` 版本号已同步
- [ ] `docs/release-guide.md` 版本号已更新
- [ ] `docs/releases/vX.Y.Z.md` 发布日志已补充
