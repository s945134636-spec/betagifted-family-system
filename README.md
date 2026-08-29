# Family System

Family System 是面向中文家庭的本地优先 Obsidian 管理插件。家庭资料、菜单、采购、库存、事务、财务和资产都保存在你的 Vault 中；核心插件不需要账号、服务器、遥测、CloudKit、银行连接或插件内 AI。

当前候选版本为 `2.3.0`，插件 ID 为 `betagifted-family-system`，最低支持 Obsidian `1.8.10`。它延续 `family-system/store-v4`、EffectSet v2 和 2.2 的数据合同，不会把旧数据重写成另一套格式。

> 发行状态：源码与自动化候选已建立。真实 Obsidian 1.8.10、当前稳定版、实体 iPhone 和七天连续运行仍是社区提交前的硬门槛；未完成前不把测试渲染图称作实机截图，也不发布正式 Community Release。

## 第一次使用

1. 将 Release 中的 `manifest.json`、`main.js`、`styles.css` 放入 Vault 的 `.obsidian/plugins/betagifted-family-system/`。
2. 在 Obsidian 设置中启用 Family System，并打开左侧功能区的家庭图标。
3. 首次使用向导会解释本地数据与隐私边界，并请你确认家庭名称和路径。默认权威目录与数据目录都位于 `家庭管理系统/` 子目录。
4. 预览确认后，插件一次性建立 store-v4、六份空白 Markdown、家庭身份和“家庭采购 / 食材处理 / 家庭事务”三个基础事务分类。不会写入示例成员、菜谱、交易或其他仿真家庭资料。

六份 Markdown 保存适合阅读维护的定义事实，`life-core/records/` 保存持续发生的运行事实。`life-core/projections/` 只是可重建总览，不是第二份台账。

## 备份与恢复

- “创建便携备份”生成可校验的 `family-system/backup-v1` JSON，包含六份权威 Markdown、菜单草稿、运行记录、事件、关系、操作和校验哈希。
- “校验最近备份”会核对每个文件及整个备份包的 SHA-256。
- “恢复到候选目录”只写入一个全新的候选目录并生成恢复报告，不会覆盖当前数据，也不会自动切换插件路径。
- 升级前可运行“检查 2.3 升级准备情况”；发现权威冲突、未恢复操作或不兼容 store 时会阻止继续。

备份文件本身可能包含完整家庭资料。请像保护 Vault 一样保护它，不要上传到公开仓库、网盘分享链接或问题反馈附件。

## 升级与卸载

2.2 用户应先创建并校验便携备份，再替换插件三文件。2.3 只增加首次向导、备份恢复和界面状态设置；store-v4 业务记录保持兼容。

禁用或卸载插件不会删除六份 Markdown、Life Core、备份、菜单草稿或 Apple 提醒。若要移除插件，只删除 `.obsidian/plugins/betagifted-family-system/` 下的插件程序文件；是否保留业务资料由用户单独决定。插件内部需要删除文件时统一使用 Obsidian 回收站接口。

## 移动端与离线

核心功能只使用 Obsidian Vault API，可在没有 Mac 或 Apple Reminders 的情况下运行。移动端需保证数据目录位于当前 Vault 内。离线编辑会先写本地 Vault；跨设备同时写入通过短租约、revision 和 hash 防止静默覆盖，但同步服务本身不属于插件事务。

## 可选 Apple Beta

Apple 集成默认关闭，也不包含在 Community Release 中。独立 Beta 仓库为 `s945134636-spec/betagifted-family-system-apple-beta`，首版限定 Apple Silicon、macOS 14+，未公证，只监听 `127.0.0.1:41729`。

用户主动开启 Apple 集成并在当前会话填入配对凭据后，插件才会访问本机回环服务。凭据不写入 Vault、插件设置、源码、日志或 ZIP。Apple Reminders 只承担“家庭采购 / 食材处理 / 家庭事务”的执行投影，不拥有任务、付款、实收或库存事实；禁用或卸载插件不会删除提醒。

## 隐私与网络

- 默认不发起任何网络请求。
- 不收集遥测、崩溃报告或使用数据。
- 不包含登录、付费、广告、远程服务或第三方 API。
- 唯一允许的通信是用户显式启用后的 `127.0.0.1` Apple Beta 回环访问。
- 问题反馈前请删除真实姓名、地址、证件、账号、交易、健康资料、家庭 ID、绝对路径和配对凭据。

详见 [PRIVACY.md](PRIVACY.md)。

## 从源码构建与测试

需要 Node.js 18 或更高版本：

```bash
npm install
npm run build
npm test
npm run test:layout
```

默认分支不提交构建后的 `main.js`。正式 GitHub Release 的附件严格只有：

```text
manifest.json
main.js
styles.css
```

## 许可证与贡献

源码以 MIT 许可证发布。提交 issue 或 pull request 时只能使用脱敏、人工构造的数据；不要上传个人 Vault、便携备份、Apple 状态文件或真实快捷指令配置。
