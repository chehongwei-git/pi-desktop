/** 可重复的 RPC 子进程夹具：不加载真实配置、不创建真实会话、不访问模型网络。 */
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('1.4.0');
  process.exit(0);
}
let name = 'mock';
let streaming = false;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (request, data) =>
  emit({
    type: 'response',
    id: request.id,
    command: request.type,
    success: true,
    data,
  });
const entries = [
  {
    id: 'u1',
    parentId: null,
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'mock history' }],
    },
  },
  {
    id: 'a1',
    parentId: 'u1',
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'restored' }],
      stopReason: 'stop',
    },
  },
];
/** 每个请求都有独立响应；accepted 后再输出工具/最终消息/settled，模拟真实时序。 */
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const request = JSON.parse(line);
  switch (request.type) {
    case 'get_state':
      reply(request, {
        sessionFile: 'mock.jsonl',
        sessionName: name,
        isStreaming: streaming,
        thinkingLevel: 'off',
        model: { provider: 'mock', id: 'model' },
      });
      break;
    case 'get_entries':
      reply(request, { entries, leafId: 'a1' });
      break;
    case 'get_available_models':
      reply(request, {
        models: [
          { provider: 'mock', id: 'model', name: 'Mock', reasoning: false },
        ],
      });
      break;
    case 'get_available_thinking_levels':
      reply(request, { levels: ['off'] });
      break;
    case 'get_commands':
      reply(request, { commands: [] });
      break;
    case 'set_session_name':
      name = request.name;
      reply(request, {});
      break;
    case 'clear_queue':
      reply(request, { steering: ['queued draft'], followUp: [] });
      break;
    case 'abort':
      streaming = false;
      reply(request, {});
      emit({ type: 'agent_settled' });
      break;
    case 'new_session':
    case 'switch_session':
      reply(request, { cancelled: request.sessionPath === 'cancel' });
      break;
    case 'extension_ui_response':
      break;
    case 'prompt':
      reply(request, {});
      streaming = true;
      emit({ type: 'agent_start' });
      emit({
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: request.message }],
        },
      });
      emit({
        type: 'message_start',
        message: { role: 'assistant', content: [] },
      });
      emit({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: '你好\u2028RPC',
        },
      });
      emit({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: { path: 'mock' },
      });
      emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'tool result' }] },
        isError: false,
      });
      emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '你好\u2028RPC final' }],
          stopReason: 'stop',
        },
      });
      emit({ type: 'agent_end' });
      streaming = false;
      emit({ type: 'agent_settled' });
      break;
    default:
      emit({
        type: 'response',
        id: request.id,
        command: request.type,
        success: false,
        error: 'unsupported mock command',
      });
  }
}
