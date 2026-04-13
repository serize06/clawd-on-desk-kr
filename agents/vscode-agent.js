// VS Code Agent (Copilot Chat / Agent Mode) — detection only (no hook API)
// VS Code doesn't expose hooks for agent events, so this only shows running state.

module.exports = {
  id: "vscode-agent",
  name: "VS Code Agent",
  processNames: {
    win: ["Code.exe", "Code - Insiders.exe"],
    mac: ["Code", "Code - Insiders"],
    linux: ["code", "code-insiders"],
  },
  eventSource: "process-detect",
  eventMap: {},
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: false,
    subagent: false,
  },
};
