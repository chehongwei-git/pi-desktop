/** 扩展使用终端主题输出颜色和链接；桌面文本只保留可见内容。 */
export function terminalText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '');
}
