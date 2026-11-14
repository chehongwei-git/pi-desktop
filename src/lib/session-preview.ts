/** 自动摘要只取用户任务，不展示 Skill 的指令包装和机器路径；显式名称不经过此函数。 */
export function sessionPreview(text: string, limit = 100): string {
  const header = text.match(
    /^<skill name="([^"\r\n<>]+)" location="([^"\r\n<>]+)">(\r?\n)/,
  );
  if (header) {
    const newline = header[3];
    const body = text.slice(header[0].length);
    const closing = `${newline}</skill>`;
    const end = body.indexOf(closing);
    if (end >= 0) {
      const instructions = body.slice(0, end);
      const tail = body.slice(end + closing.length);
      if (
        !instructions.includes('<skill ') &&
        !instructions.includes('</skill>') &&
        (!tail || tail.startsWith(newline + newline))
      )
        text = tail.trim() || `使用 ${header[1]}`;
    } else {
      // 兼容旧恢复摘要：已截断的标准头无法还原任务，至少不继续展示路径。
      text = `使用 ${header[1]}`;
    }
  } else {
    const legacy = text.match(/^<skill name="([^"\r\n<>]+)" location="/);
    if (legacy && !text.includes('</skill>')) text = `使用 ${legacy[1]}`;
  }
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}
