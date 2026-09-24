/** Empty provider failures must survive both streaming and history hydration. */
export function assistantFailure(message: { role?: string; stopReason?: unknown; errorMessage?: unknown }): string | null {
  if (message.role !== "assistant") return null;
  if (message.stopReason === "aborted") return "已停止生成";
  if (message.stopReason === "error") {
    return `Error: ${typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "模型请求失败"}`;
  }
  return null;
}
