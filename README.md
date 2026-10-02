# dsh-plugin-codemode

Pi-style Code Mode (Programmatic Tool Calling) extension for **DeepSeek Harness (DSH)**.

Inspired by Pi 1.0's Code Mode, this plugin enables AI coding agents to write sandboxed JavaScript scripts to orchestrate and compose host and MCP tools in parallel, distill huge outputs inside a memory sandbox, and keep the LLM context clean.

---

## Highlights

- **Pure Memory Sandbox**: Powered by QuickJS compiled to WebAssembly (`quickjs-emscripten`). Zero OS, file-system, or network permissions inside the script environment.
- **Parallel Tool Execution**: Seamlessly run batch calls with `await Promise.all(items.map(...))` to slash round trips.
- **Context Distillation**: Raw tool payloads stay in sandbox memory. Only explicitly returned values (`return <data>`) and logs enter the conversation context, saving up to 90%+ tokens.
- **100% Rollback Guarantee**: Zero runtime patches required. Built purely as a dynamic Cordis plugin for DSH.

---

## Installation & DSH Setup

### 1. Build & Link
```bash
git clone https://github.com/Yum-wu/dsh-plugin-codemode.git
cd dsh-plugin-codemode
npm install
npm run build
```

Link into your DSH profile (`~/.dsh/profiles/web/package.json`):
```json
{
  "dependencies": {
    "dsh-plugin-codemode": "link:C:/Users/Yum/Desktop/dsh-plugin-codemode"
  }
}
```

### 2. Enable in `cordis.patch.yml`
Insert into `~/.dsh/profiles/web/cordis.patch.yml`:
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

## 3-Level Rollback Guide

1. **Level 1 (Soft Disable)**: Set `disabled: true` under `plugin-codemode` in `cordis.patch.yml`. Restart DSH.
2. **Level 2 (Runtime Fallback)**: The agent automatically falls back to native single-turn ReAct if a script throws.
3. **Level 3 (Full Removal)**: Remove the entry from `cordis.patch.yml` and `package.json`. No leftover files or runtime artifacts.

---

## License

MIT © [Yum-wu](https://github.com/Yum-wu)
