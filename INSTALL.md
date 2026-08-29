# Family System 2.3.0 安装、升级与卸载

## 普通安装

从 GitHub Release `2.3.0` 单独下载 `manifest.json`、`main.js`、`styles.css`，放入：

```text
<你的 Vault>/.obsidian/plugins/betagifted-family-system/
```

重启 Obsidian，在“第三方插件”中启用 Family System。首次向导会在你确认预览后创建数据；安装过程无需终端。

## 从 2.2 升级

1. 在 2.2/2.3 设置页创建并校验便携备份。
2. 运行升级前检查，处理权威冲突或未恢复操作。
3. 关闭 Obsidian，只替换插件目录中的三份程序文件。
4. 重启并核对家庭名称、六份权威模块、当前菜单、采购、库存、事务与最近事件。

2.3 不改变 store-v4 业务数据合同。不得用旧 store-v3、旧 Vault 或历史备份覆盖已经产生新写入的 store-v4。

## 恢复预演

在设置页选择一个位于 Vault 内、尚不存在或为空的候选目录。插件校验 `family-system/backup-v1` 后，只向该目录写入完整候选和报告，不覆盖当前目录、不自动切换。核对完成后如需正式切换，应停止所有设备写入并另行确认。

## 卸载

禁用插件后删除 `.obsidian/plugins/betagifted-family-system/` 中的程序文件即可。业务 Markdown、Life Core、备份、草稿和 Apple 提醒均保留；插件不会在卸载时关闭用户页面或删除家庭资料。

如用户决定永久清除业务资料，应先校验独立备份，再由用户在 Obsidian 文件管理器中明确选择对应数据目录。插件不会替用户执行这一不可逆决定。

## Apple Beta

核心插件不需要 Apple Beta。该扩展必须从独立仓库安装，默认关闭且不进入 Community Release。启用前请阅读其 macOS 版本、Apple Silicon、未公证和本机回环限制。
