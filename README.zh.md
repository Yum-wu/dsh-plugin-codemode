# dsh-plugin-codemode (中文文档)

为 **DeepSeek Harness (DSH)** 打造的 Pi 风格 Code Mode（程序化工具编排）插件。

对标 Pi 1.0 的 Code Mode 架构，本插件让大模型可以通过编写纯 JavaScript 脚本，在受控内存沙箱中并发编排调用 DSH 宿主与各类 MCP 工具，在沙箱内部完成中间数据过滤与聚合，避免巨量原始数据污染上下文。

---

## 核心特性

- **纯内存安全沙箱**：基于 WebAssembly 编译的 QuickJS (`quickjs-emscripten`)，执行环境内完全剥离 Node.js 原生文件系统、进程与网络权限。
- **批量与并发调用**：脚本内原生支持 `await Promise.all(items.map(...))`，多文件读取或批量 API 查询由 N 轮对话缩减为 1 轮搞定。
- **上下文超额提炼**：中间产物停留在 WASM 内存中，仅显式 `return` 的结构化值及 `console.log` 的提炼摘要会返回主上下文，节省高达 70%~95% 的输入 Token。
- **100% 零侵入可回滚**：纯动态 Cordis 插件设计，不需要改动任何 DSH 核心运行时代码。

---

## 安装与配置

### 1. 本地构建
```bash
git clone https://github.com/Yum-wu/dsh-plugin-codemode.git
cd dsh-plugin-codemode
npm install
npm run build
```

在 DSH profile 依赖中挂载（`~/.dsh/profiles/web/package.json`）：
```json
{
  "dependencies": {
    "dsh-plugin-codemode": "link:C:/Users/Yum/Desktop/dsh-plugin-codemode"
  }
}
```

### 2. 在 `cordis.patch.yml` 中挂载
编辑 `~/.dsh/profiles/web/cordis.patch.yml`，添加插入配置：
```yaml
- insert:
    - id: plugin-codemode
      name: 'dsh-plugin-codemode'
      config:
        toolName: 'codemode'
        maxResultChars: 50000
        timeoutMs: 60000
        injectGuidance: true
```

---

## 三级回滚阶梯

1. **Level 1（秒级软禁用 - 推荐）**：在 `cordis.patch.yml` 该条目下配置 `disabled: true`，重启 DSH 即刻恢复原有单步工具模式。
2. **Level 2（运行时双轨降级）**：脚本抛错或超时，插件自动返回错误提示，模型实时 Fallback 回常规单步调用，当前会话不中断。
3. **Level 3（物理级彻底移除）**：删除 `cordis.patch.yml` 与 `package.json` 中的配置项，彻底解耦，0 残留。

---

## 开源协议

MIT © [Yum-wu](https://github.com/Yum-wu)
