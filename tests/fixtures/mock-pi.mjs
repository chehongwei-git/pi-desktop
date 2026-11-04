/** 可重复的 RPC 子进程夹具：不加载真实配置、不创建真实会话、不访问模型网络。 */
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  console.log('1.4.0');
  process.exit(0);
}
let name = 'mock';
let sessionFile = 'mock.jsonl';
let cwd = process.cwd();
let newCount = 0;
let switchCount = 0;
let streaming = false;
let pendingAbort;
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
        sessionFile,
        cwd,
        newCount,
        switchCount,
        sessionName: name,
        isStreaming: streaming,
        thinkingLevel: 'off',
        model: { provider: 'mock', id: 'model' },
      });
      break;
    case 'get_entries':
      reply(request, { entries, leafId: entries.at(-1).id });
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
    case 'compact':
      entries.push({
        id: 'compact-result',
        parentId: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: request.customInstructions }],
          stopReason: 'stop',
        },
      });
      reply(request, { summary: 'compacted' });
      break;
    case 'clone':
      reply(request, { cancelled: false });
      break;
    case 'export_html':
      reply(request, { path: request.outputPath || 'mock.html' });
      break;
    case 'get_session_stats':
      reply(request, {
        totalMessages: entries.length,
        tokens: {
          input: 50000,
          output: 10000,
          cacheRead: 40000,
          cacheWrite: 5000,
          total: 105000,
        },
        cost: 0.45,
        contextUsage: { tokens: 24600, contextWindow: 200000, percent: 12.3 },
      });
      break;
    case 'get_last_assistant_text':
      reply(request, { text: 'restored' });
      break;
    case 'get_fork_messages':
      reply(request, { messages: [{ entryId: 'u1', text: 'mock history' }] });
      break;
    case 'get_tree':
      reply(request, { tree: [], leafId: 'a1' });
      break;
    case 'fork':
      reply(request, {
        cancelled: request.entryId === 'cancel',
        text: 'mock history',
      });
      break;
    case 'get_commands':
      reply(request, {
        commands: [
          { name: 'pi-desktop-reload-v1', source: 'extension' },
          { name: 'pi-desktop-models-v1', source: 'extension' },
        ],
      });
      break;
    case 'set_session_name':
      name = request.name;
      reply(request, {});
      break;
    case 'clear_queue':
      reply(request, { steering: ['queued draft'], followUp: [] });
      break;
    case 'abort':
      if (name === 'plan-dialog') {
        pendingAbort = request;
        emit({
          type: 'extension_ui_request',
          id: 'pi-plan-choice',
          method: 'select',
          title: 'Plan mode - what next?',
          options: ['Execute', 'Stay'],
        });
        break;
      }
      streaming = false;
      reply(request, {});
      emit({ type: 'agent_settled' });
      break;
    case 'new_session':
      if (name === 'cancel-new') {
        reply(request, { cancelled: true });
        break;
      }
      if (name === 'slow-new')
        await new Promise((resolve) => setTimeout(resolve, 150));
      sessionFile = `mock-new-${++newCount}.jsonl`;
      reply(request, { cancelled: false });
      break;
    case 'switch_session':
      if (request.sessionPath === 'cancel') {
        reply(request, { cancelled: true });
        break;
      }
      sessionFile = request.sessionPath;
      switchCount++;
      try {
        cwd = JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]).cwd;
      } catch {}
      reply(request, { cancelled: false });
      break;
    case 'extension_ui_response':
      if (
        request.id === 'pi-plan-choice' &&
        pendingAbort &&
        request.cancelled
      ) {
        streaming = false;
        reply(pendingAbort, {});
        pendingAbort = undefined;
        emit({ type: 'agent_settled' });
      }
      break;
    case 'prompt':
      // 桌面展示字段不能透传给 Pi；真实 Actor 集成测试在这里验证协议边界。
      if ('textParts' in request || '_textParts' in request)
        throw new Error('desktop presentation leaked into Pi RPC');
      if (request.message.startsWith('/pi-desktop-')) {
        if (name === 'bridge-error')
          emit({
            type: 'extension_error',
            extensionPath: `command:${request.message.slice(1)}`,
            event: 'command',
            error: 'bridge refresh failed',
          });
        reply(request, { disposition: 'handled' });
        break;
      }
      reply(request, {});
      streaming = true;
      emit({ type: 'agent_start' });
      // 调度测试保持执行链，直到显式 abort，避免依赖机器速度。
      if (request.message.startsWith('hold:')) break;
      emit({
        type: 'message_end',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: request.message },
            ...(request.images ?? []),
          ],
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
