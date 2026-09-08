# 发版流程

1. 确保 `nova-agent` 与 `nova-studio` 使用相同版本号和 tag，例如 `v1.4.0`。
2. 在 `nova-studio` 仓库创建 Actions Secret：`NOVA_AGENT_RELEASE_TOKEN`。
   Token 需要对 `DongZiJie1/nova-agent` 拥有 `Contents: Read and write` 权限。
3. 先发布 `nova-agent`，确认同名 GitHub Release 已存在。
4. 再给 `nova-studio` 推送同名 tag：

   ```bash
   git tag v1.4.0
   git push origin v1.4.0
   ```

5. `nova-studio` CI 会构建 macOS/Windows 安装包，并同时上传到：
   - `DongZiJie1/nova-studio` 的同名 Release
   - `DongZiJie1/nova-agent` 的同名 Release

6. 检查两个 Release 中均存在 `.dmg` 和 `.exe` 安装包。

失败重跑：确认 Agent Release 已存在且 Token 有效，然后重新运行 `nova-studio` 的 `Build & Release` workflow。
